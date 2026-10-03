package app

import "testing"

func TestActiveRoomListIncludesOnlyLiveCurrentMembers(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenRoomStoreAt(directory)
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSessionManager(directory)
	for _, id := range []string{"shared", "removed", "deleted"} {
		sessions.sessions[id] = newSession(id, id, "codex-structured", ToolInfo{Key: "codex"}, directory)
	}
	manager := NewRoomManager(store, sessions, NewAttachmentStore())
	first, _ := manager.Create("First")
	second, _ := manager.Create("Second")
	if _, err := manager.AddSession(first.ID, "shared"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AddSession(second.ID, "shared"); err != nil {
		t.Fatal(err)
	}
	removed, _ := manager.AddSession(first.ID, "removed")
	if err := manager.RemoveMember(first.ID, removed.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AddSession(first.ID, "deleted"); err != nil {
		t.Fatal(err)
	}
	delete(sessions.sessions, "deleted")
	rooms, err := manager.List()
	if err != nil || len(rooms) != 2 {
		t.Fatalf("active groups = %#v, err=%v", rooms, err)
	}
	for _, room := range rooms {
		ids := stringsFromAny(room["sessionIds"])
		if len(ids) != 1 || ids[0] != "shared" {
			t.Fatalf("group listed unavailable or removed sessions: %#v", room)
		}
	}
	if err := manager.Close(first.ID); err != nil {
		t.Fatal(err)
	}
	rooms, err = manager.List()
	if err != nil || len(rooms) != 1 || rooms[0]["id"] != second.ID {
		t.Fatalf("closed group retained in runtime list: %#v, %v", rooms, err)
	}
	history, err := manager.History()
	if err != nil || len(history) != 2 {
		t.Fatal("closing a group changed its saved history")
	}
}
