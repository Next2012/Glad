package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// Readiness is a snapshot only. Send must check again under the provider lock.
type ReadinessProvider interface{ CanAccept() (bool, string) }

type SupervisorSource struct {
	Version      int    `json:"version"`
	TaskID       string `json:"taskId"`
	InvocationID string `json:"invocationId"`
	Kind         string `json:"kind"`
}

func (source *SupervisorSource) valid() bool {
	return source != nil && source.Version == 1 && safeUploadIDPattern.MatchString(source.TaskID) && safeUploadIDPattern.MatchString(source.InvocationID) && (source.Kind == "trigger" || source.Kind == "command")
}
func (source *SupervisorSource) values() map[string]any {
	if source == nil {
		return nil
	}
	return map[string]any{"version": source.Version, "taskId": source.TaskID, "invocationId": source.InvocationID, "kind": source.Kind}
}
func sourceValue(value any) *SupervisorSource {
	data, _ := json.Marshal(value)
	var source SupervisorSource
	if json.Unmarshal(data, &source) == nil && source.valid() {
		return &source
	}
	return nil
}

const supervisorEnvelopePrefix = "Glad supervisor invocation v1\n<glad_supervisor_invocation>"

func supervisorAgentText(source *SupervisorSource, text string) string {
	if !source.valid() {
		return text
	}
	data, _ := json.Marshal(source)
	return supervisorEnvelopePrefix + string(data) + "</glad_supervisor_invocation>\n<glad_supervisor_message>\n" + text + "\n</glad_supervisor_message>"
}
func supervisorEnvelope(text string) (*SupervisorSource, string) {
	if !strings.HasPrefix(text, supervisorEnvelopePrefix) {
		return nil, text
	}
	value := strings.TrimPrefix(text, supervisorEnvelopePrefix)
	end := strings.Index(value, "</glad_supervisor_invocation>\n<glad_supervisor_message>\n")
	if end < 0 || !strings.HasSuffix(value, "\n</glad_supervisor_message>") {
		return nil, text
	}
	var source SupervisorSource
	if json.Unmarshal([]byte(value[:end]), &source) != nil || !source.valid() {
		return nil, text
	}
	body := value[end+len("</glad_supervisor_invocation>\n<glad_supervisor_message>\n"):]
	return &source, strings.TrimSuffix(body, "\n</glad_supervisor_message>")
}

func providerReadiness(session *Session) (bool, string) {
	if provider, ok := session.Provider.(ReadinessProvider); ok {
		return provider.CanAccept()
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	if session.closed || session.StatusValue != "idle" {
		return false, "Session is busy or unavailable"
	}
	return true, ""
}
func sessionCanAccept(session *Session) (bool, string) {
	session.mu.RLock()
	lease, closed := session.supervisorLease, session.closed
	session.mu.RUnlock()
	if closed {
		return false, "Session is closed"
	}
	if lease != "" {
		return false, "Supervisor is settling its current invocation"
	}
	return providerReadiness(session)
}
func (provider *CodexProvider) CanAccept() (bool, string) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.closed || provider.turnID != "" || provider.sending || provider.aborting || provider.resumeInFlight || provider.resuming || provider.forking || provider.capacityRetryTimer != nil {
		return false, "Codex session is busy or recovering"
	}
	return true, ""
}
func (provider *ClaudeProvider) CanAccept() (bool, string) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.closed || len(provider.turns) > 0 || len(provider.permissions) > 0 || len(provider.questions) > 0 || provider.localCommand != "" || provider.statusPending {
		return false, "Claude session is busy or stopping"
	}
	return true, ""
}

func sendSessionControlled(ctx context.Context, session *Session, input ProviderInput) error {
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	return sendSessionControlledLocked(ctx, session, input)
}
func sendSessionControlledLocked(ctx context.Context, session *Session, input ProviderInput) error {
	encoded, _ := json.Marshal(input)
	digest := sha256.Sum256(encoded)
	hash := hex.EncodeToString(digest[:])
	session.mu.RLock()
	savedHash, exists := session.controlHashes[input.ClientMessageID]
	lease := session.supervisorLease
	session.mu.RUnlock()
	if input.ClientMessageID != "" && exists {
		if savedHash != hash {
			return errors.New("message ID was already used for different content")
		}
		return nil
	}
	if lease != "" && (input.Source == nil || input.Source.Kind != "trigger" || input.Source.InvocationID != lease) {
		return errors.New("Session is reserved by an active supervisor invocation")
	}
	if ok, reason := providerReadiness(session); !ok {
		return errors.New(reason)
	}
	if err := session.Provider.Send(ctx, input); err != nil {
		return err
	}
	if input.ClientMessageID != "" {
		session.mu.Lock()
		if session.controlHashes == nil {
			session.controlHashes = map[string]string{}
		}
		if len(session.controlHashes) >= 1024 {
			for key := range session.controlHashes {
				delete(session.controlHashes, key)
				break
			}
		}
		session.controlHashes[input.ClientMessageID] = hash
		session.mu.Unlock()
	}
	return nil
}

func (session *Session) beginInput(input ProviderInput) {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.currentSource = input.Source
}

// Attach provenance synchronously, before independent notification consumers see it.
func (session *Session) tagSourceLocked(event map[string]any) {
	message := mapValue(event["message"])
	if len(message) == 0 {
		return
	}
	if root, exists := message["isRootTurn"]; exists && !boolValue(root) {
		return
	}
	if thread := stringValue(message["threadId"]); thread != "" && stringValue(session.State["threadId"]) != "" && thread != stringValue(session.State["threadId"]) {
		return
	}
	turn := stringValue(message["turnId"])
	source := session.sourceTurns[turn]
	if source == nil && session.currentSource != nil {
		if stringValue(message["kind"]) == "user" || stringValue(message["kind"]) == "turn-start" || boolValue(message["isRootTurn"]) {
			source = session.currentSource
		}
	}
	if source != nil {
		message["supervisorSource"] = source.values()
		event["supervisorSource"] = source.values()
		for _, item := range session.Messages {
			if item["id"] == message["id"] {
				item["supervisorSource"] = source.values()
				break
			}
		}
		if turn != "" {
			if session.sourceTurns == nil {
				session.sourceTurns = map[string]*SupervisorSource{}
			}
			session.sourceTurns[turn] = source
		}
	}
}
func quietSupervisorCompletion(event map[string]any) bool {
	message := mapValue(event["message"])
	return sourceValue(event["supervisorSource"]) != nil && stringValue(message["kind"]) == "turn-end" && firstNonEmpty(stringValue(message["status"]), stringValue(message["turnStatus"]), "completed") == "completed"
}

func stopSessionControlled(ctx context.Context, session *Session, expectedTurn string) error {
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	return stopSessionControlledLocked(ctx, session, expectedTurn)
}
func stopSessionControlledLocked(ctx context.Context, session *Session, expectedTurn string) error {
	if expectedTurn != "" {
		session.mu.RLock()
		latest := ""
		for _, message := range session.Messages {
			if stringValue(message["kind"]) == "turn-start" && !hasFalseRoot(message) {
				latest = stringValue(message["turnId"])
			}
		}
		session.mu.RUnlock()
		if latest != expectedTurn {
			return errors.New("Target turn changed; read its state again before stopping")
		}
	}
	provider, ok := session.Provider.(InterruptProvider)
	if !ok {
		return errors.New("Provider interruption is not supported")
	}
	return provider.Interrupt(ctx)
}
func hasFalseRoot(message map[string]any) bool {
	value, ok := message["isRootTurn"]
	return ok && !boolValue(value)
}

func sessionOutput(session *Session, after uint64, limit, offset int, history bool) map[string]any {
	limit = min(200, max(1, limit))
	offset = max(0, offset)
	session.mu.RLock()
	revision, resetRevision, status := session.outputRevision, session.outputResetRevision, session.StatusValue
	turnID := ""
	conversationID := sessionNativeConversationID(session)
	for i := len(session.Messages) - 1; i >= 0; i-- {
		message := session.Messages[i]
		if stringValue(message["kind"]) == "turn-start" && !hasFalseRoot(message) {
			turnID = stringValue(message["turnId"])
			break
		}
	}
	reset := !history && (after == 0 || after < resetRevision || after > revision)
	messages := []map[string]any{}
	for _, item := range session.Messages {
		if !history && !reset && uint64(numberInt64(item["revision"])) <= after {
			continue
		}
		message := publicMessage(item, session.Kind)
		for _, key := range []string{"text", "result", "error"} {
			if text, ok := message[key].(string); ok && len(text) > 8192 {
				message[key] = codexPreviewText(text, 8192)
				message["truncated"] = true
			}
		}
		delete(message, "agentText")
		messages = append(messages, message)
	}
	session.mu.RUnlock()
	if !history && !reset {
		sort.SliceStable(messages, func(i, j int) bool {
			return numberInt64(messages[i]["revision"]) < numberInt64(messages[j]["revision"])
		})
	}
	total := len(messages)
	next := revision
	if history {
		start := min(offset, total)
		messages = messages[start:min(start+limit, total)]
	} else if reset && total > limit {
		messages = messages[total-limit:]
	} else if !reset && total > limit {
		messages = messages[:limit]
		next = uint64(numberInt64(messages[len(messages)-1]["revision"]))
	}
	ready, reason := sessionCanAccept(session)
	return map[string]any{"success": true, "sessionId": session.ID, "status": status, "currentTurnId": turnID, "nativeConversationId": conversationID, "canAccept": ready, "readinessReason": reason, "revision": revision, "cursor": next, "reset": reset, "messages": messages, "total": total, "hasMore": history && offset+len(messages) < total || !history && !reset && next < revision, "truncated": reset && total > limit}
}
func (server *Server) sessionOutputRoute(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	after, _ := strconv.ParseUint(request.URL.Query().Get("after"), 10, 64)
	respondJSON(writer, 200, sessionOutput(session, after, atoiDefault(request.URL.Query().Get("limit"), 50), atoiDefault(request.URL.Query().Get("offset"), 0), request.URL.Query().Get("history") == "true"))
}
func (server *Server) abortSessionRoute(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	var input struct {
		ExpectedTurnID string `json:"expectedTurnId"`
	}
	_ = decodeJSON(request, &input)
	if err := stopSessionControlled(request.Context(), session, input.ExpectedTurnID); err != nil {
		respondError(writer, 409, err)
		return
	}
	ready, reason := sessionCanAccept(session)
	respondJSON(writer, 202, map[string]any{"success": true, "canAccept": ready, "readinessReason": reason})
}
