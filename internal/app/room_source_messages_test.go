package app

import "testing"

func TestRoomSourceMessagesRemainStableAfterProviderUpdates(t *testing.T) {
	sessions := NewSessionManager(t.TempDir())
	session := newSession("live-session", "Live", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	t.Cleanup(session.cancel)
	session.State["nativeConversationId"] = "native-conversation"
	session.appendMessage(map[string]any{
		"id": "user", "kind": "user", "turnId": "turn", "threadId": "native-conversation", "text": "Question",
	})
	session.appendMessage(map[string]any{
		"id": "answer", "kind": "assistant", "turnId": "turn", "threadId": "native-conversation", "text": "Partial answer", "streaming": true,
	})
	sessions.sessions[session.ID] = session
	rooms := &RoomManager{sessions: sessions}
	member := RoomMemberRecord{RuntimeSessionID: session.ID, NativeConversationID: "native-conversation"}
	source, conversationID, available := rooms.roomMemberSourceMessages(member)
	if !available || conversationID != "native-conversation" || len(source) != 2 {
		t.Fatalf("unexpected source: available=%v conversation=%q messages=%d", available, conversationID, len(source))
	}

	// Projection continues after roomMemberSourceMessages releases session.mu.
	// A provider completing the stream must not mutate that reader's snapshot.
	session.patchMessage("answer", map[string]any{"text": "Complete answer", "streaming": false, "completedAtMs": int64(1234)})
	turns := roomConversationTurns(source)
	if len(turns) != 1 || turns[0].AssistantText != "Partial answer" || source[1].Message["streaming"] != true {
		t.Fatalf("provider update changed an unlocked room source: %#v", source)
	}
	latest, _, _ := rooms.roomMemberSourceMessages(member)
	if roomConversationTurns(latest)[0].AssistantText != "Complete answer" {
		t.Fatal("a fresh projection did not receive the completed answer")
	}
	source[1].Message["text"] = "Reader-local change"
	latest, _, _ = rooms.roomMemberSourceMessages(member)
	if roomConversationTurns(latest)[0].AssistantText != "Complete answer" {
		t.Fatal("a room reader mutated the provider's message")
	}
}
