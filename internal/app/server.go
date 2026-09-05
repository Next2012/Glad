package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
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
	assets        fs.FS
}

func NewServer(baseDir string, port int, assets fs.FS) (*Server, error) {
	config, err := OpenConfigStore()
	if err != nil {
		return nil, err
	}
	server := &Server{
		baseDir: baseDir, port: port, sessions: NewSessionManager(baseDir), config: config,
		attachments: NewAttachmentStore(), schedules: NewScheduleStore(config),
		usage:  NewUsageService(),
		assets: assets,
	}
	server.notifications = NewNotificationService(config, server.sessions)
	server.skillhub = NewSkillHubService(config, server.sessions)
	return server, nil
}

func (server *Server) Run(ctx context.Context) error {
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	mux := http.NewServeMux()
	server.registerRoutes(mux)
	server.http = &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", server.port), Handler: noCache(mux),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
	}
	listener, err := net.Listen("tcp", server.http.Addr)
	if err != nil {
		return err
	}
	server.notifications.Start(runCtx)
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-runCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.http.Shutdown(shutdownCtx)
		server.schedules.Stop()
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
	server.registerWorkspaceRoutes(mux)
	server.registerScheduleRoutes(mux)
	server.registerNotificationRoutes(mux)
	server.registerUsageRoutes(mux)
	server.registerSkillHubRoutes(mux)
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
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = session.Tool.DisplayName
	}
	session.mu.Lock()
	session.Name = name
	session.NameManual = true
	session.publishLocked(map[string]any{"type": "session-renamed", "name": name})
	session.mu.Unlock()
	result := map[string]any{"success": true, "name": name}
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
	session.mu.Lock()
	session.HasUnreadCompletion = false
	session.mu.Unlock()
	respondJSON(writer, 200, map[string]any{"success": true})
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
		&websocket.AcceptOptions{OriginPatterns: []string{request.Host}},
	)
	if err != nil {
		return
	}
	subscription, snapshot := session.subscribeWithSnapshot(512)
	ctx, cancel := context.WithCancel(request.Context())
	defer func() {
		cancel()
		subscription.Close()
		_ = connection.Close(websocket.StatusNormalClosure, "")
	}()
	snapshotType := "claude-snapshot"
	if session.Kind == "codex-structured" {
		snapshotType = "codex-snapshot"
	}
	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
	err = writeWSJSON(writeCtx, connection, map[string]any{"type": snapshotType, "snapshot": snapshot})
	writeCancel()
	if err != nil {
		return
	}
	outbound := make(chan map[string]any, 64)
	go func() {
		defer cancel()
		for {
			var message map[string]any
			select {
			case event := <-subscription.Events():
				typeName := "claude-event"
				if event.Kind == "codex-structured" {
					typeName = "codex-event"
				}
				message = map[string]any{"type": typeName, "event": event.Payload}
			case message = <-outbound:
			case <-subscription.Done():
				return
			case <-ctx.Done():
				return
			}
			messageCtx, messageCancel := context.WithTimeout(ctx, 5*time.Second)
			err := writeWSJSON(messageCtx, connection, message)
			messageCancel()
			if err != nil {
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
			cancel()
			return false
		}
	}
	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			return
		}
		var payload map[string]any
		if json.Unmarshal(data, &payload) != nil {
			continue
		}
		server.handleWebsocketMessage(ctx, session, send, payload)
	}
}

func (server *Server) handleWebsocketMessage(
	connectionCtx context.Context,
	session *Session,
	send func(map[string]any) bool,
	payload map[string]any,
) {
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	if connectionCtx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(connectionCtx, 60*time.Second)
	defer cancel()
	messageType := stringValue(payload["type"])
	switch messageType {
	case "claude-input", "codex-input":
		clientMessageID := strings.TrimSpace(stringValue(payload["clientMessageId"]))
		if clientMessageID != "" {
			session.mu.RLock()
			cached, ok := session.sendResults[clientMessageID]
			session.mu.RUnlock()
			if ok {
				server.writeSendResult(send, clientMessageID, cached)
				return
			}
		}
		finish := func(result sendResult) {
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
		if len(clientMessageID) > 128 {
			finish(sendResult{Error: "Invalid message ID"})
			return
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
		err := session.Provider.Send(
			ctx,
			ProviderInput{
				ClientMessageID: clientMessageID,
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
	case "codex-permission":
		decision := stringValue(payload["decision"])
		if decision == "" && boolValue(payload["approved"]) {
			decision = "approved"
		}
		if provider, ok := session.Provider.(ApprovalProvider); ok {
			_ = provider.Approve(ctx, stringValue(payload["id"]), decision, payload)
		}
	case "claude-settings", "codex-settings":
		if provider, ok := session.Provider.(SettingsProvider); ok {
			_ = provider.UpdateSettings(ctx, mapValue(payload["settings"]))
		}
	case "claude-abort", "codex-abort":
		if provider, ok := session.Provider.(InterruptProvider); ok {
			_ = provider.Interrupt(ctx)
		}
	case "claude-resume":
		if provider, ok := session.Provider.(ResumeProvider); ok {
			_ = provider.Resume(ctx, stringValue(payload["resumeSessionId"]))
		}
	case "codex-status":
		if provider, ok := session.Provider.(StatusProvider); ok {
			_ = provider.Status(ctx)
		}
	case "claude-usage":
		if provider, ok := session.Provider.(*ClaudeProvider); ok {
			_ = provider.RunLocalCommand(ctx, "/usage")
		}
	case "claude-context":
		if provider, ok := session.Provider.(*ClaudeProvider); ok {
			_ = provider.RunLocalCommand(ctx, "/context")
		}
	case "codex-compact":
		if provider, ok := session.Provider.(CompactProvider); ok {
			_ = provider.Compact(ctx)
		}
	case "codex-detail-request":
		send(
			map[string]any{
				"type":      "codex-detail-response",
				"requestId": payload["requestId"],
				"detail":    session.detail(stringsFromAny(payload["ids"]), stringValue(payload["threadId"])),
			},
		)
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
		"/vendor/xterm.js":           "node_modules/@xterm/xterm/lib/xterm.js",
		"/vendor/xterm.css":          "node_modules/@xterm/xterm/css/xterm.css",
		"/vendor/xterm-addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
		"/logo.svg":                  "assets/logo.svg", "/favicon.ico": "assets/logo.svg",
	}
	for route, filename := range assets {
		filename := filename
		mux.HandleFunc(
			"GET "+route,
			func(writer http.ResponseWriter, request *http.Request) { server.serveEmbedded(writer, filename) },
		)
	}
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
				"icons":            []map[string]any{{"src": "logo.svg", "sizes": "any", "type": "image/svg+xml"}},
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
	server.serveEmbedded(writer, filename)
}

func (server *Server) serveEmbedded(writer http.ResponseWriter, filename string) {
	bytes, err := fs.ReadFile(server.assets, filename)
	if err != nil {
		http.NotFound(writer, nil)
		return
	}
	if contentType := mime.TypeByExtension(filepath.Ext(filename)); contentType != "" {
		writer.Header().Set("Content-Type", contentType)
	}
	writer.WriteHeader(200)
	_, _ = writer.Write(bytes)
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
