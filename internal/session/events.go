// Package session contains transport-independent session contracts. The
// application package owns orchestration while HTTP, WebSocket and background
// consumers depend on these bounded event streams.
package session

import "sync"

// Event is a normalized event emitted by a Glad session.
type Event struct {
	SessionID string
	Kind      string
	Payload   map[string]any
}

type subscriber struct {
	id        uint64
	sessionID string
	events    chan Event
	done      chan struct{}
}

// Subscription owns a bounded event stream. When a consumer falls behind,
// the hub closes Done and removes it instead of blocking provider I/O.
type Subscription struct {
	hub        *EventHub
	subscriber *subscriber
	once       sync.Once
}

func (subscription *Subscription) Events() <-chan Event {
	return subscription.subscriber.events
}

func (subscription *Subscription) Done() <-chan struct{} {
	return subscription.subscriber.done
}

func (subscription *Subscription) Close() {
	subscription.once.Do(func() {
		subscription.hub.unsubscribe(subscription.subscriber.id)
	})
}

// EventHub is deliberately session-specific rather than a generic application
// event bus. An empty sessionID subscribes to every session.
type EventHub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uint64]*subscriber
}

func NewEventHub() *EventHub {
	return &EventHub{subscribers: map[uint64]*subscriber{}}
}

func (hub *EventHub) Subscribe(sessionID string, capacity int) *Subscription {
	if capacity < 1 {
		capacity = 1
	}
	hub.mu.Lock()
	hub.nextID++
	subscriber := &subscriber{
		id: hub.nextID, sessionID: sessionID,
		events: make(chan Event, capacity), done: make(chan struct{}),
	}
	hub.subscribers[subscriber.id] = subscriber
	hub.mu.Unlock()
	return &Subscription{hub: hub, subscriber: subscriber}
}

func (hub *EventHub) Publish(event Event) {
	if event.SessionID == "" {
		return
	}
	hub.mu.Lock()
	for id, subscriber := range hub.subscribers {
		if subscriber.sessionID != "" && subscriber.sessionID != event.SessionID {
			continue
		}
		select {
		case subscriber.events <- event:
		default:
			delete(hub.subscribers, id)
			close(subscriber.done)
		}
	}
	hub.mu.Unlock()
}

func (hub *EventHub) CloseSession(sessionID string) {
	hub.mu.Lock()
	for id, subscriber := range hub.subscribers {
		if subscriber.sessionID != sessionID {
			continue
		}
		delete(hub.subscribers, id)
		close(subscriber.done)
	}
	hub.mu.Unlock()
}

func (hub *EventHub) SubscriberCount(sessionID string) int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	count := 0
	for _, subscriber := range hub.subscribers {
		if subscriber.sessionID == sessionID {
			count++
		}
	}
	return count
}

func (hub *EventHub) unsubscribe(id uint64) {
	hub.mu.Lock()
	if subscriber := hub.subscribers[id]; subscriber != nil {
		delete(hub.subscribers, id)
		close(subscriber.done)
	}
	hub.mu.Unlock()
}
