package app

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"unicode/utf8"

	sessioncore "glad-web/internal/session"
)

const (
	conversationRootTurns      = 12
	conversationPageMessages   = 128
	conversationPageBytes      = 256 << 10
	conversationPreviewBytes   = 8 << 10
	conversationTextChunkBytes = 32 << 10
)

var errConversationCursor = errors.New("Invalid conversation cursor")
var errConversationEpoch = errors.New("Conversation changed; reload its latest messages")

type conversationCursor struct {
	Session  string `json:"session"`
	Native   string `json:"native"`
	Epoch    string `json:"epoch"`
	Before   string `json:"before"`
	Revision uint64 `json:"revision"`
}

func conversationTextVersion(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func conversationPreview(message map[string]any) map[string]any {
	copy := cloneMap(message)
	if text, ok := copy["text"].(string); ok {
		copy["textVersion"] = conversationTextVersion(text)
		copy["textDeferred"] = len(text) > conversationPreviewBytes
		copy["textBytes"] = len(text)
		if len(text) > conversationPreviewBytes {
			end := conversationPreviewBytes
			for end > 0 && !utf8.RuneStart(text[end]) {
				end--
			}
			copy["text"] = text[:end]
		}
	}
	return copy
}

func (session *Session) conversationEpochLocked() (string, string) {
	native := sessionNativeConversationID(session)
	key := session.ID + "\x00" + native + "\x00" + strconv.FormatUint(session.outputResetRevision, 10)
	return conversationTextVersion(key), native
}

func conversationTailRequested(path string) bool {
	u, err := url.Parse(path)
	return err == nil && u.Query().Get("history") == "tail"
}

func conversationPermissionRelated(permission Permission, messages []map[string]any) bool {
	for _, message := range messages {
		if permission.ThreadID != "" && stringValue(message["threadId"]) != "" && permission.ThreadID != stringValue(message["threadId"]) {
			continue
		}
		if permission.TurnID != "" && permission.TurnID == stringValue(message["turnId"]) {
			return true
		}
		if permission.ToolUseID != "" {
			for _, field := range []string{"id", "providerId", "toolUseId"} {
				if permission.ToolUseID == stringValue(message[field]) {
					return true
				}
			}
		}
	}
	return false
}

// The cursor contains no file path and never determines the authorized session.
// Its identity and epoch are checked against the session selected by the route.
func (session *Session) conversationPageLocked(before string, limit int) (map[string]any, error) {
	epoch, native := session.conversationEpochLocked()
	end := len(session.Messages)
	if before != "" {
		if len(before) > 4096 {
			return nil, errConversationCursor
		}
		encoded, err := base64.RawURLEncoding.DecodeString(before)
		var cursor conversationCursor
		if err != nil || json.Unmarshal(encoded, &cursor) != nil || cursor.Session != session.ID || cursor.Before == "" {
			return nil, errConversationCursor
		}
		if cursor.Epoch != epoch || cursor.Native != native || cursor.Revision < session.outputResetRevision || cursor.Revision > session.outputRevision {
			return nil, errConversationEpoch
		}
		end = -1
		for index, message := range session.Messages {
			if stringValue(message["id"]) == cursor.Before {
				end = index
				break
			}
		}
		if end < 0 {
			return nil, errConversationEpoch
		}
	}
	if limit <= 0 || limit > conversationPageMessages {
		limit = conversationPageMessages
	}
	start, usedBytes, turns := end, 2, 0
	seenTurns := map[string]bool{}
	hasRootMarkers := false
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "turn-start" && !hasFalseRoot(message) {
			hasRootMarkers = true
			break
		}
	}
	reversed := []map[string]any{}
	oversizedMetadata := false
	for index := end - 1; index >= 0; index-- {
		message := session.Messages[index]
		public := conversationPreview(publicMessage(message, session.Kind))
		public["historyIndex"] = index
		encoded, _ := json.Marshal(public)
		if len(encoded) > conversationPageBytes && stringValue(message["kind"]) == "tool" && (session.Kind == "codex-structured" || session.Kind == "antigravity-structured") {
			// Native details stay available through the existing detail endpoint.
			// A single enormous metadata field must not defeat the page byte cap.
			thin := map[string]any{"hasDetail": true, "historyIndex": index}
			for _, key := range []string{"id", "kind", "providerId", "threadId", "turnId", "toolUseId", "revision", "createdAt", "updatedAt", "completedAtMs", "text", "textVersion", "textBytes", "textDeferred", "toolStatus", "questionStatus"} {
				if value, ok := public[key]; ok {
					thin[key] = value
				}
			}
			public = thin
			encoded, _ = json.Marshal(public)
		}
		if len(reversed) >= limit || (len(reversed) > 0 && usedBytes+len(encoded)+1 > conversationPageBytes) {
			break
		}
		reversed = append(reversed, public)
		usedBytes += len(encoded) + 1
		start = index
		if len(encoded)+2 > conversationPageBytes {
			// A provider without lazy metadata access must retain its public
			// fields. Give this exceptional record a page of its own rather
			// than silently dropping inputs or other readable metadata.
			oversizedMetadata = true
			break
		}
		rootStart := stringValue(message["kind"]) == "turn-start" && !hasFalseRoot(message)
		// Older imports without turn-start markers still get a bounded user window.
		if rootStart || (!hasRootMarkers && stringValue(message["kind"]) == "user") {
			turn := stringValue(message["threadId"]) + ":" + stringValue(message["turnId"])
			if stringValue(message["turnId"]) == "" {
				turn = stringValue(message["id"])
			}
			if !seenTurns[turn] {
				seenTurns[turn] = true
				turns++
			}
			if turns >= conversationRootTurns && (rootStart || stringValue(message["turnId"]) == "") {
				break
			}
		}
	}
	messages := make([]map[string]any, len(reversed))
	for index, message := range reversed {
		messages[len(reversed)-1-index] = message
	}
	page := map[string]any{"paged": true, "epoch": epoch, "revision": session.outputRevision, "hasBefore": start > 0, "beforeCursor": "", "totalMessages": len(session.Messages), "oversizedMetadata": oversizedMetadata}
	if start > 0 && len(messages) > 0 {
		cursor, _ := json.Marshal(conversationCursor{Session: session.ID, Native: native, Epoch: epoch, Before: stringValue(messages[0]["id"]), Revision: session.outputRevision})
		page["beforeCursor"] = base64.RawURLEncoding.EncodeToString(cursor)
		first := session.Messages[start]
		page["continued"] = stringValue(first["kind"]) != "turn-start" && stringValue(first["turnId"]) != "" && stringValue(first["turnId"]) == stringValue(session.Messages[start-1]["turnId"])
	}
	resolved := []Permission{}
	for _, permission := range session.CompletedPermissions {
		if conversationPermissionRelated(permission, messages) {
			resolved = append(resolved, permission)
		}
	}
	return map[string]any{"success": true, "messages": messages, "historyPage": page, "resolvedPermissions": resolved}, nil
}

func (session *Session) conversationSnapshotLocked() map[string]any {
	result, _ := session.conversationPageLocked("", 0)
	permissions := append([]Permission{}, result["resolvedPermissions"].([]Permission)...)
	for _, permission := range session.Permissions {
		permissions = append(permissions, permission)
	}
	questions := []map[string]any{}
	for index, message := range session.Messages {
		if stringValue(message["kind"]) == "question" && stringValue(message["questionStatus"]) == "pending" {
			copy := publicMessage(message, session.Kind)
			copy["historyIndex"] = index
			questions = append(questions, copy)
		}
	}
	return map[string]any{
		"id": session.ID, "name": session.Name, "tool": session.Tool.DisplayName, "toolKey": session.Tool.Key,
		"status": session.StatusValue, "state": session.speedStateLocked(), "messages": result["messages"],
		"historyPage": result["historyPage"], "pendingPermissions": permissions, "pendingQuestions": questions,
		"hasUnreadCompletion": session.HasUnreadCompletion, "completionRevision": session.CompletionRevision,
	}
}

func (session *Session) subscribeConversation(capacity int, tail bool) (*sessioncore.Subscription, map[string]any) {
	if !tail {
		return session.subscribeWithSnapshot(capacity)
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	subscription := session.events.Subscribe(session.ID, capacity)
	return subscription, session.conversationSnapshotLocked()
}

type conversationEventWindow struct {
	session  *Session
	tail     bool
	revision uint64
}

func newConversationEventWindow(session *Session, tail bool, snapshot map[string]any) *conversationEventWindow {
	return &conversationEventWindow{session: session, tail: tail, revision: uint64(numberInt64(mapValue(snapshot["historyPage"])["revision"]))}
}

func (window *conversationEventWindow) project(event map[string]any) map[string]any {
	if !window.tail {
		return event
	}
	revision := uint64(numberInt64(event["outputRevision"]))
	if revision > 0 && revision <= window.revision {
		return nil
	}
	copy := cloneMap(event)
	if stringValue(event["type"]) == "history-reset" {
		// Coalesce an already superseded reset into one current authoritative tail.
		// Buffered events at or below this snapshot revision are then redundant.
		window.session.mu.RLock()
		snapshot := window.session.conversationSnapshotLocked()
		window.session.mu.RUnlock()
		for _, key := range []string{"name", "messages", "historyPage", "pendingPermissions", "pendingQuestions", "state", "hasUnreadCompletion", "completionRevision"} {
			copy[key] = snapshot[key]
		}
		window.revision = uint64(numberInt64(mapValue(snapshot["historyPage"])["revision"]))
		copy["outputRevision"] = window.revision
	} else {
		if message := mapValue(copy["message"]); len(message) > 0 {
			kind := stringValue(message["kind"])
			if kind == "assistant" || kind == "user" {
				// Paging limits historical bodies. Newly generated text must keep
				// progressing beyond the preview boundary in the active view.
				live := cloneMap(message)
				if text, ok := live["text"].(string); ok {
					live["textVersion"], live["textBytes"], live["textDeferred"] = conversationTextVersion(text), len(text), false
				}
				copy["message"] = live
			} else {
				copy["message"] = conversationPreview(message)
			}
		}
		if revision > window.revision {
			window.revision = revision
		}
	}
	return copy
}

func (server *Server) conversationPage(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	session.mu.RLock()
	page, err := session.conversationPageLocked(request.URL.Query().Get("before"), atoiDefault(request.URL.Query().Get("limit"), 0))
	session.mu.RUnlock()
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errConversationEpoch) {
			status = http.StatusConflict
		}
		respondError(writer, status, err)
		return
	}
	respondJSON(writer, http.StatusOK, page)
}

func (server *Server) conversationMessageText(writer http.ResponseWriter, request *http.Request) {
	session := server.sessions.Get(request.PathValue("id"))
	if session == nil {
		notFound(writer, "Session not found")
		return
	}
	offset := 0
	if value := request.URL.Query().Get("offset"); value != "" {
		var err error
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 {
			respondError(writer, http.StatusBadRequest, errors.New("Invalid text offset"))
			return
		}
	}
	session.mu.RLock()
	var text string
	found := false
	for _, message := range session.Messages {
		if stringValue(message["id"]) == request.PathValue("messageId") {
			text, found = message["text"].(string)
			break
		}
	}
	session.mu.RUnlock()
	if !found {
		notFound(writer, "Message text not found")
		return
	}
	version := conversationTextVersion(text)
	if expected := request.URL.Query().Get("version"); expected != "" && expected != version {
		respondError(writer, http.StatusConflict, errors.New("Message changed; reload its text"))
		return
	}
	offset = min(offset, len(text))
	for offset > 0 && offset < len(text) && !utf8.RuneStart(text[offset]) {
		offset--
	}
	end := min(len(text), offset+conversationTextChunkBytes)
	for end < len(text) && end > offset && !utf8.RuneStart(text[end]) {
		end--
	}
	respondJSON(writer, http.StatusOK, map[string]any{"text": text[offset:end], "version": version, "nextOffset": end, "hasMore": end < len(text)})
}
