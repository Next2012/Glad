package app

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"
)

func (server *Server) registerAntigravityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{id}/antigravity-subagents", server.antigravitySubagents)
	mux.HandleFunc("GET /api/sessions/{id}/antigravity-subagents/{childId}", server.antigravitySubagentHistory)
	mux.HandleFunc("PATCH /api/sessions/{id}/antigravity-settings", server.antigravitySettings)
	mux.HandleFunc("POST /api/sessions/{id}/antigravity-abort", server.antigravityAbort)
	mux.HandleFunc("POST /api/sessions/{id}/antigravity-resume", server.antigravityResume)
	mux.HandleFunc("POST /api/sessions/{id}/antigravity-user-input", server.antigravityUserInput)
	mux.HandleFunc("GET /api/sessions/{id}/antigravity-resume-sessions", server.antigravityResumeSessions)
	mux.HandleFunc("GET /api/sessions/{id}/antigravity-session-preview", server.antigravitySessionPreview)
	mux.HandleFunc("GET /api/sessions/{id}/antigravity-commands", server.antigravityCommands)
	mux.HandleFunc("POST /api/sessions/{id}/antigravity-status", server.antigravityStatus)
	mux.HandleFunc("POST /api/sessions/{id}/antigravity-compact", server.antigravityCompact)
}
func (server *Server) antigravityProvider(writer http.ResponseWriter, request *http.Request) (*AntigravityProvider, bool) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil || session.Kind != "antigravity-structured" {
		notFound(writer, "Antigravity session not found")
		return nil, false
	}
	provider, ok := session.Provider.(*AntigravityProvider)
	if !ok {
		respondError(writer, http.StatusConflict, errors.New("Session does not own an Antigravity provider"))
		return nil, false
	}
	return provider, true
}
func (server *Server) antigravitySettings(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	var settings map[string]any
	if err := decodeJSON(request, &settings); err != nil {
		respondError(writer, 400, err)
		return
	}
	p.session.commandMu.Lock()
	defer p.session.commandMu.Unlock()
	if err := p.UpdateSettings(request.Context(), settings); err != nil {
		respondError(writer, 400, err)
		return
	}
	p.session.mu.RLock()
	state := cloneMap(p.session.State)
	p.session.mu.RUnlock()
	respondJSON(writer, 200, map[string]any{"success": true, "state": state})
}
func (server *Server) antigravityAbort(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	if err := stopSessionControlled(request.Context(), p.session, ""); err != nil {
		respondError(writer, 409, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
func (server *Server) antigravityResume(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	id := firstNonEmpty(stringValue(input["sessionId"]), stringValue(input["antigravitySessionId"]), stringValue(input["resumeSessionId"]))
	finish := p.session.beginConversationRecovery()
	defer finish()
	if err := p.Resume(request.Context(), id); err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "antigravitySessionId": id})
}
func (server *Server) antigravityUserInput(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	if err := p.RespondUserInput(request.Context(), firstNonEmpty(stringValue(input["id"]), stringValue(input["questionId"])), input); err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}
func (server *Server) antigravityResumeSessions(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	items, cursor, err := p.listSessions(ctx, request.URL.Query().Get("cursor"), request.URL.Query().Get("scope") == "all")
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "items": items, "nextCursor": nilIfEmpty(cursor)})
}
func (server *Server) antigravitySessionPreview(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	if request.URL.Query().Get("history") == "tail" {
		if preview, found, err := p.cachedPreview(ctx, request.URL.Query().Get("sessionId")); err != nil {
			respondError(writer, 400, err)
			return
		} else if found {
			respondJSON(writer, 200, preview)
			return
		}
	}
	messages, err := p.preview(ctx, request.URL.Query().Get("sessionId"))
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "messages": messages})
}
func (server *Server) antigravityCommands(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	p.mu.Lock()
	commands := append([]map[string]any{}, p.commands...)
	p.mu.Unlock()
	respondJSON(writer, 200, map[string]any{"success": true, "items": commands})
}
func (server *Server) antigravityStatus(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	if err := p.Status(request.Context()); err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}

func (server *Server) antigravityCompact(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	p.session.commandMu.Lock()
	defer p.session.commandMu.Unlock()
	if err := p.Compact(request.Context()); err != nil {
		respondError(writer, 409, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true})
}

func (server *Server) antigravitySubagents(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	data, err := p.subagentDirectory(ctx)
	if err != nil {
		respondError(writer, http.StatusConflict, err)
		return
	}
	respondJSON(writer, http.StatusOK, data)
}
func (server *Server) antigravitySubagentHistory(writer http.ResponseWriter, request *http.Request) {
	p, ok := server.antigravityProvider(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	data, err := p.subagentHistory(ctx, request.PathValue("childId"), request.URL.Query().Get("before"), limit)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errAgySubagentNotFound) {
			code = http.StatusNotFound
		}
		if errors.Is(err, errAgySubagentChanged) {
			code = http.StatusConflict
		}
		respondError(writer, code, err)
		return
	}
	respondJSON(writer, http.StatusOK, data)
}
