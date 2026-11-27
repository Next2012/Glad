package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type Server struct {
	baseDir       string
	port          int
	http          *http.Server
	sessions      *SessionManager
	config        *ConfigStore
	attachments   *AttachmentStore
	schedules     *ScheduleStore
	notifications *NotificationService
	usage         *UsageService
	skillhub      *SkillHubService
	rooms         *RoomManager
	assets        fs.FS
	staticAssets  staticAssetCache
	sharing       *WorkbenchSharing
}

func NewServer(baseDir string, port int, assets fs.FS) (*Server, error) {
	config, err := OpenConfigStore()
	if err != nil {
		return nil, err
	}
	sessions := NewSessionManager(baseDir)
	// 普通 AI 页面仅接收启动入口明确传入的原 MCP 身份元数据。
	// WSS 的独立 server 不走这里，仍只使用该目标自己的配置。
	if endpoint, tokenFile := os.Getenv("GLAD_WORKBENCH_MCP_URL"), os.Getenv("GLAD_WORKBENCH_MCP_TOKEN_FILE"); endpoint != "" && tokenFile != "" {
		sessions.environment = []string{"GLAD_WORKBENCH_MCP_URL=" + endpoint, "GLAD_WORKBENCH_MCP_TOKEN_FILE=" + tokenFile}
	}
	sessions.config = config
	roomStore, err := OpenRoomStore()
	if err != nil {
		return nil, err
	}
	attachments := NewAttachmentStore()
	server := &Server{
		baseDir: baseDir, port: port, sessions: sessions, config: config,
		attachments: attachments, schedules: NewScheduleStore(config),
		usage:  NewUsageService(config),
		assets: assets,
	}
	server.rooms = NewRoomManager(roomStore, sessions, attachments)
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	cleanupAbandonedAgyProfiles(home)
	server.sessions.names = &SessionNameStore{directory: filepath.Join(home, ".glad", "session-names")}
	server.sessions.speeds, err = openSpeedStore(filepath.Join(home, ".glad", "speed"))
	if err != nil {
		return nil, err
	}
	server.sessions.antigravityUsage, err = openAntigravityUsageStore(filepath.Join(home, ".glad", "antigravity-usage"))
	if err != nil {
		return nil, err
	}
	server.usage.antigravityUsage = server.sessions.antigravityUsage
	// Old periodic Supervisor state is obsolete; native provider history is untouched.
	if err := os.RemoveAll(filepath.Join(home, ".glad", "supervisors")); err != nil {
		return nil, err
	}
	server.notifications = NewNotificationService(config, server.sessions, server.rooms)
	server.skillhub = NewSkillHubService(config, server.sessions)
	server.sharing, err = OpenWorkbenchSharing(baseDir, assets)
	if err != nil {
		return nil, err
	}
	server.sharing.globalConfig = config
	return server, nil
}

func (server *Server) Run(ctx context.Context) error {
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	mux := http.NewServeMux()
	server.registerRoutes(mux)
	server.http = &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", server.port), Handler: noCache(dynamicJSONCompression(mux)),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
	}
	listener, err := net.Listen("tcp", server.http.Addr)
	if err != nil {
		return err
	}
	server.sessions.mcpExecutable, _ = os.Executable()
	server.sessions.mcpURL = fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)
	server.usage.Start(runCtx)
	server.notifications.Start(runCtx)
	server.rooms.Start(runCtx)
	server.sharing.Start(runCtx)
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-runCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.http.Shutdown(shutdownCtx)
		server.usage.Stop()
		server.schedules.Stop()
		server.sharing.Stop(shutdownCtx)
		server.rooms.Stop()
		server.notifications.Close()
		server.sessions.Close(shutdownCtx)
	}()

	fmt.Printf("\n🚀 Glad Web Server is running!\n")
	fmt.Printf("   ➜  Local:   http://localhost:%d\n", server.port)
	for _, address := range networkAddresses() {
		fmt.Printf("   ➜  Network: http://%s:%d\n", address, server.port)
	}
	fmt.Printf("\n   ➜  Project: %s\n\n", server.baseDir)
	server.schedules.Start(runCtx, server.sessions)
	err = server.http.Serve(listener)
	cancelRun()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (server *Server) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/config", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, http.StatusOK, map[string]any{
			"defaultWorkingDirectory": server.baseDir,
			"version":                 buildVersion,
		})
	})
	mux.HandleFunc("GET /api/tools", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, http.StatusOK, detectTools(request.Context()))
	})
	mux.HandleFunc("GET /api/claude-config", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, http.StatusOK, map[string]any{"success": true, "config": claudeRuntimeConfig()})
	})
	mux.HandleFunc("GET /api/sessions", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, http.StatusOK, server.sessions.List())
	})
	mux.HandleFunc("POST /api/sessions", server.createSession)
	mux.HandleFunc("GET /api/sessions/{id}", server.getSession)
	mux.HandleFunc("GET /api/sessions/{id}/conversation", server.conversationPage)
	mux.HandleFunc("GET /api/sessions/{id}/conversation-messages/{messageId}/text", server.conversationMessageText)
	mux.HandleFunc("GET /api/sessions/{id}/output", server.sessionOutputRoute)
	mux.HandleFunc("POST /api/sessions/{id}/abort", server.abortSessionRoute)
	mux.HandleFunc("GET /api/sessions/{id}/metadata", server.sessionMetadata)
	mux.HandleFunc("POST /api/sessions/{id}/instructions", server.updateSessionInstructions)
	mux.HandleFunc("POST /api/sessions/{id}/input", server.sendSessionInput)
	mux.HandleFunc("PATCH /api/sessions/{id}", server.renameSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", server.deleteSession)
	mux.HandleFunc("GET /api/sessions/{id}/history", server.sessionHistory)
	mux.HandleFunc("GET /api/sessions/{id}/debug", server.sessionDebug)
	mux.HandleFunc("POST /api/sessions/{id}/completion/read", server.markCompletionRead)
	mux.HandleFunc("GET /api/sessions/{id}/timed-inputs", server.listTimedInputs)
	mux.HandleFunc("POST /api/sessions/{id}/timed-inputs", server.createTimedInput)
	mux.HandleFunc("PATCH /api/sessions/{id}/timed-inputs/{inputId}", server.updateTimedInput)
	mux.HandleFunc("DELETE /api/sessions/{id}/timed-inputs/{inputId}", server.deleteTimedInput)
	mux.HandleFunc("POST /api/sessions/{id}/attachments/images", server.uploadImage)
	mux.HandleFunc("POST /api/sessions/{id}/attachments/images/chunks", server.uploadImageChunk)
	mux.HandleFunc("DELETE /api/sessions/{id}/attachments/images/uploads/{uploadId}", server.deleteUpload)
	mux.HandleFunc("DELETE /api/sessions/{id}/attachments/images/{attachmentId}", server.deleteAttachment)
	mux.HandleFunc("POST /api/sessions/{id}/attachments/files/chunks", server.uploadFileChunk)
	mux.HandleFunc("DELETE /api/sessions/{id}/attachments/files/uploads/{uploadId}", server.deleteUpload)
	mux.HandleFunc("DELETE /api/sessions/{id}/attachments/files/{attachmentId}", server.deleteAttachment)
	mux.HandleFunc("GET /ws", server.websocket)
	server.registerProviderRoutes(mux)
	server.registerAntigravityRoutes(mux)
	server.registerWorkspaceRoutes(mux)
	server.registerScheduleRoutes(mux)
	server.registerNotificationRoutes(mux)
	server.registerUsageRoutes(mux)
	server.registerSkillHubRoutes(mux)
	server.registerRoomRoutes(mux)
	mux.HandleFunc("POST /api/mcp/call", server.gladMCPCall)
	mux.HandleFunc("GET /api/sessions/{id}/speed", server.sessionSpeed)
	server.registerWorkbenchSharingRoutes(mux)
	server.registerStaticRoutes(mux)
}

func (server *Server) createSession(writer http.ResponseWriter, request *http.Request) {
	var input CreateSessionRequest
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	session, err := server.sessions.Create(request.Context(), input)
	if err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"id": session.ID})
}

func (server *Server) getSession(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	if request.URL.Query().Get("history") == "tail" {
		session.mu.RLock()
		snapshot := session.conversationSnapshotLocked()
		session.mu.RUnlock()
		respondJSON(writer, http.StatusOK, snapshot)
		return
	}
	respondJSON(writer, http.StatusOK, session.snapshot())
}

func (server *Server) sessionMetadata(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	item := session.listItem()
	session.mu.RLock()
	item["threadId"] = session.State["threadId"]
	item["claudeSessionId"] = session.State["claudeSessionId"]
	item["antigravitySessionId"] = session.State["antigravitySessionId"]
	item["nativeConversationId"] = sessionNativeConversationID(session)
	item["settings"] = workbenchSessionSettings(session.State)
	session.mu.RUnlock()
	respondJSON(writer, http.StatusOK, item)
}

func (server *Server) updateSessionInstructions(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input struct {
		Instructions string `json:"instructions"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	if len(input.Instructions) > 64<<10 {
		respondError(writer, http.StatusBadRequest, errors.New("session instructions are too long"))
		return
	}
	provider, ok := session.Provider.(SessionInstructionsProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("session instructions are not supported"))
		return
	}
	if err := provider.UpdateInstructions(request.Context(), input.Instructions); err != nil {
		respondError(writer, http.StatusConflict, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) sendSessionInput(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input struct {
		Text            string `json:"text"`
		AutoStart       bool   `json:"autoStart"`
		ClientMessageID string `json:"clientMessageId"`
		Delivery        string `json:"delivery"`
		ExpectedTurnID  string `json:"expectedTurnId"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	if input.AutoStart {
		if strings.TrimSpace(input.Text) != "" || input.Delivery != "" || input.ExpectedTurnID != "" || (session.Tool.Key != "codex" && session.Tool.Key != "claude-code" && session.Tool.Key != "antigravity") {
			respondError(writer, http.StatusBadRequest, errors.New("autoStart requires a supported structured provider and no text or steering"))
			return
		}
	} else if strings.TrimSpace(input.Text) == "" || len(input.Text) > 16<<10 {
		respondError(writer, http.StatusBadRequest, errors.New("invalid message text"))
		return
	}
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	message := ProviderInput{ClientMessageID: firstNonEmpty(input.ClientMessageID, newUUID()), Text: input.Text, AgentText: input.Text, Delivery: input.Delivery, ExpectedTurnID: input.ExpectedTurnID}
	if input.AutoStart {
		message = sessionBootstrapInput(session)
		message.ClientMessageID = firstNonEmpty(input.ClientMessageID, newUUID())
	}
	if err := sendSessionControlledLocked(request.Context(), session, message); err != nil {
		respondError(writer, http.StatusConflict, err)
		return
	}
	respondJSON(writer, http.StatusAccepted, map[string]any{"success": true})
}

func (server *Server) renameSession(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	session.conversationMu.Lock()
	defer session.conversationMu.Unlock()
	name := strings.TrimSpace(input.Name)
	session.mu.Lock()
	persistID := sessionNativeConversationID(session)
	if session.forkNameSource != "" {
		persistID = ""
	}
	if err := session.names.write(session.Tool.Key, session.WorkingDirectory, persistID, sessionName{name, true}); err != nil {
		session.mu.Unlock()
		respondError(writer, 500, err)
		return
	}
	session.Name = sessionNameOrDefault(session.Tool.Key, name)
	session.NameManual = true
	session.nameRevision++
	displayName := session.Name
	session.publishLocked(map[string]any{"type": "session-renamed", "name": displayName})
	session.mu.Unlock()
	result := map[string]any{"success": true, "name": displayName}
	if provider, ok := session.Provider.(*CodexProvider); ok {
		if err := provider.titles.rename(request.Context(), name); err != nil {
			result["warning"] = "Window name saved, but Codex history name could not be synchronized: " + err.Error()
		}
	}
	respondJSON(writer, 200, result)
}

func (server *Server) deleteSession(writer http.ResponseWriter, request *http.Request) {
	if !server.sessions.Delete(request.Context(), request.PathValue("id")) {
		notFound(writer, "Session not found")
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}

func (server *Server) markCompletionRead(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	input := map[string]any{}
	if err := decodeJSON(request, &input); err != nil && !errors.Is(err, io.EOF) {
		respondError(writer, http.StatusBadRequest, errors.New("Invalid completion acknowledgement"))
		return
	}
	requestedRevision := uint64(max64(0, numberInt64(input["revision"])))
	cleared, currentRevision := session.markCompletionRead(requestedRevision)
	respondJSON(
		writer,
		200,
		map[string]any{"success": true, "cleared": cleared, "revision": currentRevision},
	)
}

func (server *Server) sessionHistory(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.RLock()
	lines := []string{}
	for _, message := range session.Messages {
		kind, text := stringValue(message["kind"]), stringValue(message["text"])
		if text == "" {
			continue
		}
		switch kind {
		case "user":
			lines = append(lines, "User: "+text)
		case "assistant":
			lines = append(lines, session.Tool.DisplayName+": "+text)
		default:
			lines = append(lines, text)
		}
	}
	name, tool := session.Name, session.Tool.DisplayName
	session.mu.RUnlock()
	text := strings.Join(lines, "\n\n")
	respondJSON(
		writer,
		200,
		map[string]any{
			"success":     true,
			"sessionId":   session.ID,
			"sessionName": name,
			"tool":        tool,
			"historyMode": "structured",
			"text":        text,
			"updatedAt":   millis(),
			"truncated":   false,
			"bytes":       len([]byte(text)),
			"lines":       len(strings.Split(text, "\n")),
		},
	)
}

func (server *Server) sessionDebug(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.RLock()
	diagnostics := map[string]any{
		"id":               session.ID,
		"kind":             session.Kind,
		"status":           session.StatusValue,
		"messages":         len(session.Messages),
		"permissions":      len(session.Permissions),
		"clients":          server.sessions.Events().SubscriberCount(session.ID),
		"workingDirectory": session.WorkingDirectory,
		"name":             session.Name,
		"nameManual":       session.NameManual,
	}
	session.mu.RUnlock()
	if provider, ok := session.Provider.(*CodexProvider); ok {
		diagnostics["automaticTitle"] = provider.titles.diagnostics()
	}
	respondJSON(writer, 200, map[string]any{"success": true, "diagnostics": diagnostics})
}

func (server *Server) websocket(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.URL.Query().Get("sessionId"))
	if session == nil {
		http.Error(writer, "Invalid Session ID", 404)
		return
	}
	connection, err := websocket.Accept(
		writer,
		request,
		&websocket.AcceptOptions{OriginPatterns: []string{request.Host}, CompressionMode: browserWSCompressionMode(request.UserAgent()), CompressionThreshold: 2 << 10},
	)
	if err != nil {
		return
	}
	connection.SetReadLimit(sessionWSReadBytes)
	tail := request.URL.Query().Get("history") == "tail"
	subscription, snapshot := session.subscribeConversation(512, tail)
	window := newConversationEventWindow(session, tail, snapshot)
	ctx, cancel := context.WithCancel(request.Context())
	commands := newSessionWSCommands()
	transport := newSessionWSTransport(session, commands, cancel)
	defer func() {
		cancel()
		commands.stop()
		subscription.Close()
		_ = connection.Close(websocket.StatusNormalClosure, "")
		transport.logClose()
	}()
	snapshotType := structuredMessageType(session.Kind, "snapshot")
	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
	snapshotBytes, err := writeSessionWSJSON(writeCtx, connection, map[string]any{"type": snapshotType, "snapshot": snapshot})
	writeCancel()
	if err != nil {
		transport.close("snapshot-write", err, snapshotBytes)
		return
	}
	outbound := make(chan map[string]any, 64)
	go func() {
		defer cancel()
		keepalive := time.NewTicker(25 * time.Second)
		defer keepalive.Stop()
		for {
			var message map[string]any
			select {
			case <-keepalive.C:
				// 代理会关闭空闲连接；定期 Ping 保持聊天与发送入口可用。
				pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
				err := connection.Ping(pingCtx)
				pingCancel()
				if err != nil {
					transport.close("ping", err, 0)
					return
				}
				continue
			case event := <-subscription.Events():
				typeName := structuredMessageType(event.Kind, "event")
				payload := window.project(event.Payload)
				if payload == nil {
					continue
				}
				message = map[string]any{"type": typeName, "event": payload}
			case message = <-outbound:
			case <-subscription.Done():
				transport.close("subscription", nil, 0)
				return
			case <-ctx.Done():
				transport.close("context", ctx.Err(), 0)
				return
			}
			messageCtx, messageCancel := context.WithTimeout(ctx, 5*time.Second)
			frameBytes, err := writeSessionWSJSON(messageCtx, connection, message)
			messageCancel()
			if err != nil {
				transport.close("write", err, frameBytes)
				return
			}
		}
	}()
	send := func(message map[string]any) bool {
		select {
		case outbound <- message:
			return true
		case <-ctx.Done():
			return false
		default:
			transport.close("queue", errWSResponseQueue, 0)
			return false
		}
	}
	go transport.runCommands(ctx, func(data []byte) {
		var payload map[string]any
		if json.Unmarshal(data, &payload) != nil {
			send(sessionWSRejected(nil, "Invalid command JSON"))
			return
		}
		server.handleWebsocketMessage(ctx, session, send, payload)
	})
	go transport.runStateRefresh(ctx, session)
	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			transport.close("read", err, len(data))
			return
		}
		if err := commands.enqueue(data); err != nil {
			transport.rejected(err, len(data))
			rejection := sessionWSRejected(data, "Connection command queue is busy; wait for the current command and try again.")
			send(rejection)
			transport.refreshControlState(stringValue(rejection["requestType"]))
		}
	}
}

func (server *Server) handleWebsocketMessage(
	connectionCtx context.Context,
	session *Session,
	send func(map[string]any) bool,
	payload map[string]any,
) {
	if stringValue(payload["type"]) == "claude-resume" {
		finishRecovery := session.beginConversationRecovery()
		defer finishRecovery()
	} else {
		session.commandMu.Lock()
		defer session.commandMu.Unlock()
	}

	if connectionCtx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(connectionCtx, 60*time.Second)
	defer cancel()
	messageType := stringValue(payload["type"])
	switch messageType {
	case "claude-input", "codex-input", "antigravity-input":
		clientMessageID := strings.TrimSpace(stringValue(payload["clientMessageId"]))
		if raw, provided := payload["clientMessageId"]; provided {
			_, stringID := raw.(string)
			if !stringID || (clientMessageID != "" && sessionWSCorrelation(clientMessageID) == "") {
				send(map[string]any{"type": "error", "commandRejected": true, "requestType": messageType, "message": "Invalid message ID"})
				return
			}
		}
		if messageType != structuredMessageType(session.Kind, "input") {
			server.writeSendResult(send, clientMessageID, sendResult{Error: "Input provider does not match this session"})
			return
		}
		for _, field := range []string{"delivery", "expectedTurnId"} {
			if value, exists := payload[field]; exists {
				if _, ok := value.(string); !ok {
					server.writeSendResult(send, clientMessageID, sendResult{Error: field + " must be a string"})
					return
				}
			}
		}
		encodedInput, _ := json.Marshal(payload)
		fingerprint := fmt.Sprintf("%x", sha256.Sum256(encodedInput))
		if clientMessageID != "" {
			session.mu.RLock()
			cached, ok := session.sendResults[clientMessageID]
			session.mu.RUnlock()
			if ok {
				if cached.Fingerprint != "" && cached.Fingerprint != fingerprint {
					server.writeSendResult(send, clientMessageID, sendResult{Error: "message ID was already used for different content"})
					return
				}
				server.writeSendResult(send, clientMessageID, cached)
				return
			}
		}
		finish := func(result sendResult) {
			result.Fingerprint = fingerprint
			if clientMessageID != "" {
				session.mu.Lock()
				if len(session.sendResults) >= 512 {
					session.sendResults = map[string]sendResult{}
				}
				session.sendResults[clientMessageID] = result
				session.mu.Unlock()
			}
			server.writeSendResult(send, clientMessageID, result)
		}
		imageIDs := uniqueStrings(stringsFromAny(payload["attachmentIds"]))
		fileIDs := uniqueStrings(stringsFromAny(payload["fileAttachmentIds"]))
		images := server.attachments.Resolve(session, imageIDs)
		files := server.attachments.Resolve(session, fileIDs)
		if len(images) != len(imageIDs) || len(files) != len(fileIDs) {
			finish(sendResult{Error: "One or more attachments are no longer available. Reattach them and try again."})
			return
		}
		text := stringValue(payload["text"])
		skills := mapsFromAny(payload["skills"])
		if strings.TrimSpace(text) == "" && len(images) == 0 && len(files) == 0 && len(skills) == 0 {
			finish(sendResult{Error: "Message text is required"})
			return
		}
		agentText := promptWithFiles(text, files)
		if messageType == "claude-input" && len(skills) > 0 {
			command := strings.TrimSpace(firstNonEmpty(stringValue(skills[0]["command"]), stringValue(skills[0]["name"])))
			if command != "" {
				if !strings.HasPrefix(command, "/") {
					command = "/" + command
				}
				agentText = strings.TrimSpace(command + " " + agentText)
			}
		}
		err := sendSessionControlledLocked(
			ctx, session,
			ProviderInput{
				ClientMessageID: clientMessageID,
				Delivery:        stringValue(payload["delivery"]),
				ExpectedTurnID:  stringValue(payload["expectedTurnId"]),
				Text:            text,
				AgentText:       agentText,
				Images:          images,
				Files:           files,
				Skills:          skills,
			},
		)
		if err != nil {
			finish(sendResult{Error: err.Error()})
			return
		}
		finish(sendResult{Accepted: true})
	case "claude-permission":
		decision := "denied"
		if boolValue(payload["approved"]) {
			decision = stringValue(payload["action"])
			if decision == "" {
				decision = "approved"
			}
		}
		if provider, ok := session.Provider.(ApprovalProvider); ok {
			_ = provider.Approve(ctx, stringValue(payload["id"]), decision, payload)
		}
	case "claude-user-input", "antigravity-user-input":
		var err error
		if provider, ok := session.Provider.(UserInputProvider); ok {
			err = provider.RespondUserInput(ctx, stringValue(payload["id"]), payload)
		} else {
			err = errors.New("provider does not support question replies")
		}
		result := map[string]any{"type": "user-input-result", "id": payload["id"], "clientMessageId": payload["clientMessageId"], "success": err == nil}
		if err != nil {
			result["error"] = err.Error()
		}
		send(result)
	case "codex-permission", "antigravity-permission":
		decision := stringValue(payload["decision"])
		if decision == "" && boolValue(payload["approved"]) {
			decision = "approved"
		}
		if provider, ok := session.Provider.(ApprovalProvider); ok {
			_ = provider.Approve(ctx, stringValue(payload["id"]), decision, payload)
		}
	case "claude-settings", "codex-settings", "antigravity-settings":
		if provider, ok := session.Provider.(SettingsProvider); ok {
			if err := provider.UpdateSettings(ctx, mapValue(payload["settings"])); err != nil {
				send(map[string]any{"type": "error", "error": err.Error(), "message": err.Error()})
			}
		}
	case "claude-abort", "codex-abort", "antigravity-abort":
		if _, ok := session.Provider.(InterruptProvider); ok {
			_ = stopSessionControlledLocked(ctx, session, stringValue(payload["expectedTurnId"]))
		}
	case "claude-resume":
		err := server.resumeClaudeConversation(ctx, session, stringValue(payload["resumeSessionId"]))
		result := map[string]any{"type": "claude-resume-result", "success": err == nil}
		if err != nil {
			result["error"] = err.Error()
		}
		send(result)
	case "codex-status", "antigravity-status":
		if provider, ok := session.Provider.(StatusProvider); ok {
			_ = provider.Status(ctx)
		}
	case "claude-status":
		if provider, ok := session.Provider.(StatusProvider); ok {
			if err := provider.Status(ctx); err != nil {
				send(map[string]any{"type": "error", "message": err.Error()})
			}
		}
	case "claude-usage":
		if provider, ok := session.Provider.(*ClaudeProvider); ok {
			_ = provider.RunLocalCommand(ctx, "/usage")
		}
	case "claude-context":
		if provider, ok := session.Provider.(*ClaudeProvider); ok {
			_ = provider.RunLocalCommand(ctx, "/context")
		}
	case "codex-compact", "antigravity-compact":
		if provider, ok := session.Provider.(CompactProvider); ok {
			_ = provider.Compact(ctx)
		}
	case "claude-compact":
		if provider, ok := session.Provider.(CompactProvider); ok {
			_ = provider.Compact(ctx)
		}
	case "codex-detail-request", "antigravity-detail-request":
		requestID := sessionWSCorrelation(payload["requestId"])
		if raw, provided := payload["requestId"]; provided && raw != "" && raw != nil && requestID == "" {
			send(map[string]any{"type": "error", "commandRejected": true, "requestType": messageType, "message": "Invalid detail request ID"})
			return
		}
		response := map[string]any{"type": structuredMessageType(session.Kind, "detail-response"), "detail": session.detail(stringsFromAny(payload["ids"]), stringValue(payload["threadId"]))}
		if requestID != "" {
			response["requestId"] = requestID
		}
		send(response)
	}
}

func (server *Server) writeSendResult(
	send func(map[string]any) bool,
	clientMessageID string,
	result sendResult,
) {
	message := map[string]any{
		"type": "send-result", "clientMessageId": clientMessageID, "accepted": result.Accepted,
	}
	if result.Error != "" {
		message["error"] = result.Error
	}
	send(message)
}

func uniqueStrings(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func (server *Server) registerStaticRoutes(mux *http.ServeMux) {
	assets := map[string]string{
		"/vendor/pdfjs/LICENSE":                        "node_modules/pdfjs-dist/LICENSE",
		"/vendor/viewerjs/viewer.min.js":               "node_modules/viewerjs/dist/viewer.min.js",
		"/vendor/viewerjs/viewer.min.css":              "node_modules/viewerjs/dist/viewer.min.css",
		"/vendor/viewerjs/LICENSE":                     "node_modules/viewerjs/LICENSE",
		"/vendor/highlight/highlight.min.js":           "node_modules/@highlightjs/cdn-assets/highlight.min.js",
		"/vendor/highlight/styles/github.min.css":      "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
		"/vendor/highlight/styles/github-dark.min.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
		"/vendor/highlight/LICENSE":                    "node_modules/@highlightjs/cdn-assets/LICENSE",
		"/vendor/xterm.js":                             "node_modules/@xterm/xterm/lib/xterm.js",
		"/vendor/xterm.css":                            "node_modules/@xterm/xterm/css/xterm.css",
		"/vendor/xterm-addon-fit.js":                   "node_modules/@xterm/addon-fit/lib/addon-fit.js",
		"/vendor/mermaid.min.js":                       "node_modules/mermaid/dist/mermaid.min.js",
		"/vendor/mermaid.LICENSE":                      "node_modules/mermaid/LICENSE",
		"/vendor/katex/katex.min.js":                   "node_modules/katex/dist/katex.min.js",
		"/vendor/katex/katex.min.css":                  "node_modules/katex/dist/katex.min.css",
		"/vendor/katex/LICENSE":                        "node_modules/katex/LICENSE",
		"/vendor/markdown-it.min.js":                   "node_modules/markdown-it/dist/browser/markdown-it.umd.min.js",
		"/vendor/markdown-it.LICENSE":                  "node_modules/markdown-it/LICENSE",
		"/vendor/markdown-it-task-lists.min.js":        "node_modules/markdown-it-task-lists/dist/markdown-it-task-lists.min.js",
		"/vendor/markdown-it-task-lists.LICENSE":       "node_modules/markdown-it-task-lists/LICENSE",
		"/vendor/markdown-it-texmath.js":               "node_modules/markdown-it-texmath/texmath.js",
		"/vendor/markdown-it-texmath.LICENSE":          "node_modules/markdown-it-texmath/license.txt",
		"/glad-app-icon.png":                           "assets/glad-app-icon.png",
		"/favicon.ico":                                 "assets/glad-app-icon.png",
	}
	for route, filename := range assets {
		filename := filename
		mux.HandleFunc(
			"GET "+route,
			func(writer http.ResponseWriter, request *http.Request) {
				server.serveStaticAsset(writer, request, filename)
			},
		)
	}
	for route, directory := range map[string]string{
		"/vendor/pdfjs/build/{name}":          "node_modules/pdfjs-dist/legacy/build/",
		"/vendor/pdfjs/cmaps/{name}":          "node_modules/pdfjs-dist/cmaps/",
		"/vendor/pdfjs/standard_fonts/{name}": "node_modules/pdfjs-dist/standard_fonts/",
		"/vendor/pdfjs/wasm/{name}":           "node_modules/pdfjs-dist/wasm/",
	} {
		directory := directory
		mux.HandleFunc("GET "+route, func(writer http.ResponseWriter, request *http.Request) {
			name := request.PathValue("name")
			if name == "." || name != path.Base(name) || strings.Contains(name, "\\") || (strings.HasSuffix(directory, "/build/") && !strings.HasSuffix(name, ".mjs")) {
				http.NotFound(writer, request)
				return
			}
			server.serveStaticAsset(writer, request, directory+name)
		})
	}
	mux.HandleFunc("GET /vendor/katex/fonts/{name}", func(writer http.ResponseWriter, request *http.Request) {
		name := request.PathValue("name")
		if name != path.Base(name) || !strings.HasSuffix(name, ".woff2") && !strings.HasSuffix(name, ".woff") && !strings.HasSuffix(name, ".ttf") {
			http.NotFound(writer, request)
			return
		}
		server.serveStaticAsset(writer, request, "node_modules/katex/dist/fonts/"+name)
	})
	mux.HandleFunc("GET /manifest.json", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(
			writer,
			200,
			map[string]any{
				"name":             "Glad Web",
				"short_name":       "Glad",
				"start_url":        ".",
				"display":          "standalone",
				"background_color": "#000000",
				"theme_color":      "#007aff",
				"icons": []map[string]any{{
					"src": "glad-app-icon.png?v=full-bleed", "sizes": "1254x1254", "type": "image/png", "purpose": "any",
				}},
			},
		)
	})
	mux.HandleFunc("GET /", server.serveRoot)
}

func (server *Server) serveRoot(writer http.ResponseWriter, request *http.Request) {
	// Keep the root WebSocket alias working for cached browser tabs while /ws is
	// the canonical endpoint used by the current frontend.
	if strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		server.websocket(writer, request)
		return
	}
	requested := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
	if requested == "." || requested == "" {
		requested = "index.html"
	}
	if strings.Contains(requested, "/") {
		requested = path.Base(requested)
	}
	filename := "lib/web/" + requested
	if _, err := fs.Stat(server.assets, filename); err != nil {
		filename = "lib/web/index.html"
	}
	server.serveStaticAsset(writer, request, filename)
}

func respondJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	writeJSON(writer, value)
}
func respondError(writer http.ResponseWriter, status int, err error) {
	respondJSON(writer, status, map[string]any{"error": err.Error()})
}
func notFound(writer http.ResponseWriter, message string) {
	respondJSON(writer, 404, map[string]any{"error": message})
}
func decodeJSON(request *http.Request, value any) error {
	defer request.Body.Close()
	return json.NewDecoder(io.LimitReader(request.Body, 64<<20)).Decode(value)
}
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
		writer.Header().Set("Pragma", "no-cache")
		next.ServeHTTP(writer, request)
	})
}
func writeWSJSON(ctx context.Context, connection *websocket.Conn, value any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return connection.Write(ctx, websocket.MessageText, bytes)
}
func networkAddresses() []string {
	addresses := []string{}
	interfaces, _ := net.Interfaces()
	for _, item := range interfaces {
		values, _ := item.Addrs()
		for _, value := range values {
			host, _, _ := net.ParseCIDR(value.String())
			if host != nil && host.To4() != nil && !host.IsLoopback() {
				addresses = append(addresses, host.String())
			}
		}
	}
	return addresses
}
func stringsFromAny(value any) []string {
	result := []string{}
	for _, item := range sliceValue(value) {
		if text := stringValue(item); text != "" {
			result = append(result, text)
		}
	}
	return result
}
func mapsFromAny(value any) []map[string]any {
	result := []map[string]any{}
	for _, item := range sliceValue(value) {
		if row, ok := item.(map[string]any); ok {
			result = append(result, row)
		}
	}
	return result
}
func boolValue(value any) bool { result, _ := value.(bool); return result }
func promptWithFiles(text string, files []Attachment) string {
	if len(files) == 0 {
		return strings.TrimSpace(text)
	}
	lines := []string{"The user attached the following local files. Read them if relevant to the request:"}
	for _, file := range files {
		lines = append(lines, "- "+file.Name+": "+file.Path)
	}
	if strings.TrimSpace(text) == "" {
		return strings.Join(lines, "\n")
	}
	return strings.TrimSpace(text) + "\n\n" + strings.Join(lines, "\n")
}

var _ = log.Printf
var _ = os.ErrNotExist
