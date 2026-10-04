package app

import (
	"context"
	"errors"
	"sync"

	sessioncore "glad-web/internal/session"
)

type roomRuntime struct {
	ctx               context.Context
	cancel            context.CancelFunc
	completion        uint64
	revision          uint64
	unread            bool
	completedTurns    map[string]bool
	timers            map[string]*roomTimedInput
	operation         string
	operationCancel   context.CancelFunc
	operationSessions map[string]bool
	aborting          bool
}

func (manager *RoomManager) runtimeLocked(id string) *roomRuntime {
	if manager.activeIDs[id] == "" {
		return nil
	}
	runtime := manager.runtimes[id]
	if runtime == nil {
		ctx, cancel := context.WithCancel(context.Background())
		runtime = &roomRuntime{ctx: ctx, cancel: cancel, completedTurns: map[string]bool{}, timers: map[string]*roomTimedInput{}}
		manager.runtimes[id] = runtime
	}
	return runtime
}

func (manager *RoomManager) publishLocked(id string) {
	if runtime := manager.runtimeLocked(id); runtime != nil {
		runtime.revision++
	}
	manager.events.Publish(sessioncore.Event{SessionID: id, Kind: "room", Payload: map[string]any{"type": "room-changed", "id": id}})
}

func (manager *RoomManager) publishHistoryLocked(historyID string) {
	for id, savedID := range manager.activeIDs {
		if savedID == historyID {
			manager.publishLocked(id)
		}
	}
}

func (manager *RoomManager) sessionEvent(event sessioncore.Event) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	message := mapValue(event.Payload["message"])
	root := stringValue(event.Payload["type"]) == "message" && stringValue(message["kind"]) == "turn-end"
	if boolValue(message["retryScheduled"]) {
		root = false
	}
	if value, present := message["isRootTurn"]; present && !boolValue(value) {
		root = false
	}
	for id, historyID := range manager.activeIDs {
		room, err := manager.store.Get(historyID)
		if err != nil {
			continue
		}
		for _, member := range room.Members {
			if member.LeftAt != 0 || member.RuntimeSessionID != event.SessionID {
				continue
			}
			runtime := manager.runtimeLocked(id)
			if root && !quietSupervisorCompletion(event.Payload) {
				key := event.SessionID + "/" + stringValue(message["turnId"])
				if !runtime.completedTurns[key] {
					runtime.completedTurns[key] = true
					runtime.completion++
					runtime.unread = true
				}
			}
			manager.publishLocked(id)
			break
		}
	}
}

func (manager *RoomManager) runtimeFieldsLocked(id string, room RoomRecord) map[string]any {
	status := "idle"
	for _, member := range room.Members {
		if member.LeftAt != 0 {
			continue
		}
		if session := manager.sessions.Get(member.RuntimeSessionID); session != nil {
			session.mu.RLock()
			memberStatus := session.StatusValue
			session.mu.RUnlock()
			if memberStatus == "waiting_approval" || memberStatus == "waiting_input" {
				status = memberStatus
				break
			}
			if memberStatus == "running" || memberStatus == "thinking" {
				status = "running"
			}
		}
	}
	fields := map[string]any{"status": status, "completionRevision": uint64(0), "hasUnreadCompletion": false, "timedInputCount": 0, "resuming": false, "forking": false, "aborting": false, "canAbort": status != "idle"}
	if runtime := manager.runtimeLocked(id); runtime != nil {
		fields["completionRevision"], fields["hasUnreadCompletion"] = runtime.completion, runtime.unread
		fields["snapshotRevision"] = runtime.revision
		fields["timedInputCount"] = len(runtime.timers)
		fields["resuming"], fields["forking"], fields["aborting"] = runtime.operation == "resume", runtime.operation == "fork", runtime.aborting
		fields["canAbort"] = status != "idle" || runtime.operation != ""
		if runtime.operation != "" {
			fields["status"] = "running"
		}
	}
	return fields
}

func (manager *RoomManager) MarkRead(id string, revision uint64) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		return errRoomNotFound
	}
	if (revision == runtime.completion || revision == 0) && runtime.unread {
		runtime.unread = false
		manager.publishLocked(id)
	}
	return nil
}

func (manager *RoomManager) beginLifecycle(parent context.Context, id, kind string) (context.Context, func(), error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		return nil, nil, errRoomNotFound
	}
	if runtime.operation != "" {
		return nil, nil, errors.New("group is busy")
	}
	ctx, cancel := context.WithCancel(parent)
	runtime.operation, runtime.operationCancel = kind, cancel
	runtime.operationSessions = map[string]bool{}
	manager.publishLocked(id)
	return ctx, func() {
		cancel()
		manager.mu.Lock()
		defer manager.mu.Unlock()
		runtime.operation, runtime.operationCancel, runtime.aborting = "", nil, false
		runtime.operationSessions = nil
		manager.publishLocked(id)
	}, nil
}

func (manager *RoomManager) trackOperationSession(id, sessionID string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if runtime := manager.runtimeLocked(id); runtime != nil && runtime.operationSessions != nil {
		runtime.operationSessions[sessionID] = true
	}
}

func (manager *RoomManager) Abort(ctx context.Context, id string) ([]map[string]any, error) {
	manager.mu.Lock()
	runtime := manager.runtimeLocked(id)
	if runtime == nil {
		manager.mu.Unlock()
		return nil, errRoomNotFound
	}
	ids := map[string]bool{}
	operationIDs := map[string]bool{}
	for sessionID := range runtime.operationSessions {
		ids[sessionID] = true
		operationIDs[sessionID] = true
	}
	cancel := runtime.operationCancel
	runtime.aborting = true
	manager.publishLocked(id)
	room, err := manager.store.Get(manager.roomIDLocked(id))
	manager.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if err != nil {
		return nil, err
	}
	for _, member := range room.Members {
		if member.LeftAt == 0 {
			ids[member.RuntimeSessionID] = true
		}
	}
	results := []map[string]any{}
	var mu sync.Mutex
	var wait sync.WaitGroup
	for sessionID := range ids {
		session := manager.sessions.Get(sessionID)
		if session == nil {
			continue
		}
		session.mu.RLock()
		status := session.StatusValue
		session.mu.RUnlock()
		if !operationIDs[sessionID] && status != "running" && status != "thinking" && status != "waiting_approval" && status != "waiting_input" {
			continue
		}
		wait.Add(1)
		go func(session *Session) {
			defer wait.Done()
			result := map[string]any{"sessionId": session.ID, "success": true}
			provider, ok := session.Provider.(InterruptProvider)
			if !ok {
				result["success"], result["error"] = false, "Provider interruption is not supported"
			} else if err := provider.Interrupt(ctx); err != nil {
				result["success"], result["error"] = false, err.Error()
			}
			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		}(session)
	}
	wait.Wait()
	manager.mu.Lock()
	runtime.aborting = false
	manager.publishLocked(id)
	manager.mu.Unlock()
	return results, nil
}

// Stop cancels daemon-owned recovery work and timers without deleting history.
func (manager *RoomManager) Stop() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, runtime := range manager.runtimes {
		runtime.cancel()
		if runtime.operationCancel != nil {
			runtime.operationCancel()
		}
		for _, item := range runtime.timers {
			if item.Timer != nil {
				item.Timer.Stop()
			}
		}
	}
}
