package session

import (
	"testing"
	"time"
)

func TestEventHubDropsSlowSubscriberWithoutBlocking(t *testing.T) {
	hub := NewEventHub()
	slow := hub.Subscribe("session", 1)
	fast := hub.Subscribe("session", 2)
	defer slow.Close()
	defer fast.Close()

	hub.Publish(Event{SessionID: "session", Kind: "codex-structured", Payload: map[string]any{"sequence": 1}})
	hub.Publish(Event{SessionID: "session", Kind: "codex-structured", Payload: map[string]any{"sequence": 2}})

	select {
	case <-slow.Done():
	case <-time.After(time.Second):
		t.Fatal("slow subscriber was not disconnected")
	}
	for sequence := 1; sequence <= 2; sequence++ {
		select {
		case event := <-fast.Events():
			if event.Payload["sequence"] != sequence {
				t.Fatalf("events arrived out of order: %#v", event.Payload)
			}
		case <-time.After(time.Second):
			t.Fatalf("fast subscriber missed event %d", sequence)
		}
	}
}

func TestEventHubFiltersAndClosesSessionSubscriptions(t *testing.T) {
	hub := NewEventHub()
	first := hub.Subscribe("first", 1)
	second := hub.Subscribe("second", 1)
	defer first.Close()
	defer second.Close()

	hub.Publish(Event{SessionID: "first", Payload: map[string]any{"type": "state"}})
	select {
	case <-first.Events():
	case <-time.After(time.Second):
		t.Fatal("matching subscriber did not receive its event")
	}
	select {
	case event := <-second.Events():
		t.Fatalf("unrelated subscriber received event: %#v", event)
	default:
	}
	hub.CloseSession("first")
	select {
	case <-first.Done():
	case <-time.After(time.Second):
		t.Fatal("session subscription was not closed")
	}
}
