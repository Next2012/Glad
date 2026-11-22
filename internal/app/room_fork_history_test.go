package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRoomForkRetainsVerifiedSourceHistoryWhenNewNativeRuntimeReturnsNoTurns(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node is required for the Codex process fixture")
	}
	bin, err := filepath.Abs("../../tests/e2e/fixtures/bin")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CODEX_HOME", t.TempDir())
	directory := t.TempDir()
	manager := NewSessionManager(directory)
	source := newSession("verified-source", "Reviewer", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	t.Cleanup(source.cancel)
	source.State["threadId"] = "thread-e2e"
	manager.sessions[source.ID] = source
	for turn := 1; turn <= 3; turn++ {
		turnID := fmt.Sprintf("source-turn-%d", turn)
		for _, item := range []struct{ kind, text string }{
			{"turn-start", ""}, {"user", fmt.Sprintf("source question %d", turn)},
			{"assistant", fmt.Sprintf("source answer %d", turn)}, {"turn-end", ""},
		} {
			source.appendMessage(map[string]any{"id": fmt.Sprintf("%s-%d", item.kind, turn), "kind": item.kind, "text": item.text,
				"threadId": "thread-e2e", "turnId": turnID, "isRootTurn": true, "turnStatus": "completed"})
		}
	}
	store, err := OpenRoomStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rooms := NewRoomManager(store, manager, NewAttachmentStore())
	room, err := rooms.Create("Fork source history")
	if err != nil {
		t.Fatal(err)
	}
	member := RoomMemberRecord{ID: "reviewer", ToolKey: "codex", ToolName: "Codex", RuntimeSessionID: source.ID,
		NativeConversationID: "thread-e2e", WorkingDirectory: directory}
	room.Members = []RoomMemberRecord{member}
	room.Entries = []RoomEntryRecord{
		{ID: "room-user-1", Type: "user", UserText: "room question 1", Sequence: 1, Status: "completed"},
		{ID: "room-answer-1", Type: "session", MemberID: member.ID, SourceSessionID: source.ID, NativeConversationID: "thread-e2e", NativeTurnID: "source-turn-1", Sequence: 2, Status: "completed"},
		{ID: "standalone-room-message", Type: "user", UserText: "A room-only message", Sequence: 3, Status: "completed"},
		{ID: "room-user-2", Type: "user", UserText: "room question 2", Sequence: 4, Status: "completed"},
		{ID: "room-answer-2", Type: "session", MemberID: member.ID, SourceSessionID: source.ID, NativeConversationID: "thread-e2e", NativeTurnID: "source-turn-2", Sequence: 5, Status: "completed"},
	}
	room.NextSequence = 6
	if err := store.Save(room); err != nil {
		t.Fatal(err)
	}
	forked, err := rooms.CopyHistory(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{sessions: manager, rooms: rooms}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	destination, err := server.recreateRoomMember(ctx, member, true, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Delete(context.Background(), destination.ID) })
	nativeID := sessionConversationID(destination)
	if !strings.HasPrefix(nativeID, "fork-of-") || destination.ID == source.ID {
		t.Fatal("fork did not create an independent runtime/native identity")
	}
	if err := rooms.BindRuntimeSession(forked.ID, member.ID, destination.ID, nativeID); err != nil {
		t.Fatal(err)
	}
	forked, err = store.Get(forked.ID)
	if err != nil {
		t.Fatal(err)
	}
	rooms.mu.Lock()
	entries := rooms.projectRoomEntriesLocked(forked)
	rooms.mu.Unlock()
	if len(entries) != 7 {
		t.Fatalf("fork lost provider-owned/direct-session history: got %d entries, want 7", len(entries))
	}
	answers := map[string]bool{}
	for _, entry := range entries {
		if entry.Type == "session" {
			answers[entry.ResolvedText] = true
		}
	}
	for turn := 1; turn <= 3; turn++ {
		if !answers[fmt.Sprintf("source answer %d", turn)] {
			t.Fatalf("fork lost source answer %d", turn)
		}
	}
	if source.State["threadId"] != "thread-e2e" || len(source.Messages) != 12 {
		t.Fatal("fork changed its source runtime")
	}
}
