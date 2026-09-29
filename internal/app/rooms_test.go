package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRoomStorePersistsVersionedRoomsIndependently(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	room := RoomRecord{
		SchemaVersion: currentRoomSchemaVersion, ID: newUUID(), Name: "Architecture",
		CreatedAt: 1, UpdatedAt: 2, NextSequence: 1,
	}
	if err := store.Save(room); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := reopened.Get(room.ID)
	if err != nil || loaded.Name != room.Name || loaded.SchemaVersion != currentRoomSchemaVersion {
		t.Fatalf("loaded room = %#v, err=%v", loaded, err)
	}
	data, err := os.ReadFile(filepath.Join(directory, room.ID+".json"))
	if err != nil || !strings.Contains(string(data), `"schemaVersion": 1`) {
		t.Fatalf("versioned room file is invalid: %v %s", err, data)
	}
}

func TestRoomStoreRejectsFutureSchemaWithoutOverwriting(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	id := newUUID()
	path := filepath.Join(directory, id+".json")
	original := []byte(`{"schemaVersion":999,"id":"` + id + `","name":"future"}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(id); !errors.Is(err, errRoomSchemaTooNew) {
		t.Fatalf("future schema error = %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(original) {
		t.Fatal("future room file was modified")
	}
}

func TestRoomDispatchInjectsQuotesWithoutPersistingAssistantText(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession("room-session", "Reviewer", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	provider := &stubProvider{}
	session.Provider = provider
	session.events = sessions.events
	session.State["threadId"] = "native-thread"
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, err := manager.Create("Review room")
	if err != nil {
		t.Fatal(err)
	}
	member, err := manager.AddSession(room.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PostMessage(context.Background(), room.ID, RoomMessageInput{
		Text: "first question", MentionedMemberIDs: []string{member.ID},
	}); err != nil {
		t.Fatal(err)
	}
	record, _ := store.Get(room.ID)
	if len(record.Entries) != 2 || len(provider.inputs) != 1 {
		t.Fatalf("first dispatch: entries=%#v inputs=%#v", record.Entries, provider.inputs)
	}
	reply := record.Entries[1]
	session.Messages = append(session.Messages,
		map[string]any{"kind": "user", "clientMessageId": reply.ClientMessageID, "turnId": "turn-1", "text": "first question"},
		map[string]any{"kind": "assistant", "turnId": "turn-1", "text": "private resolved answer"},
		map[string]any{"kind": "turn-end", "turnId": "turn-1", "status": "completed"},
	)
	if err := manager.mutate(room.ID, func(room *RoomRecord) error {
		room.Entries[1].NativeTurnID = "turn-1"
		room.Entries[1].Status = "completed"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PostMessage(context.Background(), room.ID, RoomMessageInput{
		Text: "review it", MentionedMemberIDs: []string{member.ID}, QuotedEntryIDs: []string{reply.ID},
	}); err != nil {
		t.Fatal(err)
	}
	if len(provider.inputs) != 2 || !strings.Contains(provider.inputs[1].AgentText, "private resolved answer") {
		t.Fatalf("quoted assistant answer was not injected: %#v", provider.inputs)
	}
	raw, err := os.ReadFile(filepath.Join(directory, "rooms", room.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private resolved answer") {
		t.Fatal("assistant text leaked into room persistence")
	}
	var saved RoomRecord
	if err := json.Unmarshal(raw, &saved); err != nil || saved.SchemaVersion != 1 {
		t.Fatalf("persisted room is invalid: %v", err)
	}
}

func TestRoomCapturesMessagesSentInsideMemberSession(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession("direct-session", "Direct", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	session.Provider = &stubProvider{}
	session.State["threadId"] = "direct-thread"
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, _ := manager.Create("Direct room")
	member, err := manager.AddSession(room.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager.captureDirectSessionMessage(session.ID, map[string]any{
		"kind": "user", "text": "sent from mini session",
		"turnId": "direct-turn", "clientMessageId": "direct-client",
	})
	record, err := store.Get(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(record.Entries) != 2 || record.Entries[0].UserText != "sent from mini session" ||
		record.Entries[1].MemberID != member.ID || record.Entries[1].ClientMessageID != "direct-client" {
		t.Fatalf("direct session message was not indexed: %#v", record.Entries)
	}
	manager.captureDirectSessionMessage(session.ID, map[string]any{
		"kind": "user", "text": "duplicate", "clientMessageId": "direct-client",
	})
	record, _ = store.Get(room.ID)
	if len(record.Entries) != 2 {
		t.Fatalf("duplicate direct message created more entries: %#v", record.Entries)
	}
}

func TestRoomMemberAvatarColorsAreProviderScopedAndPersistent(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	for _, item := range []struct{ id, name, tool, kind string }{
		{id: "warm", name: "Codex", tool: "codex", kind: "codex-structured"},
		{id: "cold", name: "克劳德", tool: "claude-code", kind: "claude-structured"},
	} {
		session := newSession(item.id, item.name, item.kind, ToolInfo{Key: item.tool, DisplayName: item.name}, directory)
		session.Provider = &stubProvider{}
		sessions.sessions[session.ID] = session
	}
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, _ := manager.Create("Colors")
	warm, err := manager.AddSession(room.ID, "warm")
	if err != nil {
		t.Fatal(err)
	}
	cold, err := manager.AddSession(room.ID, "cold")
	if err != nil {
		t.Fatal(err)
	}
	contains := func(values []string, wanted string) bool {
		for _, value := range values {
			if value == wanted {
				return true
			}
		}
		return false
	}
	if !contains(roomAvatarPalettes["codex"], warm.AvatarColor) {
		t.Fatalf("Codex avatar color %q is not warm", warm.AvatarColor)
	}
	if !contains(roomAvatarPalettes["claude-code"], cold.AvatarColor) {
		t.Fatalf("Claude avatar color %q is not cold", cold.AvatarColor)
	}
	reopened, _ := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	loaded, err := reopened.Get(room.ID)
	if err != nil || loaded.Members[0].AvatarColor != warm.AvatarColor || loaded.Members[1].AvatarColor != cold.AvatarColor {
		t.Fatalf("avatar colors were not persistent: %#v err=%v", loaded.Members, err)
	}
}

func TestRoomNotificationPreferenceIsPersistentAndIndependentFromSession(t *testing.T) {
	directory := t.TempDir()
	store, _ := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	sessions := NewSessionManager(directory)
	session := newSession("notify-session", "Notify", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	session.Provider = &stubProvider{}
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, _ := manager.Create("Notify room")
	if _, err := manager.AddSession(room.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.SetServerChanNotification(room.ID, true); err != nil {
		t.Fatal(err)
	}
	loaded, _ := store.Get(room.ID)
	if !loaded.ServerChanNotificationEnabled {
		t.Fatal("room notification preference was not persisted")
	}
	session.mu.RLock()
	sessionEnabled := session.ServerChanNotificationEnabled
	session.mu.RUnlock()
	if sessionEnabled {
		t.Fatal("room notification preference changed the session preference")
	}
}

func TestRoomNotificationTargetsReportCurrentBatchProgress(t *testing.T) {
	store, _ := OpenRoomStoreAt(t.TempDir())
	room := RoomRecord{
		SchemaVersion: currentRoomSchemaVersion, ID: newUUID(), Name: "Review group",
		CreatedAt: 1, UpdatedAt: 1, NextSequence: 5, ServerChanNotificationEnabled: true,
		Members: []RoomMemberRecord{
			{ID: "member-a", RuntimeSessionID: "session-a", DisplayName: "Alpha", ToolKey: "codex", ToolName: "Codex"},
			{ID: "member-b", RuntimeSessionID: "session-b", DisplayName: "Beta", ToolKey: "claude-code", ToolName: "Claude"},
			{ID: "member-c", RuntimeSessionID: "session-c", DisplayName: "Gamma", ToolKey: "codex", ToolName: "Codex"},
		},
		Entries: []RoomEntryRecord{
			{ID: "user", Sequence: 1, Type: "user", UserText: "Review this", Status: "completed"},
			{ID: "a", Sequence: 2, Type: "session", MemberID: "member-a", SourceSessionID: "session-a", NativeTurnID: "turn-a", Status: "completed"},
			{ID: "b", Sequence: 3, Type: "session", MemberID: "member-b", SourceSessionID: "session-b", NativeTurnID: "turn-b", Status: "running"},
			{ID: "c", Sequence: 4, Type: "session", MemberID: "member-c", SourceSessionID: "session-c", NativeTurnID: "turn-c", Status: "pending"},
		},
	}
	if err := store.Save(room); err != nil {
		t.Fatal(err)
	}
	manager := NewRoomManager(store, NewSessionManager(t.TempDir()), NewAttachmentStore())
	targets := manager.NotificationTargets("session-b", "turn-b", true)
	if len(targets) != 1 {
		t.Fatalf("notification targets = %#v", targets)
	}
	target := targets[0]
	if target.MemberName != "Beta" || target.ToolName != "Claude" || target.ActiveMembers != 3 || target.RoundTotal != 3 || target.RoundCompleted != 2 {
		t.Fatalf("wrong notification progress: %#v", target)
	}
}
