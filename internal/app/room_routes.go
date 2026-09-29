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
	ExcludedMemberIDs []string `json:"excludedMemberIds"`
}

func (server *Server) roomOperationStatus(writer http.ResponseWriter, request *http.Request) {
	room, err := server.rooms.GetRecord(request.PathValue("id"))
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
	var input roomOperationRequest
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	room, err := server.rooms.GetRecord(request.PathValue("id"))
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
			session, err := server.recreateRoomMember(request.Context(), member, false)
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
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "results": results})
}

func (server *Server) forkRoom(writer http.ResponseWriter, request *http.Request) {
	var input roomOperationRequest
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	source, err := server.rooms.GetRecord(request.PathValue("id"))
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
			session, err := server.forkRoomMember(request.Context(), member)
			if err != nil {
				result["success"], result["error"] = false, err.Error()
			} else {
				conversationID := sessionConversationID(session)
				if err := server.rooms.BindRuntimeSession(source.ID, member.ID, session.ID, conversationID); err != nil {
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
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "id": source.ID, "name": source.Name, "results": results})
}

func (server *Server) forkRoomMember(ctx context.Context, member RoomMemberRecord) (*Session, error) {
	session := server.sessions.Get(member.RuntimeSessionID)
	if session == nil {
		return server.recreateRoomMember(ctx, member, true)
	}
	provider, ok := session.Provider.(ForkProvider)
	if !ok {
		return nil, errors.New("provider fork is not supported")
	}
	if member.ToolKey == "claude-code" {
		messages, historyErr := readClaudeTranscriptFile(member.WorkingDirectory, member.NativeConversationID)
		if historyErr != nil {
			return nil, errors.New("Claude conversation history is unavailable")
		}
		if _, err := provider.Fork(ctx, member.NativeConversationID); err != nil {
			return nil, err
		}
		session.replaceClaudeConversation(messages)
		return session, nil
	}
	if _, err := provider.Fork(ctx, member.NativeConversationID); err != nil {
		return nil, err
	}
	return session, nil
}

func (server *Server) recreateRoomMember(ctx context.Context, member RoomMemberRecord, fork bool) (*Session, error) {
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
		} else if _, err := provider.Fork(ctx, member.NativeConversationID); err != nil {
			return cleanup(err)
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
	room, err := server.rooms.GetPublic(request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	respondJSON(writer, http.StatusOK, room)
}

func (server *Server) deleteRoom(writer http.ResponseWriter, request *http.Request) {
	if err := server.rooms.Delete(request.PathValue("id")); err != nil {
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
	respondJSON(writer, http.StatusAccepted, map[string]any{"success": true, "room": room})
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
