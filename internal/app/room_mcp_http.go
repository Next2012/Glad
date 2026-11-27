package app

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

func (server *Server) gladMCPCall(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		SessionID string         `json:"sessionId"`
		Tool      string         `json:"tool"`
		Arguments map[string]any `json:"arguments"`
		CallID    string         `json:"callId"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	session := server.sessions.Get(input.SessionID)
	token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	if session == nil || session.mcpToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(session.mcpToken)) != 1 {
		respondError(writer, 403, errors.New("Invalid Glad session credential"))
		return
	}
	result, err := server.rooms.CallMCP(request.Context(), session, input.Tool, input.Arguments, input.CallID)
	if err != nil {
		respondError(writer, 409, err)
		return
	}
	respondJSON(writer, 200, result)
}
