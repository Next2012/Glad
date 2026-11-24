package app

import (
	sessioncore "glad-web/internal/session"
	"time"
)

// Core consumers must recover when a bounded stream is disconnected. Browser
// subscribers still use the original disconnect/reconnect backpressure policy.
func recoverSessionSubscription(hub *sessioncore.EventHub, old *sessioncore.Subscription, capacity int, filter func(sessioncore.Event) bool, handle func(sessioncore.Event), reconcile func()) *sessioncore.Subscription {
	next := hub.SubscribeFiltered("", capacity, filter)
	old.Close()
	for {
		select {
		case event := <-old.Events():
			handle(event)
		default:
			logDebug("[events] internal consumer recovered after queue overflow")
			if reconcile != nil {
				reconcile()
			}
			return next
		}
	}
}

// Recovery replays durable completions after the last observed completion in
// each session, plus the current state and pending interactions. It never
// replays a conversation's historical turns simply because it was resumed.
type sessionRecoveryCursor map[string]int64

func newSessionRecoveryCursor() sessionRecoveryCursor {
	return sessionRecoveryCursor{"": time.Now().UnixMilli()}
}
func (cursor sessionRecoveryCursor) observe(event sessioncore.Event) {
	if stringValue(event.Payload["type"]) == "session-closed" {
		delete(cursor, event.SessionID)
		return
	}
	message := mapValue(event.Payload["message"])
	if stringValue(message["kind"]) != "turn-end" {
		return
	}
	timestamp := numberInt64(message["createdAt"])
	after := cursor[event.SessionID]
	if after == 0 {
		after = cursor[""]
	}
	if timestamp > after {
		cursor[event.SessionID] = timestamp
	}
}
func (cursor sessionRecoveryCursor) reconcile(manager *SessionManager, handle func(sessioncore.Event)) {
	manager.mu.RLock()
	sessions := make([]*Session, 0, len(manager.sessions))
	for _, current := range manager.sessions {
		sessions = append(sessions, current)
	}
	manager.mu.RUnlock()
	for _, current := range sessions {
		after := cursor[current.ID]
		if after == 0 {
			after = cursor[""]
		}
		current.mu.RLock()
		events := []sessioncore.Event{{SessionID: current.ID, Payload: map[string]any{"type": "state", "state": cloneMap(current.State)}}}
		for _, message := range current.Messages {
			kind := stringValue(message["kind"])
			if kind == "turn-end" && numberInt64(message["createdAt"]) >= after || kind == "question" && stringValue(message["questionStatus"]) == "pending" {
				events = append(events, sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "message", "message": cloneMap(message), "supervisorSource": message["supervisorSource"]}})
				if kind == "question" {
					events = append(events, sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "question-request", "id": message["id"], "message": cloneMap(message)}})
				}
			}
		}
		for _, permission := range current.Permissions {
			if permission.Status == "pending" {
				events = append(events, sessioncore.Event{SessionID: current.ID, Payload: map[string]any{"type": "permission-request", "request": permission}})
			}
		}
		current.mu.RUnlock()
		for _, event := range events {
			handle(event)
		}
	}
}

func notificationControlEvent(event sessioncore.Event) bool {
	switch stringValue(event.Payload["type"]) {
	case "session-closed", "permission-request", "question-request", "runtime-disconnected":
		return true
	case "message":
		kind := stringValue(mapValue(event.Payload["message"])["kind"])
		return kind == "turn-end" || kind == "question"
	}
	return false
}
func supervisorControlEvent(event sessioncore.Event) bool {
	message := mapValue(event.Payload["message"])
	return stringValue(message["kind"]) == "question" && stringValue(message["questionStatus"]) == "pending"
}
