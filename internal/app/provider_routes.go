package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (server *Server) registerProviderRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{id}/claude-resume-sessions", server.claudeResumeSessions)
	mux.HandleFunc("GET /api/sessions/{id}/claude-session-preview", server.claudeSessionPreview)
	mux.HandleFunc("PATCH /api/sessions/{id}/claude-settings", server.providerSettings)
	mux.HandleFunc("POST /api/sessions/{id}/claude-abort", server.providerAbort)
	mux.HandleFunc("POST /api/sessions/{id}/claude-resume", server.claudeResume)
	mux.HandleFunc("POST /api/sessions/{id}/claude-fork", server.claudeFork)
	mux.HandleFunc("PATCH /api/sessions/{id}/codex-settings", server.providerSettings)
	mux.HandleFunc("POST /api/sessions/{id}/codex-global-defaults", server.codexGlobalDefaults)
	mux.HandleFunc("GET /api/sessions/{id}/codex-resume-threads", server.codexResumeThreads)
	mux.HandleFunc("GET /api/sessions/{id}/codex-thread-preview", server.codexThreadPreview)
	mux.HandleFunc("GET /api/sessions/{id}/codex-prompts", server.codexPrompts)
	mux.HandleFunc("GET /api/sessions/{id}/codex-skills", server.codexSkills)
	mux.HandleFunc("POST /api/sessions/{id}/codex-abort", server.providerAbort)
	mux.HandleFunc("POST /api/sessions/{id}/codex-user-input", server.codexUserInput)
	mux.HandleFunc("POST /api/sessions/{id}/codex-resume", server.codexResume)
	mux.HandleFunc("POST /api/sessions/{id}/codex-fork", server.codexFork)
	mux.HandleFunc("POST /api/debug/client-log", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, 200, map[string]any{"success": true})
	})
}

func (server *Server) codexGlobalDefaults(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "codex-structured" {
		notFound(writer, "Codex session not found")
		return
	}
	provider, ok := session.Provider.(CodexGlobalSettingsProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Codex global settings are not supported"))
		return
	}
	settings, err := provider.WriteGlobalDefaults(request.Context())
	if err != nil {
		respondError(writer, http.StatusBadRequest, err)
		return
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "settings": settings})
}

func (server *Server) providerSettings(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var settings map[string]any
	if err := decodeJSON(request, &settings); err != nil {
		respondError(writer, 400, err)
		return
	}
	provider, ok := session.Provider.(SettingsProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Provider settings are not supported"))
		return
	}
	if err := provider.UpdateSettings(request.Context(), settings); err != nil {
		respondError(writer, 400, err)
		return
	}
	session.mu.RLock()
	state := cloneMap(session.State)
	session.mu.RUnlock()
	respondJSON(writer, 200, map[string]any{"success": true, "state": state})
}
func (server *Server) providerAbort(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	provider, ok := session.Provider.(InterruptProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Provider interruption is not supported"))
		return
	}
	if err := provider.Interrupt(request.Context()); err != nil {
		respondError(writer, 409, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
func (server *Server) claudeResume(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "claude-structured" {
		notFound(writer, "Claude session not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(request, &input)
	id := stringValue(input["resumeSessionId"])
	if id == "" {
		respondError(writer, 400, errors.New("Missing resumeSessionId"))
		return
	}
	if err := server.resumeClaudeConversation(request.Context(), session, id); err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "claudeSessionId": id})
}

func (server *Server) resumeClaudeConversation(ctx context.Context, session *Session, id string) error {
	id = strings.TrimSpace(id)
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(id) {
		return errors.New("invalid Claude session id")
	}
	messages, err := readClaudeTranscriptFile(session.WorkingDirectory, id)
	if err != nil {
		return errors.New("Claude conversation history is unavailable")
	}
	provider, ok := session.Provider.(ResumeProvider)
	if !ok {
		return errors.New("Provider resume is not supported")
	}
	if err := provider.Resume(ctx, id); err != nil {
		return err
	}
	if !session.replaceClaudeConversation(messages) {
		return errors.New("Claude session is closed")
	}
	session.appendMessage(map[string]any{"kind": "event", "level": "info", "text": "Resumed Claude conversation"})
	return nil
}
func (server *Server) claudeFork(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "claude-structured" {
		notFound(writer, "Claude session not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(request, &input)
	source := firstNonEmpty(stringValue(input["claudeSessionId"]), stringValue(session.State["claudeSessionId"]))
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(source) {
		respondError(writer, http.StatusBadRequest, errors.New("invalid Claude session id"))
		return
	}
	messages, historyErr := readClaudeTranscriptFile(session.WorkingDirectory, source)
	if historyErr != nil {
		respondError(writer, http.StatusBadRequest, errors.New("Claude conversation history is unavailable"))
		return
	}
	provider, ok := session.Provider.(ForkProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Provider fork is not supported"))
		return
	}
	id, err := provider.Fork(request.Context(), source)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	if !session.replaceClaudeConversation(messages) {
		respondError(writer, http.StatusConflict, errors.New("Claude session is closed"))
		return
	}
	session.appendMessage(
		map[string]any{"kind": "event", "level": "info", "text": "Forked from Claude session " + source},
	)
	respondJSON(
		writer,
		200,
		map[string]any{"success": true, "id": session.ID, "name": session.Name, "claudeSessionId": id},
	)
}
func (server *Server) claudeResumeSessions(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "claude-structured" {
		notFound(writer, "Claude session not found")
		return
	}
	query := request.URL.Query()
	items, nextOffset := listClaudeTranscriptPage(
		session.WorkingDirectory, query.Get("sort"),
		atoiDefault(query.Get("offset"), 0), atoiDefault(query.Get("limit"), 20),
	)
	respondJSON(writer, 200, map[string]any{"success": true, "items": items, "nextOffset": nextOffset, "hasMore": nextOffset >= 0})
}

func (server *Server) claudeSessionPreview(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "claude-structured" {
		notFound(writer, "Claude session not found")
		return
	}
	id := strings.TrimSpace(request.URL.Query().Get("sessionId"))
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(id) {
		respondError(writer, http.StatusBadRequest, errors.New("invalid Claude session id"))
		return
	}
	messages, err := readClaudeTranscriptFile(session.WorkingDirectory, id)
	if err != nil {
		respondError(writer, http.StatusNotFound, errors.New("Claude conversation history is unavailable"))
		return
	}
	preview := make([]map[string]any, 0, 6)
	for _, message := range messages {
		kind := stringValue(message["kind"])
		if kind != "user" && kind != "assistant" {
			continue
		}
		text := stringValue(message["text"])
		if text == "" {
			continue
		}
		preview = append(preview, map[string]any{"kind": kind, "text": codexPreviewText(text, 1200)})
		if len(preview) > 6 {
			preview = preview[len(preview)-6:]
		}
	}
	respondJSON(writer, http.StatusOK, map[string]any{"success": true, "messages": preview})
}

func (server *Server) codexResume(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "codex-structured" {
		notFound(writer, "Codex session not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(request, &input)
	provider, ok := session.Provider.(ResumeProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Provider resume is not supported"))
		return
	}
	if err := provider.Resume(request.Context(), stringValue(input["threadId"])); err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
func (server *Server) codexFork(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "codex-structured" {
		notFound(writer, "Codex session not found")
		return
	}
	var input map[string]any
	_ = decodeJSON(request, &input)
	provider := session.Provider.(*CodexProvider)
	threadID, err := provider.Fork(request.Context(), stringValue(input["threadId"]))
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(
		writer,
		200,
		map[string]any{"success": true, "id": session.ID, "name": session.Name, "threadId": threadID},
	)
}
func (server *Server) codexResumeThreads(writer http.ResponseWriter, request *http.Request) {
	provider, ok := server.codexProvider(writer, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	items, cursor, err := provider.listThreadPage(ctx, codexThreadQuery{
		Cursor: query.Get("cursor"), Search: query.Get("search"),
		AllDirectories: query.Get("scope") == "all", Sort: query.Get("sort"),
	})
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "items": items, "nextCursor": cursor})
}
func (server *Server) codexPrompts(writer http.ResponseWriter, request *http.Request) {
	provider, ok := server.codexProvider(writer, request)
	if !ok {
		return
	}
	items, err := provider.listPrompts(
		request.Context(),
		atoiDefault(request.URL.Query().Get("offset"), 0),
		atoiDefault(request.URL.Query().Get("limit"), 30),
	)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(
		writer,
		200,
		map[string]any{
			"success":    true,
			"items":      items,
			"offset":     atoiDefault(request.URL.Query().Get("offset"), 0),
			"nextOffset": atoiDefault(request.URL.Query().Get("offset"), 0) + len(items),
			"total":      len(items),
			"hasMore":    false,
			"capped":     false,
		},
	)
}
func (server *Server) codexSkills(writer http.ResponseWriter, request *http.Request) {
	provider, ok := server.codexProvider(writer, request)
	if !ok {
		return
	}
	result, err := provider.rpc(
		request.Context(),
		"skills/list",
		map[string]any{
			"cwds":        []string{provider.session.WorkingDirectory},
			"forceReload": request.URL.Query().Get("forceReload") == "true",
		},
	)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	entries := sliceValue(result["data"])
	skills := []any{}
	errorsList := []any{}
	if len(entries) > 0 {
		entry := mapValue(entries[0])
		skills = sliceValue(entry["skills"])
		errorsList = sliceValue(entry["errors"])
	}
	respondJSON(writer, 200, map[string]any{"success": true, "skills": skills, "errors": errorsList})
}
func (server *Server) codexProvider(writer http.ResponseWriter, request *http.Request) (*CodexProvider, bool) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "codex-structured" {
		notFound(writer, "Codex session not found")
		return nil, false
	}
	provider, ok := session.Provider.(*CodexProvider)
	return provider, ok
}

func (provider *CodexProvider) rpc(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	provider.mu.Lock()
	result, err := provider.requestLocked(ctx, method, params)
	provider.mu.Unlock()
	return result, err
}

func (provider *CodexProvider) ensureStarted(ctx context.Context) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.startLocked(ctx)
}
func (provider *CodexProvider) listThreads(ctx context.Context) ([]map[string]any, error) {
	items, _, err := provider.listThreadPage(ctx, codexThreadQuery{})
	return items, err
}
func (provider *CodexProvider) listPrompts(ctx context.Context, offset, limit int) ([]map[string]any, error) {
	threads, err := provider.listThreads(ctx)
	if err != nil {
		return nil, err
	}
	items := []map[string]any{}
	for _, thread := range threads {
		if text := stringValue(sliceValue(thread["questions"])[0]); text != "" {
			items = append(
				items,
				map[string]any{
					"id":        newUUID(),
					"threadId":  thread["id"],
					"text":      text,
					"createdAt": thread["updatedAt"],
				},
			)
		}
	}
	sort.Slice(
		items,
		func(i, j int) bool { return numberInt64(items[i]["createdAt"]) > numberInt64(items[j]["createdAt"]) },
	)
	if offset > len(items) {
		offset = len(items)
	}
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	return items[offset:end], nil
}

var uuidJSONL = regexp.MustCompile(`^[0-9a-f-]{36}\.jsonl$`)

func claudeProjectDir(cwd string) string {
	home, _ := os.UserHomeDir()
	encoded := regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString(filepath.Clean(cwd), "-")
	return filepath.Join(home, ".claude", "projects", encoded)
}
func listClaudeTranscriptPage(cwd, sortBy string, offset, limit int) ([]map[string]any, int) {
	directory := claudeProjectDir(cwd)
	entries, _ := os.ReadDir(directory)
	items := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() || !uuidJSONL.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		questions, createdAt := claudeTranscriptSummary(filepath.Join(directory, entry.Name()))
		items = append(
			items,
			map[string]any{
				"id":        strings.TrimSuffix(entry.Name(), ".jsonl"),
				"cwd":       cwd,
				"createdAt": createdAt,
				"updatedAt": info.ModTime().UnixMilli(),
				"size":      info.Size(),
				"questions": questions,
			},
		)
	}
	sort.Slice(items, func(i, j int) bool {
		key := "updatedAt"
		if sortBy == "created_at" {
			key = "createdAt"
		}
		return numberInt64(items[i][key]) > numberInt64(items[j][key])
	})
	if offset < 0 {
		offset = 0
	}
	if offset > len(items) {
		offset = len(items)
	}
	if limit < 1 || limit > 50 {
		limit = 20
	}
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	nextOffset := -1
	if end < len(items) {
		nextOffset = end
	}
	return items[offset:end], nextOffset
}
func parseTimeMillis(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return millis()
	}
	return parsed.UnixMilli()
}
