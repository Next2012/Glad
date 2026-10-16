package app

import (
	"context"
	"time"
)

func (manager *RoomManager) closeOrphanSessions(room RoomRecord) {
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		session := manager.sessions.Get(member.RuntimeSessionID)
		if session == nil {
			continue
		}
		// A send, answer or recovery already holding the command lock must
		// be preserved; closing a group must not wait behind that operation.
		if !session.commandMu.TryLock() {
			continue
		}
		manager.mu.Lock()
		shared := false
		for _, historyID := range manager.activeIDs {
			other, err := manager.store.Get(historyID)
			if err != nil {
				shared = true
				break
			}
			for _, current := range other.Members {
				if current.LeftAt == 0 && current.RuntimeSessionID == session.ID {
					shared = true
					break
				}
			}
			if shared {
				break
			}
		}
		ready, _ := sessionCanAccept(session)
		session.mu.Lock()
		shouldClose := !shared && ready && !session.closed && session.StatusValue == "idle" && len(session.Permissions) == 0 && numberInt64(session.State["pendingQuestionCount"]) == 0 && session.supervisorLease == ""
		if shouldClose {
			session.closed = true
		}
		session.mu.Unlock()
		manager.mu.Unlock()
		if shouldClose {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			manager.sessions.Delete(ctx, session.ID)
			cancel()
		}
		session.commandMu.Unlock()
	}
}
