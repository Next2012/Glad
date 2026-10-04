package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const supervisorAuditLimit = 4 << 20

type supervisorAuditEvent struct {
	Type         string                `json:"type"`
	InvocationID string                `json:"invocationId"`
	Invocation   *SupervisorInvocation `json:"invocation,omitempty"`
	Call         *SupervisorCall       `json:"call,omitempty"`
}

func OpenSupervisorManager(directory string, rooms *RoomManager, sessions *SessionManager) (*SupervisorManager, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	manager := &SupervisorManager{directory: directory, tasks: map[string]*SupervisorTask{}, rooms: rooms, sessions: sessions, cached: map[string]map[string]any{}}
	files, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, file.Name()))
		var task SupervisorTask
		if err == nil {
			err = json.Unmarshal(data, &task)
		}
		if err == nil && (task.SchemaVersion != 2 || !safeUploadIDPattern.MatchString(task.ID) || file.Name() != task.ID+".json") {
			err = errors.New("unsupported version or invalid task identity")
		}
		if err != nil {
			manager.warnLocked(file.Name() + ": " + err.Error())
			continue
		}
		task.Invocations, err = manager.readAuditLocked(task.ID, true)
		if err != nil {
			manager.warnLocked(file.Name() + ": " + err.Error())
			continue
		}
		task.Enabled, task.RunOnce, task.Status, task.NextAt = false, false, "paused", 0
		for i := range task.Invocations {
			inv := &task.Invocations[i]
			if inv.EndedAt == 0 {
				inv.EndedAt = millis()
				inv.Status = "interrupted"
				inv.Revoked = true
				inv.Summary = "Daemon restarted; resume supervision after restoring members."
				if err := manager.appendAuditLocked(&task, "end", inv, nil); err != nil {
					manager.warnLocked(file.Name() + ": " + err.Error())
				}
			}
		}
		if err := manager.saveLocked(&task); err != nil {
			manager.warnLocked(file.Name() + ": " + err.Error())
			continue
		}
		manager.tasks[task.ID] = &task
	}
	return manager, nil
}
func (manager *SupervisorManager) warnLocked(message string) {
	for _, existing := range manager.loadWarnings {
		if existing == message {
			return
		}
	}
	manager.loadWarnings = append(manager.loadWarnings, message)
	log.Printf("[supervisor] %s", message)
}
func (manager *SupervisorManager) saveLocked(task *SupervisorTask) error {
	data, err := json.MarshalIndent(task, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(manager.directory, task.ID+".json")
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func (manager *SupervisorManager) appendAuditLocked(task *SupervisorTask, kind string, inv *SupervisorInvocation, call *SupervisorCall) error {
	if kind == "call" && call == nil {
		return nil
	}
	event := supervisorAuditEvent{Type: kind, InvocationID: inv.ID, Call: call}
	if kind != "call" {
		copy := *inv
		copy.Calls = nil
		event.Invocation = &copy
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := filepath.Join(manager.directory, task.ID+".audit.jsonl")
	if stat, err := os.Stat(path); err == nil && stat.Size()+int64(len(data)) > supervisorAuditLimit {
		previous := filepath.Join(manager.directory, task.ID+".audit.1.jsonl")
		if err := os.Remove(previous); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(path, previous); err != nil {
			return err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	offset, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	n, err := file.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		_ = file.Truncate(offset)
		return err
	}
	return file.Sync()
}
func (manager *SupervisorManager) readAuditLocked(id string, repair bool) ([]SupervisorInvocation, error) {
	runs := map[string]*SupervisorInvocation{}
	order := []string{}
	for _, name := range []string{id + ".audit.1.jsonl", id + ".audit.jsonl"} {
		path := filepath.Join(manager.directory, name)
		file, err := os.Open(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(file, supervisorAuditLimit+1))
		_ = file.Close()
		if err != nil {
			return nil, err
		}
		if len(data) > supervisorAuditLimit {
			return nil, errors.New("audit file exceeds its size limit")
		}
		end := bytes.LastIndexByte(data, '\n') + 1
		if end < len(data) {
			manager.warnLocked(name + ": incomplete trailing audit record ignored")
			if repair && name == id+".audit.jsonl" {
				if err := os.Truncate(path, int64(end)); err != nil {
					return nil, err
				}
			}
			data = data[:end]
		}
		scanner := bufio.NewScanner(bytes.NewReader(data))
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			var event supervisorAuditEvent
			if json.Unmarshal(scanner.Bytes(), &event) != nil || !safeUploadIDPattern.MatchString(event.InvocationID) {
				manager.warnLocked(name + ": malformed audit record ignored")
				continue
			}
			run := runs[event.InvocationID]
			if event.Invocation != nil && event.Invocation.ID == event.InvocationID {
				if run == nil {
					copy := *event.Invocation
					run = &copy
					runs[event.InvocationID] = run
					order = append(order, event.InvocationID)
				} else {
					calls := run.Calls
					*run = *event.Invocation
					run.Calls = calls
				}
			} else if event.Type == "call" && event.Call != nil && run != nil && len(run.Calls) < 200 {
				run.Calls = append(run.Calls, *event.Call)
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
	}
	result := []SupervisorInvocation{}
	for _, id := range order {
		result = append(result, *runs[id])
	}
	if len(result) > 100 {
		result = append([]SupervisorInvocation(nil), result[len(result)-100:]...)
	}
	return result, nil
}

func invocationSummary(inv *SupervisorInvocation) map[string]any {
	if inv == nil {
		return nil
	}
	return map[string]any{"id": inv.ID, "startedAt": inv.StartedAt, "endedAt": inv.EndedAt, "status": inv.Status, "summary": inv.Summary, "callCount": len(inv.Calls), "stopRequested": inv.StopRequested, "stopError": inv.StopError}
}
func taskSummary(task *SupervisorTask) map[string]any {
	var last *SupervisorInvocation
	if len(task.Invocations) > 0 {
		last = &task.Invocations[len(task.Invocations)-1]
	}
	ids := []string{}
	for _, target := range task.Targets {
		ids = append(ids, target.MemberID)
	}
	return map[string]any{"id": task.ID, "executorMemberId": task.ExecutorMemberID, "targetMemberIds": ids, "promptSummary": codexPreviewText(strings.SplitN(task.Prompt, "\n", 2)[0], 100), "enabled": task.Enabled, "runOnce": task.RunOnce, "status": task.Status, "nextAt": task.NextAt, "runCount": task.RunCount, "lastRun": invocationSummary(last), "lastError": task.LastError, "revision": task.Revision}
}
func (manager *SupervisorManager) summaryResponse(roomID string) map[string]any {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	selected := []*SupervisorTask{}
	for _, task := range manager.tasks {
		if task.RoomID == roomID {
			selected = append(selected, task)
		}
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].CreatedAt < selected[j].CreatedAt })
	items := []map[string]any{}
	for _, task := range selected {
		items = append(items, taskSummary(task))
	}
	return map[string]any{"success": true, "serverNow": millis(), "tasks": items, "loadErrorCount": len(manager.loadWarnings), "warnings": append([]string{}, manager.loadWarnings...)}
}
func (server *Server) supervisorDetail(writer http.ResponseWriter, request *http.Request) {
	if server.supervisors == nil {
		respondError(writer, 503, errors.New("Supervisor service unavailable"))
		return
	}
	room, err := server.rooms.GetRecord(request.PathValue("id"))
	if err != nil || !server.rooms.IsActive(request.PathValue("id")) {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	manager := server.supervisors
	manager.mu.Lock()
	defer manager.mu.Unlock()
	task := manager.tasks[request.PathValue("taskId")]
	if task == nil || task.RoomID != room.ID {
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	if !strings.Contains(request.URL.Path, "/history") {
		respondJSON(writer, 200, map[string]any{"success": true, "serverNow": millis(), "task": cloneSupervisor(task), "summary": taskSummary(task)})
		return
	}
	if invID := request.PathValue("invocationId"); invID != "" {
		for i := range task.Invocations {
			if task.Invocations[i].ID == invID {
				data, _ := json.Marshal(task.Invocations[i])
				var copy SupervisorInvocation
				_ = json.Unmarshal(data, &copy)
				respondJSON(writer, 200, map[string]any{"success": true, "invocation": copy})
				return
			}
		}
		server.writeRoomError(writer, errRoomNotFound)
		return
	}
	limit := min(50, max(1, atoiDefault(request.URL.Query().Get("limit"), 20)))
	before := request.URL.Query().Get("before")
	index := len(task.Invocations) - 1
	reset := false
	if before != "" {
		found := false
		for i := range task.Invocations {
			if task.Invocations[i].ID == before {
				index = i - 1
				found = true
				break
			}
		}
		reset = !found
	}
	items := []map[string]any{}
	for index >= 0 && len(items) < limit {
		items = append(items, invocationSummary(&task.Invocations[index]))
		index--
	}
	next := ""
	if index >= 0 && len(items) > 0 {
		next = stringValue(items[len(items)-1]["id"])
	}
	respondJSON(writer, 200, map[string]any{"success": true, "items": items, "nextCursor": next, "hasMore": next != "", "reset": reset, "serverNow": millis()})
}
