package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestRoomPagesBoundHistoryAndKeepReferenceResolution(t *testing.T) {
	manager, session, _, room, member := newRuntimeRoomTest(t)
	provider := &stubProvider{}
	session.Provider = provider
	for i := 0; i < 180; i++ {
		turn := fmt.Sprintf("turn-%03d", i)
		session.appendMessage(map[string]any{"kind": "user", "turnId": turn, "text": "question " + turn, "createdAt": int64(i*2 + 1)})
		session.appendMessage(map[string]any{"kind": "assistant", "turnId": turn, "text": strings.Repeat("answer", 6000), "createdAt": int64(i*2 + 2)})
	}
	latest, err := manager.GetPage(room.ID, false, roomPageQuery{})
	if err != nil {
		t.Fatal(err)
	}
	entries := latest["entries"].([]map[string]any)
	if len(entries) != roomPageSize || !boolValue(latest["hasBefore"]) || boolValue(latest["hasAfter"]) || !boolValue(entries[len(entries)-1]["textTruncated"]) {
		t.Fatalf("unbounded/incorrect page: %d", len(entries))
	}
	page, err := manager.GetPage(room.ID, false, roomPageQuery{Before: stringValue(entries[0]["id"])})
	if err != nil {
		t.Fatal(err)
	}
	older := page["entries"].([]map[string]any)
	if len(older) != roomPageSize || !boolValue(page["hasAfter"]) || numberInt64(older[len(older)-1]["sequence"]) >= numberInt64(entries[0]["sequence"]) {
		t.Fatal("history pages overlapped")
	}
	if _, err := manager.PostMessage(context.Background(), room.ID, RoomMessageInput{Text: "use old answer", MentionedMemberIDs: []string{member.ID}, QuotedEntryIDs: []string{stringValue(older[1]["id"])}}); err != nil {
		t.Fatal(err)
	}
	if len(provider.inputs) != 1 || !strings.Contains(provider.inputs[0].AgentText, strings.Repeat("answer", 6000)) {
		t.Fatal("off-page reference was not delivered in full")
	}
}

func TestCloseRoomCleansOnlyIdleUnsharedCurrentMembers(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	first, _ := manager.Create("first")
	second, _ := manager.Create("second")
	for _, id := range []string{"idle", "shared", "running", "waiting", "reserved", "removed", "sending"} {
		session := newSession(id, id, "codex-structured", ToolInfo{Key: "codex"}, directory)
		session.Provider = &stubProvider{}
		sessions.sessions[id] = session
		member, err := manager.AddSession(first.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		switch id {
		case "shared":
			_, _ = manager.AddSession(second.ID, id)
		case "running":
			session.StatusValue = "running"
		case "waiting":
			session.State["pendingQuestionCount"] = 1
		case "reserved":
			session.supervisorLease = "active-invocation"
		case "removed":
			_ = manager.RemoveMember(first.ID, member.ID)
		case "sending":
			session.commandMu.Lock()
			t.Cleanup(session.commandMu.Unlock)
		}
	}
	if err := manager.Close(first.ID); err != nil {
		t.Fatal(err)
	}
	if sessions.Get("idle") != nil {
		t.Fatal("orphan idle session survived")
	}
	for _, id := range []string{"shared", "running", "waiting", "reserved", "removed", "sending"} {
		if sessions.Get(id) == nil {
			t.Fatalf("closed protected session %s", id)
		}
	}
	if _, err := manager.GetHistoryRecord(first.ID); err != nil {
		t.Fatal("saved history lost", err)
	}
}

func TestRoomReferenceOverflowDoesNotSilentlyDropContent(t *testing.T) {
	manager, session, _, room, member := newRuntimeRoomTest(t)
	session.appendMessage(map[string]any{"kind": "user", "turnId": "large", "text": "large request", "createdAt": int64(1)})
	session.appendMessage(map[string]any{"kind": "assistant", "turnId": "large", "text": strings.Repeat("x", maxRoomReferenceBytes+1), "createdAt": int64(2)})
	_, err := manager.PostMessage(context.Background(), room.ID, RoomMessageInput{Text: "use this", MentionedMemberIDs: []string{member.ID}, QuotedEntryIDs: []string{roomHistoryEntryID(member.ID, "large", "assistant")}})
	if err == nil || !strings.Contains(err.Error(), "128 KiB") {
		t.Fatal("oversized reference was silently replaced", err)
	}
	saved, err := manager.GetRecord(room.ID)
	if err != nil || len(saved.Entries) != 0 {
		t.Fatal("rejected reference was persisted", err)
	}
}

func TestRoomProjectionCacheSurvivesToolEventsAndRefreshesReplies(t *testing.T) {
	manager, session, _, room, _ := newRuntimeRoomTest(t)
	session.appendMessage(map[string]any{"id": "user", "kind": "user", "turnId": "turn", "text": "question", "createdAt": int64(1)})
	session.appendMessage(map[string]any{"id": "assistant", "kind": "assistant", "turnId": "turn", "text": "first answer", "createdAt": int64(2)})
	_, err := manager.GetPage(room.ID, false, roomPageQuery{})
	if err != nil {
		t.Fatal(err)
	}
	cache := manager.projections[room.ID]
	session.appendMessage(map[string]any{"kind": "tool", "turnId": "turn", "text": "tool output"})
	session.setState(map[string]any{"status": "running"})
	_, err = manager.GetPage(room.ID, false, roomPageQuery{})
	if err != nil || manager.projections[room.ID].Key != cache.Key {
		t.Fatal("irrelevant tool/state events rebuilt complete history", err)
	}
	session.patchMessage("assistant", map[string]any{"text": "updated answer"})
	page, err := manager.GetPage(room.ID, false, roomPageQuery{})
	if err != nil || stringValue(page["entries"].([]map[string]any)[1]["text"]) != "updated answer" {
		t.Fatal("reply update was cached away", err)
	}
}
