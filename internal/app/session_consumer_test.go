package app

import (
	sessioncore "glad-web/internal/session"
	"testing"
	"time"
)

func TestInternalSubscriptionDrainsRepairsAndKeepsReceivingAfterOverflow(t *testing.T) {
	manager := NewSessionManager(t.TempDir())
	current := newSession("member", "Member", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	manager.sessions[current.ID] = current
	cursor := newSessionRecoveryCursor()
	current.Messages = []map[string]any{
		{"id": "historical", "kind": "turn-end", "createdAt": cursor[""] - 1000},
		{"id": "missed", "kind": "turn-end", "createdAt": cursor[""] + 1},
		{"id": "question", "kind": "question", "questionStatus": "pending"},
	}
	hub := manager.Events()
	old := hub.Subscribe("", 1)
	hub.Publish(sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "state"}})
	hub.Publish(sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "message", "message": current.Messages[1]}})
	<-old.Done()
	questionRequests := 0
	seen := map[string]int{}
	handle := func(event sessioncore.Event) {
		if stringValue(event.Payload["type"]) == "question-request" {
			if classified, ok := classifyNotification(current, event.Payload); !ok || classified.kind != "待回复" {
				t.Fatalf("recovered question cannot notify: %#v", event.Payload)
			}
			questionRequests++
		}
		cursor.observe(event)
		if stringValue(event.Payload["type"]) == "message" {
			seen[stringValue(mapValue(event.Payload["message"])["id"])]++
		}
	}
	next := recoverSessionSubscription(hub, old, 1, nil, handle, func() { cursor.reconcile(manager, handle) })
	defer next.Close()
	if seen["missed"] != 1 || seen["question"] != 1 || seen["historical"] != 0 || questionRequests != 1 {
		t.Fatalf("incorrect repair: %#v", seen)
	}
	hub.Publish(sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "session-renamed"}})
	select {
	case <-next.Events():
	case <-time.After(time.Second):
		t.Fatal("consumer permanently stopped after overflow")
	}
}

type countingRoomStore struct {
	*FileRoomStore
	reads int
}

func (store *countingRoomStore) List() ([]RoomRecord, error) {
	store.reads++
	return store.FileRoomStore.List()
}
func TestRoomStreamingUsesMembershipIndexAndInvalidatesOnLeave(t *testing.T) {
	manager, current, _, room, _ := newRuntimeRoomTest(t)
	store := &countingRoomStore{FileRoomStore: manager.store.(*FileRoomStore)}
	manager.store = store
	event := sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "message", "message": map[string]any{"kind": "assistant"}}}
	for index := 0; index < 2000; index++ {
		manager.sessionEvent(event)
	}
	if store.reads != 1 {
		t.Fatalf("streaming reread room files %d times", store.reads)
	}
	saved, err := store.Get(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved.Members[0].LeftAt = millis()
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	manager.sessionEvent(event)
	if store.reads != 2 || manager.memberIndex[current.ID][room.ID] {
		t.Fatalf("leave did not invalidate index: reads=%d index=%#v", store.reads, manager.memberIndex)
	}
}
