package app

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type SupervisorTarget struct {
	MemberID string `json:"memberId"`
	Read     bool   `json:"read"`
	Stop     bool   `json:"stop"`
	Send     bool   `json:"send"`
}

func (target *SupervisorTarget) UnmarshalJSON(data []byte) error {
	type plain SupervisorTarget
	value := plain{Read: true, Stop: true, Send: true}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*target = SupervisorTarget(value)
	return nil
}

type SupervisorCall struct {
	ID        string `json:"id"`
	Tool      string `json:"tool"`
	MemberID  string `json:"memberId,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	Success   bool   `json:"success"`
	Summary   string `json:"summary"`
}
type SupervisorInvocation struct {
	ID            string           `json:"id"`
	SessionID     string           `json:"sessionId"`
	StartedAt     int64            `json:"startedAt"`
	EndedAt       int64            `json:"endedAt,omitempty"`
	Status        string           `json:"status"`
	Prompt        string           `json:"prompt"`
	Summary       string           `json:"summary,omitempty"`
	Calls         []SupervisorCall `json:"calls"`
	Usage         map[string]any   `json:"usage,omitempty"`
	Revoked       bool             `json:"revoked,omitempty"`
	StopRequested bool             `json:"stopRequested,omitempty"`
	StopAccepted  bool             `json:"stopAccepted,omitempty"`
	StopError     string           `json:"stopError,omitempty"`
}
type SupervisorTask struct {
	SchemaVersion    int                    `json:"schemaVersion"`
	ID               string                 `json:"id"`
	RoomID           string                 `json:"roomId"`
	ExecutorMemberID string                 `json:"executorMemberId"`
	Targets          []SupervisorTarget     `json:"targets"`
	IntervalSeconds  int                    `json:"intervalSeconds"`
	Prompt           string                 `json:"prompt"`
	SkipUnchanged    bool                   `json:"skipUnchanged"`
	Enabled          bool                   `json:"enabled"`
	Status           string                 `json:"status"`
	NextAt           int64                  `json:"nextAt,omitempty"`
	CreatedAt        int64                  `json:"createdAt"`
	UpdatedAt        int64                  `json:"updatedAt"`
	Revision         uint64                 `json:"revision"`
	LastError        string                 `json:"lastError,omitempty"`
	Invocations      []SupervisorInvocation `json:"-"`
	RunOnce          bool                   `json:"runOnce"`
	RunCount         uint64                 `json:"runCount"`
	Skipped          int                    `json:"skipped"`
	LastSkippedAt    int64                  `json:"lastSkippedAt,omitempty"`
	stopping         bool
	launching        bool
	failures         int
	fingerprint      string
	force            bool
}
type SupervisorManager struct {
	mu           sync.Mutex
	directory    string
	tasks        map[string]*SupervisorTask
	rooms        *RoomManager
	sessions     *SessionManager
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	cached       map[string]map[string]any
	loadWarnings []string
}

func (manager *SupervisorManager) Start(parent context.Context) {
	manager.ctx, manager.cancel = context.WithCancel(parent)
	manager.wg.Add(1)
	go func() {
		defer manager.wg.Done()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-manager.ctx.Done():
				return
			case <-ticker.C:
				manager.tick()
			}
		}
	}()
}
func (manager *SupervisorManager) Stop() {
	if manager.cancel != nil {
		manager.cancel()
		manager.wg.Wait()
	}
}
func activeInvocation(task *SupervisorTask) *SupervisorInvocation {
	if len(task.Invocations) == 0 {
		return nil
	}
	value := &task.Invocations[len(task.Invocations)-1]
	if value.EndedAt != 0 {
		return nil
	}
	return value
}
func (manager *SupervisorManager) runtimeRoom(historyID string) string {
	manager.rooms.mu.Lock()
	defer manager.rooms.mu.Unlock()
	for id, saved := range manager.rooms.activeIDs {
		if saved == historyID {
			return id
		}
	}
	return ""
}
func supervisorMember(room RoomRecord, id string) (RoomMemberRecord, bool) {
	for _, member := range room.Members {
		if member.ID == id && member.LeftAt == 0 {
			return member, true
		}
	}
	return RoomMemberRecord{}, false
}
func cloneSupervisor(task *SupervisorTask) SupervisorTask {
	data, _ := json.Marshal(task)
	var result SupervisorTask
	_ = json.Unmarshal(data, &result)
	data, _ = json.Marshal(task.Invocations)
	_ = json.Unmarshal(data, &result.Invocations)
	return result
}
func (manager *SupervisorManager) List(roomID string) []SupervisorTask {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	result := []SupervisorTask{}
	for _, task := range manager.tasks {
		if task.RoomID == roomID {
			result = append(result, cloneSupervisor(task))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt < result[j].CreatedAt })
	return result
}
func (manager *SupervisorManager) Save(runtimeID, id string, input SupervisorTask) (SupervisorTask, error) {
	room, err := manager.rooms.GetRecord(runtimeID)
	if err != nil {
		return SupervisorTask{}, err
	}
	if !manager.rooms.IsActive(runtimeID) {
		return SupervisorTask{}, errRoomNotFound
	}
	if _, ok := supervisorMember(room, input.ExecutorMemberID); !ok {
		return SupervisorTask{}, errors.New("Choose an active supervisor member")
	}
	if len(input.Targets) == 0 || len(input.Targets) > 32 {
		return SupervisorTask{}, errors.New("Choose between 1 and 32 monitored sessions")
	}
	if input.IntervalSeconds < 60 || input.IntervalSeconds > 86400 {
		return SupervisorTask{}, errors.New("Monitoring interval must be between 60 and 86400 seconds")
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" || len(input.Prompt) > 16<<10 {
		return SupervisorTask{}, errors.New("Supervisor prompt is required and must fit 16 KiB")
	}
	seen := map[string]bool{}
	targetSessions := map[string]bool{}
	executorMember, _ := supervisorMember(room, input.ExecutorMemberID)
	for _, target := range input.Targets {
		if _, ok := supervisorMember(room, target.MemberID); !ok || target.MemberID == input.ExecutorMemberID || seen[target.MemberID] {
			return SupervisorTask{}, errors.New("Monitored members must be distinct and cannot include the supervisor")
		}
		seen[target.MemberID] = true
		targetMember, _ := supervisorMember(room, target.MemberID)
		targetSessions[targetMember.RuntimeSessionID] = true
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, other := range manager.tasks {
		if other.ID == id {
			continue
		}
		otherRoom, err := manager.rooms.GetHistoryRecord(other.RoomID)
		if err != nil {
			continue
		}
		otherExecutor, exists := supervisorMember(otherRoom, other.ExecutorMemberID)
		if exists && targetSessions[otherExecutor.RuntimeSessionID] {
			return SupervisorTask{}, errors.New("A supervisor executor cannot be another task's target")
		}
		for _, target := range other.Targets {
			otherTarget, exists := supervisorMember(otherRoom, target.MemberID)
			if exists && otherTarget.RuntimeSessionID == executorMember.RuntimeSessionID {
				return SupervisorTask{}, errors.New("A monitored session cannot also be a supervisor executor")
			}
		}
	}
	task := manager.tasks[id]
	if id != "" && (task == nil || task.RoomID != room.ID) {
		return SupervisorTask{}, errRoomNotFound
	}
	if task == nil {
		task = &SupervisorTask{SchemaVersion: 2, ID: newUUID(), RoomID: room.ID, CreatedAt: millis(), Status: "paused", Invocations: []SupervisorInvocation{}}
	} else if activeInvocation(task) != nil && input.ExecutorMemberID != task.ExecutorMemberID {
		return SupervisorTask{}, errors.New("Stop the current invocation before changing its executor")
	}
	backup := *task
	created := id == ""
	intervalChanged := created || task.IntervalSeconds != input.IntervalSeconds
	task.ExecutorMemberID, task.Targets, task.IntervalSeconds, task.Prompt, task.SkipUnchanged = input.ExecutorMemberID, input.Targets, input.IntervalSeconds, input.Prompt, input.SkipUnchanged
	if created {
		task.Enabled = true
	}
	task.UpdatedAt = millis()
	task.Revision++
	task.fingerprint = ""
	task.force = true
	if activeInvocation(task) == nil && intervalChanged {
		if task.RunOnce {
			task.NextAt = millis()
		} else if task.Enabled {
			task.Status = "scheduled"
			task.NextAt = millis() + int64(task.IntervalSeconds)*1000
		} else {
			task.Status = "paused"
			task.NextAt = 0
		}
	}
	if err := manager.saveLocked(task); err != nil {
		*task = backup
		return SupervisorTask{}, err
	}
	manager.tasks[task.ID] = task
	return cloneSupervisor(task), nil
}
func (manager *SupervisorManager) Action(runtimeID, id, action string) error {
	room, err := manager.rooms.GetRecord(runtimeID)
	if err != nil {
		return err
	}
	manager.mu.Lock()
	task := manager.tasks[id]
	if task == nil || task.RoomID != room.ID {
		manager.mu.Unlock()
		return errRoomNotFound
	}
	switch action {
	case "delete":
		if inv := activeInvocation(task); inv != nil {
			inv.Revoked = true
		}
		if err := os.Remove(filepath.Join(manager.directory, id+".json")); err != nil {
			manager.mu.Unlock()
			return err
		}
		delete(manager.tasks, id)
		for _, suffix := range []string{".audit.jsonl", ".audit.1.jsonl"} {
			if err := os.Remove(filepath.Join(manager.directory, id+suffix)); err != nil && !os.IsNotExist(err) {
				manager.warnLocked(id + suffix + ": " + err.Error())
			}
		}
	case "pause":
		task.Enabled = false
		task.RunOnce = false
		if activeInvocation(task) == nil {
			task.Status = "paused"
			task.NextAt = 0
		}
		task.Revision++
	case "resume", "trigger":
		if activeInvocation(task) != nil {
			manager.mu.Unlock()
			return errors.New("Supervisor already has an active invocation")
		}
		task.LastError = ""
		task.Revision++
		task.force = true
		if action == "resume" {
			task.Enabled = true
			task.failures = 0
			task.Status = "scheduled"
			task.NextAt = millis() + int64(task.IntervalSeconds)*1000
		} else {
			task.RunOnce = true
			task.Status = "scheduled"
			task.NextAt = millis()
		}
	case "stop":
		inv := activeInvocation(task)
		if inv == nil {
			manager.mu.Unlock()
			return nil
		}
		if inv.StopRequested && inv.StopAccepted {
			manager.mu.Unlock()
			return nil
		}
		inv.StopRequested = true
		inv.Revoked = true
		task.stopping = true
		task.Status = "stopping"
		task.Revision++
		session := manager.sessions.Get(inv.SessionID)
		invID := inv.ID
		if err := manager.appendAuditLocked(task, "stop", inv, nil); err != nil {
			task.stopping = false
			manager.mu.Unlock()
			return err
		}
		manager.mu.Unlock()
		var stopErr error
		if session == nil {
			stopErr = errors.New("Supervisor session is unavailable")
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			stopErr = stopSessionControlled(ctx, session, "")
			cancel()
		}
		manager.mu.Lock()
		if manager.tasks[id] == task {
			task.stopping = false
			if current := activeInvocation(task); current != nil && current.ID == invID {
				current.StopAccepted = stopErr == nil
				current.StopError = ""
				if stopErr != nil {
					current.StopError = stopErr.Error()
					task.LastError = current.StopError
				}
				_ = manager.appendAuditLocked(task, "stop", current, nil)
			}
		}
		manager.mu.Unlock()
		return stopErr
	default:
		manager.mu.Unlock()
		return errors.New("Unknown supervisor action")
	}
	err = manager.saveLocked(task)
	manager.mu.Unlock()
	return err
}
func (manager *SupervisorManager) tick() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	// Deleted tasks revoke tool access immediately, but retain their executor
	// reservation until the provider actually settles.
	manager.sessions.mu.RLock()
	sessions := make([]*Session, 0, len(manager.sessions.sessions))
	for _, session := range manager.sessions.sessions {
		sessions = append(sessions, session)
	}
	manager.sessions.mu.RUnlock()
	for _, session := range sessions {
		session.mu.RLock()
		lease := session.supervisorLease
		session.mu.RUnlock()
		if lease == "" {
			continue
		}
		owned := false
		for _, task := range manager.tasks {
			if inv := activeInvocation(task); inv != nil && inv.ID == lease {
				owned = true
				break
			}
		}
		if ready, _ := providerReadiness(session); !owned && ready {
			session.mu.Lock()
			if session.supervisorLease == lease {
				session.supervisorLease = ""
				session.publishLocked(map[string]any{"type": "state", "state": cloneMap(session.State)})
			}
			session.mu.Unlock()
		}
	}
	for _, task := range manager.tasks {
		runtimeID := manager.runtimeRoom(task.RoomID)
		if runtimeID == "" {
			if task.Enabled || task.RunOnce {
				task.Enabled = false
				task.RunOnce = false
				task.Status = "paused"
				task.NextAt = 0
				task.Revision++
				if inv := activeInvocation(task); inv != nil {
					inv.Revoked = true
				}
				_ = manager.saveLocked(task)
			}
		}
		if inv := activeInvocation(task); inv != nil {
			manager.pollLocked(task, inv)
			continue
		}
		if (!task.Enabled && !task.RunOnce) || runtimeID == "" || task.NextAt > millis() {
			continue
		}
		room, err := manager.rooms.GetRecord(runtimeID)
		if err != nil {
			continue
		}
		executor, ok := supervisorMember(room, task.ExecutorMemberID)
		if !ok {
			task.Enabled = false
			task.RunOnce = false
			task.Status = "needs_attention"
			task.LastError = "Executor is no longer a member"
			_ = manager.saveLocked(task)
			continue
		}
		session := manager.sessions.Get(executor.RuntimeSessionID)
		if session == nil {
			task.Status = "waiting_executor"
			continue
		}
		if ready, _ := sessionCanAccept(session); !ready {
			task.Status = "waiting_executor"
			continue
		}
		fingerprint, allIdle := "", true
		for _, target := range task.Targets {
			member, exists := supervisorMember(room, target.MemberID)
			targetSession := manager.sessions.Get(member.RuntimeSessionID)
			if !exists || targetSession == nil {
				allIdle = false
				continue
			}
			targetSession.mu.RLock()
			fingerprint += fmt.Sprintf("%s:%d:%s;", member.ID, targetSession.outputRevision, targetSession.StatusValue)
			targetSession.mu.RUnlock()
			if ready, _ := sessionCanAccept(targetSession); !ready {
				allIdle = false
			}
		}
		if task.SkipUnchanged && !task.force && allIdle && fingerprint == task.fingerprint {
			task.Skipped++
			task.LastSkippedAt = millis()
			task.Status = "scheduled"
			task.NextAt = millis() + int64(task.IntervalSeconds)*1000
			_ = manager.saveLocked(task)
			continue
		}
		task.fingerprint = fingerprint
		task.force = false
		inv := SupervisorInvocation{ID: newUUID(), SessionID: session.ID, StartedAt: millis(), Status: "running", Prompt: task.Prompt, Calls: []SupervisorCall{}}
		session.mu.Lock()
		if session.supervisorLease != "" {
			session.mu.Unlock()
			task.Status = "waiting_executor"
			continue
		}
		session.supervisorLease = inv.ID
		session.mu.Unlock()
		if len(task.Invocations) >= 100 {
			task.Invocations = append([]SupervisorInvocation(nil), task.Invocations[len(task.Invocations)-99:]...)
		}
		task.Invocations = append(task.Invocations, inv)
		task.Status = "running"
		task.launching = true
		task.RunOnce = false
		task.RunCount++
		if err := manager.appendAuditLocked(task, "start", &task.Invocations[len(task.Invocations)-1], nil); err != nil {
			session.mu.Lock()
			session.supervisorLease = ""
			session.mu.Unlock()
			task.Invocations = task.Invocations[:len(task.Invocations)-1]
			task.launching = false
			task.Enabled = false
			task.Status = "failed"
			task.LastError = err.Error()
			continue
		}
		if err := manager.saveLocked(task); err != nil {
			task.LastError = err.Error()
			task.Enabled = false
		}
		source := &SupervisorSource{Version: 1, TaskID: task.ID, InvocationID: inv.ID, Kind: "trigger"}
		prompt := fmt.Sprintf("You are supervising members of a Glad group. Current invocationId: %s. Use the glad MCP tools with this invocationId to list_targets and read_session as authorized. Stop acceptance is not readiness; read before sending. Call end_supervision when the goal is achieved. Targets and permissions: %s\n\n%s", inv.ID, supervisorTargetJSON(task.Targets), task.Prompt)
		manager.wg.Add(1)
		go manager.launch(task.ID, session, source, prompt)
	}
}
func supervisorTargetJSON(targets []SupervisorTarget) string {
	data, _ := json.Marshal(targets)
	return string(data)
}
func (manager *SupervisorManager) launch(id string, session *Session, source *SupervisorSource, prompt string) {
	defer manager.wg.Done()
	ctx, cancel := context.WithTimeout(manager.ctx, 90*time.Second)
	defer cancel()
	err := sendSessionControlled(ctx, session, ProviderInput{ClientMessageID: "supervisor:" + source.InvocationID, Text: prompt, AgentText: supervisorAgentText(source, prompt), Source: source})
	manager.mu.Lock()
	defer manager.mu.Unlock()
	task := manager.tasks[id]
	if task == nil {
		session.mu.Lock()
		if session.supervisorLease == source.InvocationID {
			session.supervisorLease = ""
		}
		session.mu.Unlock()
		return
	}
	task.launching = false
	if err != nil {
		if inv := activeInvocation(task); inv != nil {
			manager.finishLocked(task, inv, "failed", err.Error())
		}
	}
}
func (manager *SupervisorManager) pollLocked(task *SupervisorTask, inv *SupervisorInvocation) {
	if task.launching || task.stopping {
		return
	}
	session := manager.sessions.Get(inv.SessionID)
	if session == nil {
		manager.finishLocked(task, inv, "interrupted", "Executor session was closed")
		task.Enabled = false
		task.Status = "needs_attention"
		_ = manager.saveLocked(task)
		return
	}
	session.mu.RLock()
	ended, status, summary := false, "", ""
	usage := map[string]any{}
	for _, message := range session.Messages {
		source := sourceValue(message["supervisorSource"])
		if source == nil || source.InvocationID != inv.ID || hasFalseRoot(message) {
			continue
		}
		if stringValue(message["kind"]) == "assistant" && stringValue(message["parentToolUseId"]) == "" {
			summary = codexPreviewText(stringValue(message["text"]), 2000)
		}
		if stringValue(message["kind"]) == "turn-end" && !boolValue(message["retryScheduled"]) {
			ended = true
			status = firstNonEmpty(stringValue(message["status"]), stringValue(message["turnStatus"]), "completed")
		}
		if cost, ok := message["costUsd"].(float64); ok {
			previous, _ := usage["costUsd"].(float64)
			usage["costUsd"] = previous + cost
		}
		if data := mapValue(message["usage"]); len(data) > 0 {
			for key, value := range data {
				if number, ok := value.(float64); ok {
					usage[key] = number + float64(numberInt64(usage[key]))
				}
			}
		}
	}
	publicStatus := session.StatusValue
	session.mu.RUnlock()
	ready, _ := providerReadiness(session)
	if ended && ready {
		inv.Usage = usage
		manager.finishLocked(task, inv, status, summary)
		return
	}
	if publicStatus == "waiting_approval" || publicStatus == "waiting_input" || publicStatus == "error" {
		task.Status = "needs_attention"
		return
	}
	if ready && millis()-inv.StartedAt > 5000 {
		manager.finishLocked(task, inv, "interrupted", "Provider settled without a matching completion event")
		return
	}
	if millis()-inv.StartedAt > 30*60*1000 {
		inv.Revoked = true
		task.Status = "needs_attention"
		task.LastError = "Invocation exceeded 30 minutes; stop or inspect the executor"
		_ = manager.saveLocked(task)
	} else if inv.StopRequested && inv.StopAccepted {
		task.Status = "stopping"
	} else {
		task.Status = "running"
	}
}
func (manager *SupervisorManager) finishLocked(task *SupervisorTask, inv *SupervisorInvocation, status, summary string) {
	for key := range manager.cached {
		if strings.HasPrefix(key, inv.ID+":") {
			delete(manager.cached, key)
		}
	}
	if inv.StopRequested && inv.StopAccepted && (status == "cancelled" || status == "interrupted") {
		status = "stopped"
	}
	inv.EndedAt = millis()
	inv.Status = status
	inv.Summary = summary
	inv.Revoked = true
	task.launching = false
	if session := manager.sessions.Get(inv.SessionID); session != nil {
		session.mu.Lock()
		if session.supervisorLease == inv.ID {
			session.supervisorLease = ""
			session.publishLocked(map[string]any{"type": "state", "state": cloneMap(session.State)})
		}
		session.mu.Unlock()
	}
	task.LastError = ""
	task.Status = "paused"
	task.NextAt = 0
	if status == "completed" || status == "stopped" || inv.StopAccepted && status == "failed" {
		task.failures = 0
	} else {
		task.failures++
		task.LastError = firstNonEmpty(summary, status)
		task.force = true
	}
	if task.Enabled {
		if task.failures >= 3 {
			task.Enabled = false
			task.Status = "needs_attention"
		} else {
			task.Status = "scheduled"
			delay := int64(task.IntervalSeconds) * 1000
			if task.failures > 0 {
				delay *= int64(1 << min(task.failures, 3))
			}
			task.NextAt = millis() + delay
		}
	}
	if err := manager.appendAuditLocked(task, "end", inv, nil); err != nil {
		task.LastError = err.Error()
		task.Enabled = false
		task.Status = "needs_attention"
	}
	_ = manager.saveLocked(task)
}

func (server *Server) registerSupervisorRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms/{id}/supervisors", server.supervisorTasks)
	mux.HandleFunc("POST /api/rooms/{id}/supervisors", server.supervisorTasks)
	mux.HandleFunc("PATCH /api/rooms/{id}/supervisors/{taskId}", server.supervisorTasks)
	mux.HandleFunc("DELETE /api/rooms/{id}/supervisors/{taskId}", server.supervisorTasks)
	mux.HandleFunc("POST /api/rooms/{id}/supervisors/{taskId}/{action}", server.supervisorTasks)
	mux.HandleFunc("GET /api/rooms/{id}/supervisors/{taskId}", server.supervisorDetail)
	mux.HandleFunc("GET /api/rooms/{id}/supervisors/{taskId}/history", server.supervisorDetail)
	mux.HandleFunc("GET /api/rooms/{id}/supervisors/{taskId}/history/{invocationId}", server.supervisorDetail)
	mux.HandleFunc("POST /api/supervisor/call", server.supervisorCall)
}
func (server *Server) supervisorTasks(writer http.ResponseWriter, request *http.Request) {
	if server.supervisors == nil {
		respondError(writer, 503, errors.New("Supervisor service unavailable"))
		return
	}
	room, err := server.rooms.GetRecord(request.PathValue("id"))
	if err != nil {
		server.writeRoomError(writer, err)
		return
	}
	if !server.rooms.IsActive(request.PathValue("id")) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	if request.Method == "GET" {
		respondJSON(writer, 200, server.supervisors.summaryResponse(room.ID))
		return
	}
	action := request.PathValue("action")
	if request.Method == "DELETE" {
		action = "delete"
	}
	if action != "" {
		err = server.supervisors.Action(request.PathValue("id"), request.PathValue("taskId"), action)
		if err != nil {
			respondError(writer, 409, err)
			return
		}
		respondJSON(writer, 200, map[string]any{"success": true})
		return
	}
	var input SupervisorTask
	if err = decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	task, err := server.supervisors.Save(request.PathValue("id"), request.PathValue("taskId"), input)
	if err != nil {
		respondError(writer, 400, err)
		return
	}
	respondJSON(writer, 200, map[string]any{"success": true, "task": task})
}
func (server *Server) supervisorCall(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		SessionID string         `json:"sessionId"`
		Tool      string         `json:"tool"`
		Arguments map[string]any `json:"arguments"`
		CallID    string         `json:"callId"`
	}
	if err := decodeJSON(request, &input); err != nil {
		respondError(writer, 400, err)
		return
	}
	session := server.sessions.Get(input.SessionID)
	token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	if session == nil || session.mcpToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(session.mcpToken)) != 1 {
		respondError(writer, 403, errors.New("Invalid supervisor session credential"))
		return
	}
	if server.supervisors == nil {
		respondError(writer, 503, errors.New("Supervisor service unavailable"))
		return
	}
	result, err := server.supervisors.Call(request.Context(), session, input.Tool, input.CallID, input.Arguments)
	if err != nil {
		respondError(writer, 409, err)
		return
	}
	respondJSON(writer, 200, result)
}
func (manager *SupervisorManager) Call(ctx context.Context, caller *Session, tool, callID string, args map[string]any) (map[string]any, error) {
	invocationID := stringValue(args["invocationId"])
	manager.mu.Lock()
	var task *SupervisorTask
	var inv *SupervisorInvocation
	for _, candidate := range manager.tasks {
		current := activeInvocation(candidate)
		if current != nil && current.SessionID == caller.ID && current.ID == invocationID {
			task, inv = candidate, current
			break
		}
	}
	if task == nil || inv.Revoked || manager.runtimeRoom(task.RoomID) == "" {
		manager.mu.Unlock()
		return nil, errors.New("Current turn is not an authorized supervisor invocation")
	}
	caller.mu.RLock()
	lease := caller.supervisorLease
	caller.mu.RUnlock()
	if lease != invocationID {
		manager.mu.Unlock()
		return nil, errors.New("Supervisor invocation changed")
	}
	runtimeID := manager.runtimeRoom(task.RoomID)
	room, err := manager.rooms.GetRecord(runtimeID)
	if err != nil {
		manager.mu.Unlock()
		return nil, err
	}
	executor, exists := supervisorMember(room, task.ExecutorMemberID)
	if !exists || executor.RuntimeSessionID != caller.ID {
		manager.mu.Unlock()
		return nil, errors.New("Executor membership changed")
	}
	memberID := stringValue(args["memberId"])
	var permissions SupervisorTarget
	allowed := false
	for _, target := range task.Targets {
		if target.MemberID == memberID {
			permissions = target
			allowed = true
			break
		}
	}
	if tool != "list_targets" && tool != "end_supervision" && (!allowed || tool == "read_session" && !permissions.Read || tool == "stop_session" && !permissions.Stop || tool == "send_to_session" && !permissions.Send) {
		if len(inv.Calls) < 200 {
			inv.Calls = append(inv.Calls, SupervisorCall{ID: callID, Tool: tool, MemberID: memberID, CreatedAt: millis(), Success: false, Summary: "Operation is not authorized for this target"})
			_ = manager.appendAuditLocked(task, "call", inv, &inv.Calls[len(inv.Calls)-1])
		}
		manager.mu.Unlock()
		return nil, errors.New("Operation is not authorized for this target")
	}
	member, exists := supervisorMember(room, memberID)
	targetSession := manager.sessions.Get(member.RuntimeSessionID)
	if tool != "list_targets" && tool != "end_supervision" && (!exists || targetSession == nil) {
		manager.mu.Unlock()
		return nil, errors.New("Target session is unavailable")
	}
	encoded, _ := json.Marshal(map[string]any{"tool": tool, "args": args})
	digest := sha256.Sum256(encoded)
	commandDigest := sha256.Sum256(append(encoded, []byte("\x00"+callID)...))
	commandID := "supervisor-command:" + hex.EncodeToString(commandDigest[:])
	key := inv.ID + ":" + callID + ":" + hex.EncodeToString(digest[:])
	if callID == "" {
		key = inv.ID + ":" + newUUID()
	}
	if cached := manager.cached[key]; cached != nil {
		manager.mu.Unlock()
		return cached, nil
	}
	result := map[string]any{"success": true}
	switch tool {
	case "list_targets":
		targets := []map[string]any{}
		for _, target := range task.Targets {
			m, exists := supervisorMember(room, target.MemberID)
			s := manager.sessions.Get(m.RuntimeSessionID)
			ready := false
			if exists && s != nil {
				ready, _ = sessionCanAccept(s)
			}
			targets = append(targets, map[string]any{"memberId": target.MemberID, "name": m.DisplayName, "sessionId": m.RuntimeSessionID, "canAccept": ready, "permissions": target})
		}
		result["targets"] = targets
	case "read_session":
		result = sessionOutput(targetSession, uint64(numberInt64(args["after"])), int(max64(1, numberInt64(firstNonNil(args["limit"], 50)))), int(numberInt64(args["offset"])), boolValue(args["history"]))
	case "end_supervision":
		task.Enabled = false
		task.RunOnce = false
		inv.Revoked = true
		task.Revision++
		if saveErr := manager.saveLocked(task); saveErr != nil {
			manager.mu.Unlock()
			return nil, saveErr
		}
	case "stop_session", "send_to_session":
		// Release the manager lock before provider I/O; callbacks may call MCP.
		if tool == "send_to_session" && (strings.TrimSpace(stringValue(args["text"])) == "" || len(stringValue(args["text"])) > 16<<10) {
			manager.mu.Unlock()
			return nil, errors.New("Command text must fit 16 KiB")
		}
		if tool == "stop_session" && stringValue(args["expectedTurnId"]) == "" {
			manager.mu.Unlock()
			return nil, errors.New("Read the target and supply expectedTurnId before stopping")
		}
		source := &SupervisorSource{Version: 1, TaskID: task.ID, InvocationID: inv.ID, Kind: "command"}
		sender := task.ExecutorMemberID
		manager.mu.Unlock()
		if tool == "stop_session" {
			err = stopSessionControlled(ctx, targetSession, stringValue(args["expectedTurnId"]))
		} else {
			_, err = manager.rooms.PostMessage(ctx, runtimeID, RoomMessageInput{ClientMessageID: commandID, Text: stringValue(args["text"]), MentionedMemberIDs: []string{memberID}, Source: source, SenderMemberID: sender})
			if err == nil {
				errText := manager.rooms.RequestDispatchFailure(runtimeID, commandID)
				if errText != "" {
					err = errors.New(errText)
				}
			}
		}
		manager.mu.Lock()
		if manager.tasks[task.ID] != task {
			manager.mu.Unlock()
			return nil, errors.New("Supervisor task was deleted")
		}
		inv = activeInvocation(task)
		if inv == nil || inv.ID != invocationID {
			manager.mu.Unlock()
			return nil, errors.New("Invocation ended while the operation was completing")
		}
		result["accepted"] = err == nil
	default:
		manager.mu.Unlock()
		return nil, errors.New("Unknown supervisor tool")
	}
	data, _ := json.Marshal(result)
	summary := codexPreviewText(string(data), 2000)
	if err != nil {
		summary = err.Error()
	}
	var auditCall *SupervisorCall
	if len(inv.Calls) < 200 {
		inv.Calls = append(inv.Calls, SupervisorCall{ID: callID, Tool: tool, MemberID: memberID, CreatedAt: millis(), Success: err == nil, Summary: summary})
		auditCall = &inv.Calls[len(inv.Calls)-1]
	}
	if saveErr := manager.appendAuditLocked(task, "call", inv, auditCall); saveErr != nil && err == nil {
		err = saveErr
	}
	if err == nil && tool != "read_session" && tool != "list_targets" {
		manager.cached[key] = result
	}
	manager.mu.Unlock()
	return result, err
}
