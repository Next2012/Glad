package app

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

func (server *Server) registerRoomRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms", server.listRooms)
	mux.HandleFunc("GET /ws/rooms", server.roomWebsocket)
	mux.HandleFunc("POST /api/rooms/{id}/abort", server.abortRoom)
	mux.HandleFunc("POST /api/rooms/{id}/completion/read", server.markRoomRead)
	mux.HandleFunc("GET /api/rooms/{id}/timed-inputs", server.roomTimedInputs)
	mux.HandleFunc("POST /api/rooms/{id}/timed-inputs", server.roomTimedInputs)
	mux.HandleFunc("PATCH /api/rooms/{id}/timed-inputs/{inputId}", server.roomTimedInputs)
	mux.HandleFunc("DELETE /api/rooms/{id}/timed-inputs/{inputId}", server.roomTimedInputs)
	mux.HandleFunc("GET /api/room-history", server.listRoomHistory)
	mux.HandleFunc("GET /api/room-history/{id}", server.getRoomHistory)
	mux.HandleFunc("GET /api/room-history/{id}/operation-status", server.roomOperationStatus)
	mux.HandleFunc("POST /api/rooms", server.createRoom)
	mux.HandleFunc("GET /api/rooms/{id}", server.getRoom)
	mux.HandleFunc("PATCH /api/rooms/{id}", server.renameRoom)
	mux.HandleFunc("DELETE /api/rooms/{id}", server.deleteRoom)
	mux.HandleFunc("DELETE /api/rooms/{id}/draft", server.deleteRoomDraft)
	mux.HandleFunc("POST /api/rooms/{id}/members", server.addRoomMember)
	mux.HandleFunc("DELETE /api/rooms/{id}/members/{memberId}", server.removeRoomMember)
	mux.HandleFunc("POST /api/rooms/{id}/messages", server.postRoomMessage)
	mux.HandleFunc("GET /api/rooms/{id}/entries/{entryId}/context", server.roomEntryContext)
	mux.HandleFunc("GET /api/rooms/{id}/entries/{entryId}/turns/{turnId}/details", server.roomEntryTurnDetails)
	mux.HandleFunc("GET /api/rooms/{id}/operation-status", server.roomOperationStatus)
	mux.HandleFunc("POST /api/rooms/{id}/resume", server.resumeRoom)
	mux.HandleFunc("POST /api/rooms/{id}/fork", server.forkRoom)
}

func (server *Server) deleteRoomDraft(writer http.ResponseWriter, request *http.Request) {
	if err := server.rooms.DeleteDraft(request.PathValue("id")); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) roomEntryContext(writer http.ResponseWriter, request *http.Request) {
	before, _ := strconv.Atoi(request.URL.Query().Get("before"))
	after, _ := strconv.Atoi(request.URL.Query().Get("after"))
	if before <= 0 {
		before = 3
	}
	if after <= 0 {
		after = 3
	}
	context, err := server.rooms.EntryContext(request.PathValue("id"), request.PathValue("entryId"), before, after)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, context)
}

func (server *Server) roomEntryTurnDetails(writer http.ResponseWriter, request *http.Request) {
	details, err := server.rooms.EntryTurnDetails(
		request.PathValue("id"), request.PathValue("entryId"), request.PathValue("turnId"),
	)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, details)
}

func (server *Server) renameRoom(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	if err := server.rooms.Rename(request.PathValue("id"), input.Name); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "name": strings.TrimSpace(input.Name)})
}

type roomOperationRequest struct {
	SourceRoomID      string   `json:"sourceRoomId"`
	ExcludedMemberIDs []string `json:"excludedMemberIds"`
}

func (server *Server) roomOperationStatus(writer http.ResponseWriter, request *http.Request) {
	getRecord := server.rooms.GetRecord
	if strings.HasPrefix(request.URL.Path, "/api/room-history/") {
		getRecord = server.rooms.GetHistoryRecord
	}
	room, err := getRecord(request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	items := []map[string]any{}
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		live := server.sessions.Get(member.RuntimeSessionID) != nil
		reason := ""
		if member.NativeConversationID == "" && !live {
			reason = "No provider conversation is available"
		}
		items = append(items, map[string]any{
			"memberId": member.ID, "displayName": member.DisplayName,
			"toolKey": member.ToolKey, "live": live,
			"canResume": live || member.NativeConversationID != "",
			"canFork":   member.NativeConversationID != "", "reason": reason,
		})
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "members": items})
}

func (server *Server) resumeRoom(writer http.ResponseWriter, request *http.Request) {
	runtimeID := request.PathValue("id")
	unlock := server.rooms.lockOperation(runtimeID)
	defer unlock()
	if !server.rooms.IsActive(runtimeID) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	if server.rooms.Busy(runtimeID) {
		server.writeRoomError(writer, errors.New("group is busy"))
		return
	}
	var input roomOperationRequest
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	room, err := server.roomOperationSource(runtimeID, input.SourceRoomID)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	excluded := stringSet(input.ExcludedMemberIDs)
	unavailable := roomUnavailableMembers(room, excluded, false, server.sessions)
	if len(unavailable) > 0 {
		respondJSON(writer, http.StatusConflict, map[string]any{
			"success": false, "error": "Some sessions cannot be resumed", "unavailableMembers": unavailable,
		})
		return
	}
	operationCtx, endOperation, err := server.rooms.beginLifecycle(request.Context(), runtimeID, "resume")
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	defer endOperation()
	results := []map[string]any{}
	var resultsMu sync.Mutex
	var wait sync.WaitGroup
	limit := make(chan struct{}, 3)
	for _, member := range room.Members {
		if member.LeftAt != 0 || excluded[member.ID] || server.sessions.Get(member.RuntimeSessionID) != nil {
			continue
		}
		member := member
		wait.Add(1)
		go func() {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			result := map[string]any{"memberId": member.ID}
			session, err := server.recreateRoomMember(operationCtx, member, false, runtimeID)
			if err != nil {
				result["success"], result["error"] = false, err.Error()
			} else {
				conversationID := sessionConversationID(session)
				if err := server.rooms.BindRuntimeSession(room.ID, member.ID, session.ID, conversationID); err != nil {
					server.sessions.Delete(context.Background(), session.ID)
					result["success"], result["error"] = false, err.Error()
				} else {
					result["success"], result["sessionId"] = true, session.ID
				}
			}
			resultsMu.Lock()
			results = append(results, result)
			resultsMu.Unlock()
		}()
	}
	wait.Wait()
	if operationCtx.Err() != nil {
		for _, result := range results {
			if id := stringValue(result["sessionId"]); id != "" {
				server.sessions.Delete(context.Background(), id)
			}
		}
		respondJSON(writer, http.StatusConflict, map[string]any{"success": false, "error": "Group recovery stopped", "results": results})
		return
	}
	if len(results) > 0 {
		succeeded := false
		for _, result := range results {
			if boolValue(result["success"]) {
				succeeded = true
			}
		}
		if !succeeded {
			respondJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "No member sessions could be restored", "results": results})
			return
		}
	}
	if err := server.rooms.SwitchHistory(runtimeID, room.ID); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "results": results})
}

func (server *Server) forkRoom(writer http.ResponseWriter, request *http.Request) {
	runtimeID := request.PathValue("id")
	unlock := server.rooms.lockOperation(runtimeID)
	defer unlock()
	if !server.rooms.IsActive(runtimeID) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	if server.rooms.Busy(runtimeID) {
		server.writeRoomError(writer, errors.New("group is busy"))
		return
	}
	var input roomOperationRequest
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	source, err := server.roomOperationSource(runtimeID, input.SourceRoomID)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	excluded := stringSet(input.ExcludedMemberIDs)
	unavailable := roomUnavailableMembers(source, excluded, true, server.sessions)
	if len(unavailable) > 0 {
		respondJSON(writer, http.StatusConflict, map[string]any{
			"success": false, "error": "Some sessions cannot be forked", "unavailableMembers": unavailable,
		})
		return
	}
	forked, err := server.rooms.CopyHistory(source.ID)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	operationCtx, endOperation, err := server.rooms.beginLifecycle(request.Context(), runtimeID, "fork")
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	defer endOperation()
	results := []map[string]any{}
	var resultsMu sync.Mutex
	var wait sync.WaitGroup
	limit := make(chan struct{}, 3)
	for _, member := range source.Members {
		if member.LeftAt != 0 || excluded[member.ID] {
			continue
		}
		member := member
		wait.Add(1)
		go func() {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			result := map[string]any{"memberId": member.ID}
			session, err := server.recreateRoomMember(operationCtx, member, true, runtimeID)
			if err != nil {
				result["success"], result["error"] = false, err.Error()
			} else {
				conversationID := sessionConversationID(session)
				if err := server.rooms.BindRuntimeSession(forked.ID, member.ID, session.ID, conversationID); err != nil {
					server.sessions.Delete(context.Background(), session.ID)
					result["success"], result["error"] = false, err.Error()
				} else {
					result["success"], result["sessionId"] = true, session.ID
					result["nativeConversationId"] = conversationID
				}
			}
			resultsMu.Lock()
			results = append(results, result)
			resultsMu.Unlock()
		}()
	}
	wait.Wait()
	if operationCtx.Err() != nil {
		for _, result := range results {
			if id := stringValue(result["sessionId"]); id != "" {
				server.sessions.Delete(context.Background(), id)
			}
		}
		_ = server.rooms.Delete(forked.ID)
		respondJSON(writer, http.StatusConflict, map[string]any{"success": false, "error": "Group recovery stopped", "results": results})
		return
	}
	if len(results) > 0 {
		succeeded := false
		for _, result := range results {
			if boolValue(result["success"]) {
				succeeded = true
			}
		}
		if !succeeded {
			_ = server.rooms.Delete(forked.ID)
			respondJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "No member sessions could be restored", "results": results})
			return
		}
	}
	if err := server.rooms.SwitchHistory(runtimeID, forked.ID); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "id": runtimeID, "historyId": forked.ID, "name": source.Name, "results": results})
}

func (server *Server) roomOperationSource(runtimeID, sourceID string) (RoomRecord, error) {
	if sourceID != "" {
		return server.rooms.GetHistoryRecord(sourceID)
	}
	return server.rooms.GetRecord(runtimeID)
}

func (server *Server) recreateRoomMember(ctx context.Context, member RoomMemberRecord, fork bool, runtimeID string) (*Session, error) {
	var sourceMessages []map[string]any
	if fork && member.ToolKey == "codex" {
		if source := server.sessions.Get(member.RuntimeSessionID); source != nil {
			source.mu.RLock()
			for _, message := range source.Messages {
				sourceMessages = append(sourceMessages, cloneMap(message))
			}
			source.mu.RUnlock()
		} else {
			// Fork responses can omit copied turns. Seed the independent
			// destination from source history, as single-session Fork does.
			sourceMessages, _ = readCodexTranscriptFile(member.NativeConversationID)
		}
	}
	request := CreateSessionRequest{
		ToolKey: member.ToolKey, WorkingDirectory: member.WorkingDirectory,
		Name: member.DisplayName,
	}
	if member.ToolKey == "codex" {
		request.CodexOptions = cloneMap(member.SessionOptions)
	} else {
		request.ClaudeOptions = cloneMap(member.SessionOptions)
	}
	session, err := server.sessions.Create(ctx, request)
	if err != nil {
		return nil, err
	}
	server.rooms.trackOperationSession(runtimeID, session.ID)
	cleanup := func(err error) (*Session, error) {
		server.sessions.Delete(context.Background(), session.ID)
		return nil, err
	}
	if fork {
		provider, ok := session.Provider.(ForkProvider)
		if !ok {
			return cleanup(errors.New("provider fork is not supported"))
		}
		if member.ToolKey == "claude-code" {
			messages, historyErr := readClaudeTranscriptFile(member.WorkingDirectory, member.NativeConversationID)
			if historyErr != nil {
				return cleanup(errors.New("Claude conversation history is unavailable"))
			}
			if _, err := provider.Fork(ctx, member.NativeConversationID); err != nil {
				return cleanup(err)
			}
			session.replaceClaudeConversation(messages)
		} else {
			if len(sourceMessages) > 0 {
				session.replaceMessages(sourceMessages)
			}
			if _, err := provider.Fork(ctx, member.NativeConversationID); err != nil {
				return cleanup(err)
			}
		}
		return session, nil
	}
	provider, ok := session.Provider.(ResumeProvider)
	if !ok {
		return cleanup(errors.New("provider resume is not supported"))
	}
	if member.ToolKey == "claude-code" {
		messages, historyErr := readClaudeTranscriptFile(member.WorkingDirectory, member.NativeConversationID)
		if historyErr != nil {
			return cleanup(errors.New("Claude conversation history is unavailable"))
		}
		if err := provider.Resume(ctx, member.NativeConversationID); err != nil {
			return cleanup(err)
		}
		session.replaceClaudeConversation(messages)
	} else if err := provider.Resume(ctx, member.NativeConversationID); err != nil {
		return cleanup(err)
	}
	return session, nil
}

func sessionConversationID(session *Session) string {
	session.mu.RLock()
	id := sessionNativeConversationID(session)
	session.mu.RUnlock()
	if id != "" {
		return id
	}
	if provider, ok := session.Provider.(*CodexProvider); ok {
		provider.mu.Lock()
		id = provider.threadID
		provider.mu.Unlock()
	}
	return id
}

func roomUnavailableMembers(room RoomRecord, excluded map[string]bool, fork bool, sessions *SessionManager) []map[string]any {
	items := []map[string]any{}
	for _, member := range room.Members {
		if member.LeftAt != 0 || excluded[member.ID] {
			continue
		}
		available := member.NativeConversationID != ""
		if !fork && sessions.Get(member.RuntimeSessionID) != nil {
			available = true
		}
		if !available {
			items = append(items, map[string]any{
				"memberId": member.ID, "displayName": member.DisplayName,
				"reason": "No provider conversation is available",
			})
		}
	}
	return items
}

func stringSet(values []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range uniqueStrings(values) {
		result[value] = true
	}
	return result
}

func (server *Server) listRooms(writer http.ResponseWriter, _ *http.Request) {
	rooms, err := server.rooms.List()
	if err != nil {
		respondError(writer, http.StatusInternalServerError, err)
		return
	}
	respondJSON(writer, http.StatusOK, rooms)
}

func (server *Server) listRoomHistory(writer http.ResponseWriter, request *http.Request) {
	offset, _ := strconv.Atoi(request.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	page, err := server.rooms.HistoryPage(request.URL.Query().Get("sort"), request.URL.Query().Get("q"), offset, limit)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, page)
}

func (server *Server) createRoom(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	room, err := server.rooms.Create(input.Name)
	if err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	respondJSON(writer, http.StatusCreated, map[string]any{"id": room.ID, "name": room.Name})
}

func (server *Server) getRoom(writer http.ResponseWriter, request *http.Request) {
	if !server.rooms.IsActive(request.PathValue("id")) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	room, err := server.rooms.GetPublic(request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, room)
}

func (server *Server) getRoomHistory(writer http.ResponseWriter, request *http.Request) {
	room, err := server.rooms.GetHistoryPublic(request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, room)
}

func (server *Server) deleteRoom(writer http.ResponseWriter, request *http.Request) {
	unlock := server.rooms.lockOperation(request.PathValue("id"))
	defer unlock()
	if err := server.rooms.Close(request.PathValue("id")); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) addRoomMember(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		SessionID string `json:"sessionId"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	member, err := server.rooms.AddSession(request.PathValue("id"), input.SessionID)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusCreated, map[string]any{
		"success": true, "memberId": member.ID, "sessionId": member.RuntimeSessionID,
	})
}

func (server *Server) removeRoomMember(writer http.ResponseWriter, request *http.Request) {
	if err := server.rooms.RemoveMember(request.PathValue("id"), request.PathValue("memberId")); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) postRoomMessage(writer http.ResponseWriter, request *http.Request) {
	unlock := server.rooms.lockOperation(request.PathValue("id"))
	defer unlock()
	if !server.rooms.IsActive(request.PathValue("id")) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	var input RoomMessageInput
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := roomContext(90 * time.Second)
	defer cancel()
	room, err := server.rooms.PostMessage(ctx, request.PathValue("id"), input)
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	if failure := server.rooms.RequestDispatchFailure(request.PathValue("id"), input.ClientMessageID); failure != "" {
		respondJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "accepted": false, "clientMessageId": input.ClientMessageID, "room": room, "error": failure})
		return
	}
	respondJSON(writer, http.StatusAccepted, map[string]any{"success": true, "accepted": true, "clientMessageId": input.ClientMessageID, "room": room})
}

func (server *Server) writeRoomError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, errRoomNotFound) {
		status = http.StatusNotFound
	} else if errors.Is(err, errRoomSchemaTooNew) {
		status = http.StatusConflict
	} else if strings.Contains(strings.ToLower(err.Error()), "already") {
		status = http.StatusConflict
	}
	respondError(writer, status, err)
}

func (server *Server) abortRoom(writer http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	results, err := server.rooms.Abort(ctx, request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "results": results})
}

func (server *Server) markRoomRead(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Revision uint64 `json:"revision"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	if err := server.rooms.MarkRead(request.PathValue("id"), input.Revision); err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
