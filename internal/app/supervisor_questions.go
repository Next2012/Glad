package app

// Pending question notifications coalesce into one early check. Never overlap
// or interrupt the executor's current turn, and never restart paused tasks.
func (manager *SupervisorManager) questionArrived(sessionID, questionID string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.questionSignals == nil {
		manager.questionSignals = map[string]bool{}
	}
	key := sessionID + ":" + questionID
	if manager.questionSignals[key] {
		return
	}
	if len(manager.questionSignals) >= 2048 {
		clear(manager.questionSignals)
	}
	manager.questionSignals[key] = true
	for _, task := range manager.tasks {
		if !task.Enabled && activeInvocation(task) == nil {
			continue
		}
		runtimeID := manager.runtimeRoom(task.RoomID)
		if runtimeID == "" {
			continue
		}
		room, err := manager.rooms.GetRecord(runtimeID)
		if err != nil {
			continue
		}
		for _, target := range task.Targets {
			member, exists := supervisorMember(room, target.MemberID)
			if exists && target.Read && member.RuntimeSessionID == sessionID {
				task.questionPending, task.force = true, true
				if activeInvocation(task) == nil && task.Enabled {
					task.NextAt = millis()
				}
				break
			}
		}
	}
}

func (manager *SupervisorManager) invocationTargetValidLocked(task *SupervisorTask, invocationID, memberID, sessionID string, send bool) bool {
	if manager.tasks[task.ID] != task {
		return false
	}
	inv := activeInvocation(task)
	if inv == nil || inv.ID != invocationID || inv.Revoked {
		return false
	}
	runtimeID := manager.runtimeRoom(task.RoomID)
	if runtimeID == "" {
		return false
	}
	room, err := manager.rooms.GetRecord(runtimeID)
	if err != nil {
		return false
	}
	member, exists := supervisorMember(room, memberID)
	if !exists || member.RuntimeSessionID != sessionID {
		return false
	}
	for _, target := range task.Targets {
		if target.MemberID == memberID && target.Read && (!send || target.Send) {
			return true
		}
	}
	return false
}
