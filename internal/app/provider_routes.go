package app

import (
	"bufio"
	"context"
	"encoding/json"
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
	mux.HandleFunc("PATCH /api/sessions/{id}/claude-settings", server.providerSettings)
	mux.HandleFunc("POST /api/sessions/{id}/claude-abort", server.providerAbort)
	mux.HandleFunc("POST /api/sessions/{id}/claude-resume", server.claudeResume)
	mux.HandleFunc("POST /api/sessions/{id}/claude-fork", server.claudeFork)
	mux.HandleFunc("PATCH /api/sessions/{id}/codex-settings", server.providerSettings)
	mux.HandleFunc("GET /api/sessions/{id}/codex-resume-threads", server.codexResumeThreads)
	mux.HandleFunc("GET /api/sessions/{id}/codex-thread-preview", server.codexThreadPreview)
	mux.HandleFunc("GET /api/sessions/{id}/codex-prompts", server.codexPrompts)
	mux.HandleFunc("GET /api/sessions/{id}/codex-skills", server.codexSkills)
	mux.HandleFunc("POST /api/sessions/{id}/codex-abort", server.providerAbort)
	mux.HandleFunc("POST /api/sessions/{id}/codex-resume", server.codexResume)
	mux.HandleFunc("POST /api/sessions/{id}/codex-fork", server.codexFork)
	mux.HandleFunc("POST /api/debug/client-log", func(writer http.ResponseWriter, request *http.Request) {
		respondJSON(writer, 200, map[string]any{"success": true})
	})
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
	provider, ok := session.Provider.(ResumeProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Provider resume is not supported"))
		return
	}
	if err := provider.Resume(request.Context(), id); err != nil {
		respondError(writer, 400, err)
		return
	}
	messages := readClaudeTranscript(session.WorkingDirectory, id)
	if len(messages) > 0 {
		session.mu.Lock()
		session.Messages = messages
		session.publishLocked(map[string]any{"type": "history-reset", "messages": messages})
		session.mu.Unlock()
	}
	respondJSON(writer, 200, map[string]any{"success": true})
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
	respondJSON(writer, 200, map[string]any{"success": true, "items": listClaudeTranscripts(session.WorkingDirectory)})
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
func listClaudeTranscripts(cwd string) []map[string]any {
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
		questions := claudeQuestions(filepath.Join(directory, entry.Name()))
		items = append(
			items,
			map[string]any{
				"id":        strings.TrimSuffix(entry.Name(), ".jsonl"),
				"cwd":       cwd,
				"updatedAt": info.ModTime().UnixMilli(),
				"size":      info.Size(),
				"questions": questions,
			},
		)
	}
	sort.Slice(
		items,
		func(i, j int) bool { return numberInt64(items[i]["updatedAt"]) > numberInt64(items[j]["updatedAt"]) },
	)
	if len(items) > 40 {
		items = items[:40]
	}
	return items
}
func claudeQuestions(filename string) []string {
	file, err := os.Open(filename)
	if err != nil {
		return []string{}
	}
	defer file.Close()
	questions := []string{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil || stringValue(record["type"]) != "user" ||
			boolValue(record["isSidechain"]) {
			continue
		}
		text := claudeRecordText(record)
		if text != "" && !strings.HasPrefix(text, "<command-name>/") {
			questions = append(questions, text)
		}
	}
	if len(questions) > 2 {
		questions = questions[len(questions)-2:]
	}
	for i, j := 0, len(questions)-1; i < j; i, j = i+1, j-1 {
		questions[i], questions[j] = questions[j], questions[i]
	}
	return questions
}
func readClaudeTranscript(cwd, id string) []map[string]any {
	filename := filepath.Join(claudeProjectDir(cwd), id+".jsonl")
	file, err := os.Open(filename)
	if err != nil {
		return nil
	}
	defer file.Close()
	messages := []map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 32<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil || boolValue(record["isSidechain"]) {
			continue
		}
		text := claudeRecordText(record)
		if text == "" {
			continue
		}
		kind := stringValue(record["type"])
		if kind != "user" && kind != "assistant" {
			continue
		}
		messages = append(
			messages,
			map[string]any{
				"id":        newUUID(),
				"kind":      kind,
				"text":      text,
				"createdAt": parseTimeMillis(stringValue(record["timestamp"])),
			},
		)
	}
	if len(messages) > 1000 {
		messages = messages[len(messages)-1000:]
	}
	return messages
}
func claudeRecordText(record map[string]any) string {
	content := mapValue(record["message"])["content"]
	if text, ok := content.(string); ok {
		return strings.TrimSpace(text)
	}
	return strings.TrimSpace(textFromClaudeContent(sliceValue(content)))
}
func parseTimeMillis(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return millis()
	}
	return parsed.UnixMilli()
}
