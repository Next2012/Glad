package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

func conversationFixture(t *testing.T, turns int) (*Session, *Server) {
	t.Helper()
	session := newSession("conversation", "Conversation", "antigravity-structured", ToolInfo{Key: "antigravity", DisplayName: "Antigravity"}, t.TempDir())
	t.Cleanup(session.cancel)
	session.State["nativeConversationId"] = "native-conversation"
	session.CompletionRevision = 77
	session.appendMessage(map[string]any{"id": "old-question", "kind": "question", "questionStatus": "pending", "text": "An older question", "questions": []any{map[string]any{"id": "answer", "question": "Choose"}}})
	for turn := 0; turn < turns; turn++ {
		turnID := fmt.Sprintf("turn-%d", turn)
		for _, kind := range []string{"turn-start", "user", "tool", "assistant", "turn-end"} {
			session.appendMessage(map[string]any{"id": fmt.Sprintf("%s-%d", kind, turn), "kind": kind, "threadId": "native-conversation", "turnId": turnID, "isRootTurn": true, "text": fmt.Sprintf("%s text %d", kind, turn), "providerId": fmt.Sprintf("native-tool-%d", turn), "input": map[string]any{"detail": "private tool input"}})
		}
	}
	manager := NewSessionManager(t.TempDir())
	manager.sessions[session.ID] = session
	return session, &Server{sessions: manager}
}

func conversationRequest(server *Server, target string) *httptest.ResponseRecorder {
	mux := conversationTestMux(server)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
	return response
}

func conversationTestMux(server *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sessions/{id}/conversation", server.conversationPage)
	mux.HandleFunc("GET /api/sessions/{id}/conversation-messages/{messageId}/text", server.conversationMessageText)
	mux.HandleFunc("GET /api/sessions/{id}", server.getSession)
	return mux
}

func TestConversationTailWindowKeepsActiveInteractionsAndLegacyFullSnapshot(t *testing.T) {
	session, server := conversationFixture(t, 20)
	session.CompletedPermissions = []Permission{
		{ID: "old-audit", Status: "denied", ThreadID: "native-conversation", TurnID: "turn-0"},
		{ID: "recent-audit", Status: "approved", ThreadID: "native-conversation", TurnID: "turn-19"},
	}
	session.Permissions["old-pending"] = Permission{ID: "old-pending", Status: "pending", TurnID: "turn-0"}
	subscription, snapshot := session.subscribeConversation(32, true)
	defer subscription.Close()
	messages := snapshot["messages"].([]map[string]any)
	if len(messages) != 12*5 || messages[0]["id"] != "turn-start-8" || messages[0]["historyIndex"] != 41 {
		t.Fatalf("incorrect tail: %d %#v", len(messages), messages[0])
	}
	questions := snapshot["pendingQuestions"].([]map[string]any)
	if len(questions) != 1 || questions[0]["id"] != "old-question" || questions[0]["historyIndex"] != 0 {
		t.Fatal("pending question outside the window disappeared")
	}
	permissions := snapshot["pendingPermissions"].([]Permission)
	if len(permissions) != 2 || permissions[0].ID != "recent-audit" || permissions[1].ID != "old-pending" {
		t.Fatalf("wrong permissions: %#v", permissions)
	}
	page := mapValue(snapshot["historyPage"])
	if page["revision"] != session.outputRevision || snapshot["completionRevision"] != uint64(77) || page["totalMessages"] != 101 || page["hasBefore"] != true {
		t.Fatalf("incorrect page metadata: %#v", page)
	}
	legacy := session.snapshot()
	if len(legacy["messages"].([]map[string]any)) != 101 || legacy["historyPage"] != nil || len(legacy["pendingPermissions"].([]Permission)) != 3 {
		t.Fatal("legacy full snapshot changed")
	}
	response := conversationRequest(server, "/api/sessions/conversation?history=tail")
	if response.Code != http.StatusOK {
		t.Fatal(response.Code)
	}
	var wire map[string]any
	if json.Unmarshal(response.Body.Bytes(), &wire) != nil || len(sliceValue(wire["messages"])) != 60 {
		t.Fatal("HTTP tail snapshot did not match WS projection")
	}
	session.appendMessage(map[string]any{"id": "after-snapshot", "kind": "assistant", "text": "A live response"})
	event := <-subscription.Events()
	if uint64(numberInt64(event.Payload["outputRevision"])) <= uint64(numberInt64(page["revision"])) {
		t.Fatal("live event was not newer than atomic snapshot")
	}
}

func TestConversationCursorsLoadHistoryWithoutDuplicatesAndRejectChangedEpoch(t *testing.T) {
	session, server := conversationFixture(t, 20)
	session.mu.RLock()
	page, err := session.conversationPageLocked("", 7)
	session.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	firstCursor := stringValue(mapValue(page["historyPage"])["beforeCursor"])
	for {
		for _, message := range page["messages"].([]map[string]any) {
			id := stringValue(message["id"])
			if seen[id] {
				t.Fatalf("duplicate message %s", id)
			}
			seen[id] = true
		}
		metadata := mapValue(page["historyPage"])
		if metadata["hasBefore"] != true {
			break
		}
		session.mu.RLock()
		page, err = session.conversationPageLocked(stringValue(metadata["beforeCursor"]), 7)
		session.mu.RUnlock()
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != len(session.Messages) {
		t.Fatalf("history lost messages: %d / %d", len(seen), len(session.Messages))
	}
	bad := conversationRequest(server, "/api/sessions/conversation/conversation?before=not-base64")
	if bad.Code != http.StatusBadRequest {
		t.Fatal("malformed cursor accepted")
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(firstCursor)
	var cursor conversationCursor
	_ = json.Unmarshal(decoded, &cursor)
	cursor.Session = "another-session"
	encoded, _ := json.Marshal(cursor)
	bad = conversationRequest(server, "/api/sessions/conversation/conversation?before="+base64.RawURLEncoding.EncodeToString(encoded))
	if bad.Code != http.StatusBadRequest {
		t.Fatal("cursor crossed session identity")
	}
	session.replaceMessages(append([]map[string]any{}, session.Messages...))
	stale := conversationRequest(server, "/api/sessions/conversation/conversation?before="+url.QueryEscape(firstCursor))
	if stale.Code != http.StatusConflict {
		t.Fatal("old epoch accepted after history reset")
	}
}

func TestConversationLargeTurnHonorsByteAndMessageCapsWithoutDeletingHistory(t *testing.T) {
	session, _ := conversationFixture(t, 0)
	session.appendMessage(map[string]any{"id": "huge-start", "kind": "turn-start", "turnId": "huge", "isRootTurn": true})
	for index := 0; index < 180; index++ {
		session.appendMessage(map[string]any{"id": fmt.Sprintf("huge-%d", index), "kind": "assistant", "turnId": "huge", "text": strings.Repeat("x", 9000)})
	}
	session.mu.RLock()
	page, err := session.conversationPageLocked("", 0)
	session.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	messages := page["messages"].([]map[string]any)
	encoded, _ := json.Marshal(messages)
	if len(messages) > conversationPageMessages || len(encoded) > conversationPageBytes || mapValue(page["historyPage"])["continued"] != true {
		t.Fatalf("oversized turn defeated limits: %d rows, %d bytes", len(messages), len(encoded))
	}
	if len(session.Messages) != 182 {
		t.Fatal("paging deleted canonical history")
	}
	for _, message := range messages {
		if message["textDeferred"] != true || len(stringValue(message["text"])) > conversationPreviewBytes || stringValue(message["textVersion"]) == "" {
			t.Fatal("oversized body was not deferred")
		}
	}
}

func TestConversationTextChunksAreVersionedAndUTF8Safe(t *testing.T) {
	session, server := conversationFixture(t, 0)
	text := strings.Repeat("汉字🌙", 9000)
	session.appendMessage(map[string]any{"id": "long-body", "kind": "assistant", "text": text})
	version := conversationTextVersion(text)
	assembled, offset := "", 0
	for {
		response := conversationRequest(server, fmt.Sprintf("/api/sessions/conversation/conversation-messages/long-body/text?version=%s&offset=%d", version, offset))
		if response.Code != http.StatusOK {
			t.Fatal(response.Code)
		}
		var chunk map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &chunk); err != nil {
			t.Fatal(err)
		}
		body := stringValue(chunk["text"])
		if !utf8.ValidString(body) || len(body) > conversationTextChunkBytes || chunk["version"] != version {
			t.Fatal("text chunk broke UTF-8 or version")
		}
		assembled += body
		if !boolValue(chunk["hasMore"]) {
			break
		}
		next := int(numberInt64(chunk["nextOffset"]))
		if next <= offset {
			t.Fatal("text cursor did not advance")
		}
		offset = next
	}
	if assembled != text {
		t.Fatal("chunked body changed original text")
	}
	boundary := conversationRequest(server, "/api/sessions/conversation/conversation-messages/long-body/text?offset=1")
	var aligned map[string]any
	_ = json.Unmarshal(boundary.Body.Bytes(), &aligned)
	if !strings.HasPrefix(stringValue(aligned["text"]), "汉字") {
		t.Fatal("mid-rune offset was not aligned")
	}
	session.patchMessage("long-body", map[string]any{"text": "short revised body"})
	stale := conversationRequest(server, "/api/sessions/conversation/conversation-messages/long-body/text?version="+version)
	if stale.Code != http.StatusConflict {
		t.Fatal("stale body version accepted")
	}
	if conversationRequest(server, "/api/sessions/conversation/conversation-messages/missing/text").Code != http.StatusNotFound {
		t.Fatal("unknown text message accepted")
	}
}

func TestConversationNonBodyTextDefersWithoutExposingPrivateFields(t *testing.T) {
	for _, item := range []struct{ provider, sessionKind, messageKind string }{
		{"claude-code", "claude-structured", "tool-result"},
		{"claude-code", "claude-structured", "reasoning"},
		{"claude-code", "claude-structured", "event"},
		{"codex", "codex-structured", "event"},
		{"antigravity", "antigravity-structured", "event"},
	} {
		t.Run(item.provider+"/"+item.messageKind, func(t *testing.T) {
			session, server := conversationFixture(t, 0)
			session.Kind, session.Tool.Key = item.sessionKind, item.provider
			text := strings.Repeat("原始输出🌙", 2500) + "ORIGINAL_END"
			message := map[string]any{"id": "deferred-output", "kind": item.messageKind, "text": text, "agentText": "PRIVATE_AGENT_TEXT"}
			if item.provider == "claude-code" {
				message["raw"] = map[string]any{"secret": "PRIVATE_CLAUDE_RAW"}
			}
			session.appendMessage(message)
			session.mu.RLock()
			page, err := session.conversationPageLocked("", 0)
			session.mu.RUnlock()
			if err != nil {
				t.Fatal(err)
			}
			var output map[string]any
			for _, candidate := range page["messages"].([]map[string]any) {
				if candidate["id"] == "deferred-output" {
					output = candidate
				}
			}
			if output["textDeferred"] != true || len(stringValue(output["text"])) > conversationPreviewBytes || output["agentText"] != nil || output["raw"] != nil {
				t.Fatal("non-body preview lost deferred text or exposed private fields")
			}
			response := conversationRequest(server, "/api/sessions/conversation/conversation-messages/deferred-output/text?version="+stringValue(output["textVersion"]))
			if response.Code != http.StatusOK {
				t.Fatal("deferred output is not readable")
			}
			var chunk map[string]any
			_ = json.Unmarshal(response.Body.Bytes(), &chunk)
			if !strings.HasPrefix(text, stringValue(chunk["text"])) || !utf8.ValidString(stringValue(chunk["text"])) {
				t.Fatal("deferred output changed text")
			}
		})
	}
	for _, kind := range []string{"codex-structured", "antigravity-structured"} {
		session, _ := conversationFixture(t, 0)
		session.Kind = kind
		session.appendMessage(map[string]any{"id": "lazy-tool", "kind": "tool", "result": "PRIVATE_TOOL_OUTPUT", "input": map[string]any{"secret": "PRIVATE_TOOL_INPUT"}, "agentText": "PRIVATE_AGENT_TEXT"})
		session.mu.RLock()
		page, _ := session.conversationPageLocked("", 0)
		session.mu.RUnlock()
		encoded, _ := json.Marshal(page)
		if strings.Contains(string(encoded), "PRIVATE_") {
			t.Fatal("paging exposed existing private tool detail fields")
		}
	}
}

func TestConversationOversizedMetadataRetainsOnePublicRecordWithoutSilentFieldLoss(t *testing.T) {
	session, _ := conversationFixture(t, 0)
	session.Kind, session.Tool.Key = "claude-structured", "claude-code"
	input := strings.Repeat("large input ", 30000)
	session.appendMessage(map[string]any{"id": "before-metadata", "kind": "assistant", "text": "Earlier reply"})
	session.appendMessage(map[string]any{"id": "large-metadata", "kind": "tool", "name": "Write", "input": map[string]any{"content": input}, "raw": "PRIVATE_RAW", "agentText": "PRIVATE_AGENT_TEXT"})
	session.mu.RLock()
	page, err := session.conversationPageLocked("", 0)
	session.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	messages := page["messages"].([]map[string]any)
	metadata := mapValue(page["historyPage"])
	if len(messages) != 1 || metadata["oversizedMetadata"] != true || stringValue(mapValue(messages[0]["input"])["content"]) != input {
		t.Fatal("large public metadata was silently removed or combined with other rows")
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), "PRIVATE_") {
		t.Fatal("metadata exception exposed hidden provider fields")
	}
	session.mu.RLock()
	previous, err := session.conversationPageLocked(stringValue(metadata["beforeCursor"]), 0)
	session.mu.RUnlock()
	if err != nil || len(previous["messages"].([]map[string]any)) != 2 || mapValue(previous["historyPage"])["oversizedMetadata"] != false {
		t.Fatal("metadata exception lost the earlier history or leaked into normal pages")
	}
	// Providers with an existing lazy tool reader keep the normal page budget.
	session.Kind, session.Tool.Key = "antigravity-structured", "antigravity"
	session.appendMessage(map[string]any{"id": "large-command", "kind": "tool", "command": input})
	session.mu.RLock()
	page, err = session.conversationPageLocked("", 1)
	session.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	messages = page["messages"].([]map[string]any)
	encoded, _ = json.Marshal(messages)
	if len(encoded) > conversationPageBytes || messages[0]["hasDetail"] != true || messages[0]["command"] != nil || mapValue(page["historyPage"])["oversizedMetadata"] != false {
		t.Fatal("existing lazy tool details no longer protect the page budget")
	}
}

func TestConversationResetProjectionCoalescesBufferedEventsAtItsAtomicRevision(t *testing.T) {
	session, _ := conversationFixture(t, 20)
	subscription, snapshot := session.subscribeConversation(32, true)
	defer subscription.Close()
	window := newConversationEventWindow(session, true, snapshot)
	session.replaceMessages(append([]map[string]any{}, session.Messages...))
	reset := <-subscription.Events()
	session.appendMessage(map[string]any{"id": "included-in-reset", "kind": "assistant", "text": strings.Repeat("latest", 2000)})
	buffered := <-subscription.Events()
	session.mu.Lock()
	session.Name = "Renamed after reset"
	session.HasUnreadCompletion, session.CompletionRevision = true, 88
	session.publishLocked(map[string]any{"type": "session-renamed", "name": session.Name})
	session.publishLocked(map[string]any{"type": "completion", "revision": session.CompletionRevision})
	session.mu.Unlock()
	rename, completion := <-subscription.Events(), <-subscription.Events()
	projected := window.project(reset.Payload)
	if stringValue(projected["type"]) != "history-reset" || len(projected["messages"].([]map[string]any)) > conversationPageMessages || projected["pendingQuestions"] == nil {
		t.Fatal("reset was not a bounded authoritative projection")
	}
	if projected["outputRevision"] != session.outputRevision || mapValue(projected["historyPage"])["revision"] != session.outputRevision {
		t.Fatal("reset revision did not cover its captured state")
	}
	if window.project(buffered.Payload) != nil {
		t.Fatal("already included buffered event was replayed over reset")
	}
	if projected["name"] != "Renamed after reset" || projected["hasUnreadCompletion"] != true || numberInt64(projected["completionRevision"]) != 88 {
		t.Fatal("coalescing reset lost a newer name or completion acknowledgement")
	}
	if window.project(rename.Payload) != nil || window.project(completion.Payload) != nil {
		t.Fatal("fully represented name/completion events were replayed after reset")
	}
	session.appendMessage(map[string]any{"id": "after-reset", "kind": "assistant", "text": "New after reset"})
	next := window.project((<-subscription.Events()).Payload)
	if stringValue(mapValue(next["message"])["id"]) != "after-reset" {
		t.Fatal("new event after the reset was dropped")
	}
	legacy := newConversationEventWindow(session, false, nil)
	if legacy.project(reset.Payload)["messages"] == nil {
		t.Fatal("legacy reset changed")
	}
}

func TestConversationNativeIdentityStateChangeRefreshesTailAndCursor(t *testing.T) {
	for _, item := range []struct{ provider, kind, initialField, changedField string }{
		{"codex", "codex-structured", "threadId", "threadId"},
		{"antigravity", "antigravity-structured", "nativeConversationId", "nativeConversationId"},
		// A fork can initially report only its source resume ID. Its real
		// native ID may arrive later in a state event without a history reset.
		{"claude-code", "claude-structured", "resumeSessionId", "claudeSessionId"},
	} {
		t.Run(item.provider, func(t *testing.T) {
			session, server := conversationFixture(t, 20)
			session.Kind, session.Tool.Key = item.kind, item.provider
			session.State = map[string]any{"status": "idle", item.initialField: "native-a"}
			session.Permissions["pending"] = Permission{ID: "pending", Status: "pending", TurnID: "turn-0"}
			subscription, initial := session.subscribeConversation(32, true)
			defer subscription.Close()
			window := newConversationEventWindow(session, true, initial)
			oldCursor := stringValue(mapValue(initial["historyPage"])["beforeCursor"])
			session.setState(map[string]any{"status": "running"})
			ordinary := window.project((<-subscription.Events()).Payload)
			if ordinary["type"] != "state" || ordinary["messages"] != nil {
				t.Fatal("ordinary state rebuilt the history window")
			}
			session.mu.Lock()
			session.Name, session.HasUnreadCompletion, session.CompletionRevision = "Identity B", true, 88
			session.mu.Unlock()
			session.setState(map[string]any{item.changedField: "native-b"})
			reset := window.project((<-subscription.Events()).Payload)
			if reset["type"] != "history-reset" || window.native != "native-b" || stringValue(mapValue(reset["historyPage"])["epoch"]) == stringValue(mapValue(initial["historyPage"])["epoch"]) {
				t.Fatal("native identity changed without refreshing the tail epoch")
			}
			if reset["name"] != "Identity B" || reset["hasUnreadCompletion"] != true || reset["completionRevision"] != uint64(88) || len(reset["pendingQuestions"].([]map[string]any)) != 1 || len(reset["pendingPermissions"].([]Permission)) != 1 {
				t.Fatal("identity refresh lost authoritative metadata or interactions")
			}
			newCursor := stringValue(mapValue(reset["historyPage"])["beforeCursor"])
			if conversationRequest(server, "/api/sessions/conversation/conversation?before="+oldCursor).Code != http.StatusConflict {
				t.Fatal("old identity cursor remained usable")
			}
			if conversationRequest(server, "/api/sessions/conversation/conversation?before="+newCursor).Code != http.StatusOK {
				t.Fatal("new identity cursor was not usable")
			}
			session.setState(map[string]any{"status": "idle"})
			ordinary = window.project((<-subscription.Events()).Payload)
			if ordinary["type"] != "state" || ordinary["messages"] != nil {
				t.Fatal("refreshed identity caused repeated full history resets")
			}
		})
	}
}

func TestConversationRecoveredIdentityAndHistoryShareOneCursorEpoch(t *testing.T) {
	session, _ := conversationFixture(t, 20)
	messages := make([]map[string]any, len(session.Messages))
	for index, message := range session.Messages {
		messages[index] = cloneMap(message)
		messages[index]["threadId"] = "new-native-conversation"
	}
	session.replaceMessagesWithState(messages, map[string]any{"threadId": "new-native-conversation", "nativeConversationId": "new-native-conversation"})
	subscription, snapshot := session.subscribeConversation(8, true)
	defer subscription.Close()
	if mapValue(snapshot["state"])["nativeConversationId"] != "new-native-conversation" {
		t.Fatal("recovered messages were published with the previous native identity")
	}
	session.mu.RLock()
	page, err := session.conversationPageLocked(stringValue(mapValue(snapshot["historyPage"])["beforeCursor"]), 0)
	session.mu.RUnlock()
	if err != nil || mapValue(page["historyPage"])["epoch"] != mapValue(snapshot["historyPage"])["epoch"] {
		t.Fatalf("fresh recovery cursor became stale before any later event: %v", err)
	}
}

func TestConversationLiveReplyKeepsProgressBeyondHistoryPreviewBoundary(t *testing.T) {
	session, _ := conversationFixture(t, 1)
	subscription, snapshot := session.subscribeConversation(8, true)
	defer subscription.Close()
	window := newConversationEventWindow(session, true, snapshot)
	text := strings.Repeat("Live streamed text. ", 1000) + "END_OF_CURRENT_OUTPUT"
	session.appendMessage(map[string]any{"id": "large-current-reply", "kind": "assistant", "text": text, "streaming": true})
	projected := window.project((<-subscription.Events()).Payload)
	message := mapValue(projected["message"])
	if message["text"] != text || boolValue(message["textDeferred"]) {
		t.Fatal("active reply stopped progressing at the historical preview boundary")
	}
	session.mu.RLock()
	page, err := session.conversationPageLocked("", 0)
	session.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	history := page["messages"].([]map[string]any)
	last := history[len(history)-1]
	if !boolValue(last["textDeferred"]) || len(stringValue(last["text"])) > conversationPreviewBytes {
		t.Fatal("a future history read bypassed the preview body budget")
	}
}

func TestConversationWebsocketTailIsOptInAndResetsStayBounded(t *testing.T) {
	session, server := conversationFixture(t, 20)
	host := httptest.NewServer(http.HandlerFunc(server.websocket))
	defer host.Close()
	for _, tail := range []bool{false, true} {
		query := "?sessionId=conversation"
		if tail {
			query += "&history=tail"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http")+query, &websocket.DialOptions{CompressionMode: websocket.CompressionNoContextTakeover})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		defer connection.CloseNow()
		connection.SetReadLimit(1 << 20)
		if !strings.Contains(response.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate") {
			t.Fatal("WS compression was not negotiated")
		}
		_, data, err := connection.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if json.Unmarshal(data, &payload) != nil {
			t.Fatal("invalid snapshot JSON")
		}
		snapshot := mapValue(payload["snapshot"])
		want := len(session.Messages)
		if tail {
			want = 60
		}
		if len(sliceValue(snapshot["messages"])) != want || (snapshot["historyPage"] != nil) != tail {
			t.Fatal("WS changed legacy defaults or ignored opt-in")
		}
		session.replaceMessages(append([]map[string]any{}, session.Messages...))
		_, data, err = connection.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if json.Unmarshal(data, &payload) != nil {
			t.Fatal("invalid reset JSON")
		}
		reset := mapValue(payload["event"])
		if stringValue(reset["type"]) != "history-reset" || len(sliceValue(reset["messages"])) != want || (reset["historyPage"] != nil) != tail {
			t.Fatal("reset escaped the subscriber window")
		}
		_ = connection.Close(websocket.StatusNormalClosure, "")
		cancel()
	}
}

func TestConversationWorkbenchRoutesRetainOwnershipAndIdentityEncoding(t *testing.T) {
	_, server := conversationFixture(t, 20)
	bridge := &workbenchBridge{server: server, mux: conversationTestMux(server), ctx: context.Background(), owned: map[string]bool{"conversation": true}}
	response := httptest.NewRecorder()
	err := bridge.serveRequest(response, workbenchMessage{Method: http.MethodGet, Path: "/api/sessions/conversation/conversation", RequestHeaders: map[string]string{"Accept-Encoding": "gzip"}})
	if err != nil || response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "" {
		t.Fatalf("legacy bridge encoding changed: %v / %d", err, response.Code)
	}
	bridge.owned = map[string]bool{}
	if bridge.serveRequest(httptest.NewRecorder(), workbenchMessage{Method: http.MethodGet, Path: "/api/sessions/conversation/conversation"}) == nil {
		t.Fatal("conversation paging bypassed owned-session authorization")
	}
	for _, target := range []string{"/ws?sessionId=conversation&history=tail", "wss://example.invalid/socket?history=tail"} {
		if !conversationTailRequested(target) {
			t.Fatal("bridge socket path lost tail opt-in")
		}
	}
	if conversationTailRequested("/ws?sessionId=conversation") {
		t.Fatal("legacy bridge became paged")
	}
}
