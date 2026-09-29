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
	if err != nil || !strings.Contains(string(data), `"schemaVersion": 2`) {
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
	if origin, roomClient := roomClientOrigin(reply.ClientMessageID); !roomClient || origin != room.ID ||
		reply.OriginRoomID != room.ID || !strings.Contains(provider.inputs[0].AgentText, "<glad_group_origin>\n"+room.ID) {
		t.Fatalf("room provenance was not persisted and transported: reply=%#v input=%#v", reply, provider.inputs[0])
	}
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
	if err := json.Unmarshal(raw, &saved); err != nil || saved.SchemaVersion != currentRoomSchemaVersion {
		t.Fatalf("persisted room is invalid: %v", err)
	}
}

func TestRoomDraftEndsOnFirstDurableEdit(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession("draft-session", "Member", "codex-structured", ToolInfo{Key: "codex"}, directory)
	session.Provider = &stubProvider{}
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	discardedDraft, _ := manager.Create("New group")
	if err := manager.DeleteDraft(discardedDraft.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(discardedDraft.ID); !errors.Is(err, errRoomNotFound) {
		t.Fatalf("empty draft still exists: %v", err)
	}

	memberDraft, _ := manager.Create("New group")
	if !memberDraft.Draft {
		t.Fatal("new room was not marked as a draft")
	}
	if _, err := manager.AddSession(memberDraft.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	memberRoom, _ := store.Get(memberDraft.ID)
	if memberRoom.Draft {
		t.Fatal("adding the first member did not finalize the draft")
	}
	if err := manager.DeleteDraft(memberDraft.ID); err == nil {
		t.Fatal("draft cleanup deleted a room with a member")
	}

	renameDraft, _ := manager.Create("New group")
	if err := manager.Rename(renameDraft.ID, "Named room"); err != nil {
		t.Fatal(err)
	}
	renamed, _ := store.Get(renameDraft.ID)
	if renamed.Draft {
		t.Fatal("renaming the room did not finalize the draft")
	}

	messageDraft, _ := manager.Create("New group")
	if _, err := manager.PostMessage(context.Background(), messageDraft.ID, RoomMessageInput{Text: "keep this room"}); err != nil {
		t.Fatal(err)
	}
	messaged, _ := store.Get(messageDraft.ID)
	if messaged.Draft {
		t.Fatal("sending a room message did not finalize the draft")
	}
}

func TestRoomProjectsPreJoinHistoryAndLoadsContextWithoutPersistingIt(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession("history-session", "Historian", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	provider := &stubProvider{}
	session.Provider = provider
	session.State["threadId"] = "history-thread"
	session.Messages = []map[string]any{
		{"id": "start-1", "kind": "turn-start", "threadId": "history-thread", "turnId": "turn-1", "createdAt": int64(100)},
		{"id": "user-1", "kind": "user", "threadId": "history-thread", "turnId": "turn-1", "text": "question before joining", "createdAt": int64(100)},
		{"id": "reason-1", "kind": "reasoning", "threadId": "history-thread", "turnId": "turn-1", "text": "private detail", "createdAt": int64(101)},
		{"id": "answer-1", "kind": "assistant", "threadId": "history-thread", "turnId": "turn-1", "text": "answer before joining", "createdAt": int64(102)},
		{"id": "end-1", "kind": "turn-end", "threadId": "history-thread", "turnId": "turn-1", "status": "completed", "createdAt": int64(103)},
		{"id": "user-2", "kind": "user", "threadId": "history-thread", "turnId": "turn-2", "text": "second question", "createdAt": int64(200)},
		{"id": "answer-2", "kind": "assistant", "threadId": "history-thread", "turnId": "turn-2", "text": "second answer", "createdAt": int64(202)},
		{"id": "end-2", "kind": "turn-end", "threadId": "history-thread", "turnId": "turn-2", "status": "completed", "createdAt": int64(203)},
	}
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	room, _ := manager.Create("History room")
	member, err := manager.AddSession(room.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	view, err := manager.GetPublic(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	entries := view["entries"].([]map[string]any)
	if len(entries) != 4 {
		t.Fatalf("projected entries = %#v", entries)
	}
	user := entries[0]
	answer := entries[1]
	if user["text"] != "question before joining" || answer["text"] != "answer before joining" ||
		!boolValue(user["historical"]) || stringValue(answer["sourceTurnId"]) != "turn-1" {
		t.Fatalf("unexpected projected history: %#v", entries)
	}
	mentions := stringsFromAny(user["mentionedMemberIds"])
	if len(mentions) != 1 || mentions[0] != member.ID {
		t.Fatalf("historical user message was not attributed to its member: %#v", user)
	}
	saved, _ := store.Get(room.ID)
	if len(saved.Entries) != 0 {
		t.Fatalf("projected history leaked into persistence: %#v", saved.Entries)
	}
	contextView, err := manager.EntryContext(room.ID, stringValue(answer["id"]), 3, 3)
	if err != nil || len(contextView["turns"].([]map[string]any)) != 2 {
		t.Fatalf("context = %#v, err=%v", contextView, err)
	}
	details, err := manager.EntryTurnDetails(room.ID, stringValue(answer["id"]), "turn-1")
	if err != nil || len(details["messages"].([]map[string]any)) != 5 {
		t.Fatalf("details = %#v, err=%v", details, err)
	}
	if _, err := manager.PostMessage(context.Background(), room.ID, RoomMessageInput{
		Text: "use the selected history", MentionedMemberIDs: []string{member.ID},
		QuotedEntryIDs: []string{stringValue(answer["id"])},
	}); err != nil {
		t.Fatal(err)
	}
	if len(provider.inputs) != 1 || !strings.Contains(provider.inputs[0].AgentText, "answer before joining") {
		t.Fatalf("dynamic historical reference was not delivered: %#v", provider.inputs)
	}
}

func TestRoomSharesCompleteSessionHistoryAcrossGroups(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	session := newSession("transport-session", "Old group member", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, directory)
	session.Provider = &stubProvider{}
	session.State["threadId"] = "transport-thread"
	sessions.sessions[session.ID] = session
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	originRoom, _ := manager.Create("Origin room")
	newRoom, _ := manager.Create("New room")
	session.Messages = []map[string]any{
		{"id": "transport-user", "kind": "user", "threadId": "transport-thread", "turnId": "transport-turn", "text": buildRoomAgentTextForRoom(originRoom.ID, "visible origin group question", nil, nil), "createdAt": int64(100)},
		{"id": "transport-answer", "kind": "assistant", "threadId": "transport-thread", "turnId": "transport-turn", "text": "visible origin group answer", "createdAt": int64(101)},
		{"id": "transport-end", "kind": "turn-end", "threadId": "transport-thread", "turnId": "transport-turn", "status": "completed", "createdAt": int64(102)},
	}
	originMember, err := manager.AddSession(originRoom.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AddSession(newRoom.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	session.Messages = append(session.Messages,
		map[string]any{"id": "legacy-user", "kind": "user", "threadId": "transport-thread", "turnId": "legacy-turn", "text": buildRoomAgentText("legacy origin question", nil, nil), "createdAt": int64(200)},
		map[string]any{"id": "legacy-answer", "kind": "assistant", "threadId": "transport-thread", "turnId": "legacy-turn", "text": "legacy origin answer", "createdAt": int64(201)},
		map[string]any{"id": "legacy-end", "kind": "turn-end", "threadId": "transport-thread", "turnId": "legacy-turn", "status": "completed", "createdAt": int64(202)},
	)
	if err := manager.mutate(originRoom.ID, func(room *RoomRecord) error {
		room.Entries = append(room.Entries,
			RoomEntryRecord{ID: "legacy-room-user", Sequence: room.NextSequence, Type: "user", UserText: "legacy origin question", MentionedMemberIDs: []string{originMember.ID}, Status: "completed", CreatedAt: 200},
			RoomEntryRecord{ID: "legacy-room-answer", Sequence: room.NextSequence + 1, Type: "session", MemberID: originMember.ID, NativeTurnID: "legacy-turn", Status: "completed", CreatedAt: 201},
		)
		room.NextSequence += 2
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	originView, err := manager.GetPublic(originRoom.ID)
	if err != nil {
		t.Fatal(err)
	}
	originEntries := originView["entries"].([]map[string]any)
	if len(originEntries) != 4 || originEntries[0]["text"] != "visible origin group question" || originEntries[1]["text"] != "visible origin group answer" ||
		originEntries[2]["text"] != "legacy origin question" || originEntries[3]["text"] != "legacy origin answer" {
		t.Fatalf("origin group history was not projected: %#v", originEntries)
	}
	if mentions := stringsFromAny(originEntries[0]["mentionedMemberIds"]); len(mentions) != 1 || mentions[0] != originMember.ID {
		t.Fatalf("origin group question lost member attribution: %#v", originEntries[0])
	}
	newView, err := manager.GetPublic(newRoom.ID)
	if err != nil {
		t.Fatal(err)
	}
	newEntries := newView["entries"].([]map[string]any)
	if len(newEntries) != 4 || newEntries[0]["text"] != "visible origin group question" || newEntries[1]["text"] != "visible origin group answer" ||
		newEntries[2]["text"] != "legacy origin question" || newEntries[3]["text"] != "legacy origin answer" {
		t.Fatalf("the new room did not project the member's complete session history: %#v", newEntries)
	}
}

func TestRoomIgnoresAndRepairsInternalTransportMessages(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(filepath.Join(directory, "rooms"))
	if err != nil {
		t.Fatal(err)
	}
	transport := buildRoomAgentText("visible question", nil, nil)
	room := RoomRecord{
		SchemaVersion: 1, ID: newUUID(), Name: "Repair",
		CreatedAt: 1, UpdatedAt: 1, NextSequence: 6,
		Members: []RoomMemberRecord{{ID: "member", RuntimeSessionID: "session", DisplayName: "Agent"}},
		Entries: []RoomEntryRecord{
			{ID: "real", Sequence: 1, Type: "user", UserText: "visible question", Status: "completed", CreatedAt: 10},
			{ID: "real-reply", Sequence: 2, Type: "session", MemberID: "member", ClientMessageID: "room-original", Status: "completed", CreatedAt: 10},
			{ID: "artifact", Sequence: 3, Type: "user", UserText: transport, MentionedMemberIDs: []string{"member"}, Status: "completed", CreatedAt: 11},
			{ID: "artifact-reply", Sequence: 4, Type: "session", MemberID: "member", ClientMessageID: "direct-imported", Status: "completed", CreatedAt: 11},
			{ID: "later", Sequence: 5, Type: "user", UserText: "later", QuotedEntryIDs: []string{"artifact", "real-reply"}, Status: "completed", CreatedAt: 12},
		},
	}
	raw, err := json.MarshalIndent(room, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "rooms", room.ID+".json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Get(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Entries) != 3 || loaded.Entries[0].ID != "real" || loaded.Entries[1].ID != "real-reply" || loaded.Entries[2].ID != "later" {
		t.Fatalf("transport artifacts were not repaired: %#v", loaded.Entries)
	}
	if len(loaded.Entries[2].QuotedEntryIDs) != 1 || loaded.Entries[2].QuotedEntryIDs[0] != "real-reply" {
		t.Fatalf("references to repaired artifacts remain: %#v", loaded.Entries[2].QuotedEntryIDs)
	}
	persisted, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(persisted), `"schemaVersion": 2`) || strings.Contains(string(persisted), "You are being addressed as a member of a Glad group chat.") {
		t.Fatalf("repair was not persisted atomically: err=%v data=%s", err, persisted)
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
