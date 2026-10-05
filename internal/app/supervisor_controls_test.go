package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func supervisorControlFixture(t *testing.T) (*SupervisorManager, *supervisorTestProvider, SupervisorTask, string) {
	t.Helper()
	rooms, executor, _, room, member := newRuntimeRoomTest(t)
	provider := &supervisorTestProvider{session: executor}
	executor.Provider = provider
	worker := newSession("control-worker", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	worker.Provider = &stubProvider{}
	rooms.sessions.sessions[worker.ID] = worker
	target, err := rooms.AddSession(room.ID, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := OpenSupervisorManager(t.TempDir(), rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	manager.ctx = context.Background()
	task, err := manager.Save(room.ID, "", SupervisorTask{ExecutorMemberID: member.ID, Targets: []SupervisorTarget{{MemberID: target.ID, Read: true}}, IntervalSeconds: 60, Prompt: "Inspect the worker"})
	if err != nil {
		t.Fatal(err)
	}
	return manager, provider, task, room.ID
}
func startSupervisorTest(t *testing.T, manager *SupervisorManager, roomID, taskID string) {
	t.Helper()
	if err := manager.Action(roomID, taskID, "trigger"); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	manager.wg.Wait()
}
func TestSupervisorPauseKeepsCurrentRunAndDisablesNextCheck(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	startSupervisorTest(t, manager, roomID, task.ID)
	if err := manager.Action(roomID, task.ID, "pause"); err != nil {
		t.Fatal(err)
	}
	if provider.session.StatusValue != "running" {
		t.Fatal("pause interrupted the current run")
	}
	provider.finish()
	manager.tick()
	result := manager.List(roomID)[0]
	if result.Enabled || result.RunOnce || result.NextAt != 0 || result.Status != "paused" {
		t.Fatalf("unexpected paused state: %#v", result)
	}
}
func TestSupervisorStopRunPreservesSwitchAndDoesNotBackOff(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	startSupervisorTest(t, manager, roomID, task.ID)
	if err := manager.Action(roomID, task.ID, "stop"); err != nil {
		t.Fatal(err)
	}
	result := manager.List(roomID)[0]
	if !result.Enabled || result.Status != "stopping" || !result.Invocations[0].StopRequested {
		t.Fatal("stop disabled monitoring or skipped stopping state")
	}
	provider.session.appendMessage(map[string]any{"kind": "turn-end", "turnId": "test-turn-1", "status": "cancelled", "isRootTurn": true})
	provider.session.setState(map[string]any{"status": "idle"})
	manager.tick()
	result = manager.List(roomID)[0]
	if result.Invocations[0].Status != "stopped" || !result.Enabled || result.NextAt-result.Invocations[0].EndedAt > 61000 || manager.tasks[task.ID].failures != 0 {
		t.Fatalf("stop counted as a failure: %#v", result)
	}
	next := result.NextAt
	if err := manager.Action(roomID, task.ID, "stop"); err != nil {
		t.Fatal(err)
	}
	if manager.List(roomID)[0].NextAt != next {
		t.Fatal("stop without a run changed schedule")
	}
}

func TestSupervisorStopRequestDoesNotRelabelNaturalCompletion(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	startSupervisorTest(t, manager, roomID, task.ID)
	if err := manager.Action(roomID, task.ID, "stop"); err != nil {
		t.Fatal(err)
	}
	provider.finish()
	manager.tick()
	if result := manager.List(roomID)[0]; result.Invocations[0].Status != "completed" || !result.Enabled {
		t.Fatal("natural completion was reported as stopped")
	}
}
func TestSupervisorRunOnceLeavesPausedTaskPaused(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	if err := manager.Action(roomID, task.ID, "pause"); err != nil {
		t.Fatal(err)
	}
	startSupervisorTest(t, manager, roomID, task.ID)
	if manager.List(roomID)[0].Enabled {
		t.Fatal("run once enabled recurring monitoring")
	}
	provider.finish()
	manager.tick()
	result := manager.List(roomID)[0]
	if result.Enabled || result.RunOnce || result.Status != "paused" || result.NextAt != 0 {
		t.Fatalf("run once repeated: %#v", result)
	}
	manager.tick()
	if provider.calls.Load() != 1 {
		t.Fatal("run once started a second invocation")
	}
}
func TestSupervisorEditPreservesSwitchAndPromptEditKeepsCountdown(t *testing.T) {
	manager, _, task, roomID := supervisorControlFixture(t)
	next := task.NextAt
	task.Prompt = "Edited prompt"
	task.Enabled = false
	updated, err := manager.Save(roomID, task.ID, task)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Enabled || updated.NextAt != next {
		t.Fatal("editing config changed enabled state or postponed check")
	}
	if err := manager.Action(roomID, task.ID, "pause"); err != nil {
		t.Fatal(err)
	}
	task.Enabled = true
	task.IntervalSeconds = 120
	updated, err = manager.Save(roomID, task.ID, task)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Enabled || updated.NextAt != 0 {
		t.Fatal("editing paused task enabled it")
	}
}
func TestSupervisorBrokenFilesDoNotBlockStartup(t *testing.T) {
	manager, _, task, roomID := supervisorControlFixture(t)
	broken := filepath.Join(manager.directory, "broken-task.json")
	if err := os.WriteFile(broken, []byte("{bad json"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"schemaVersion": 99, "id": "future-task"})
	future := filepath.Join(manager.directory, "future-task.json")
	_ = os.WriteFile(future, data, 0600)
	reloaded, err := OpenSupervisorManager(manager.directory, manager.rooms, manager.sessions)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.List(roomID)) != 1 || reloaded.List(roomID)[0].ID != task.ID || len(reloaded.loadWarnings) != 2 {
		t.Fatal("bad files were not reported independently")
	}
	if contents, _ := os.ReadFile(broken); string(contents) != "{bad json" {
		t.Fatal("damaged original was modified")
	}
}
func TestSupervisorAuditAppendsAndRecoversIncompleteTail(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	startSupervisorTest(t, manager, roomID, task.ID)
	configPath := filepath.Join(manager.directory, task.ID+".json")
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	inv := manager.List(roomID)[0].Invocations[0]
	if _, err := manager.Call(context.Background(), provider.session, "list_targets", "call-1", map[string]any{"invocationId": inv.ID}); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(configPath)
	if string(before) != string(after) || strings.Contains(string(after), "invocations") {
		t.Fatal("call audit rewrote configuration")
	}
	provider.finish()
	manager.tick()
	path := filepath.Join(manager.directory, task.ID+".audit.jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString(`{"type":"call","incomplete":`)
	_ = file.Close()
	reloaded, err := OpenSupervisorManager(manager.directory, manager.rooms, manager.sessions)
	if err != nil {
		t.Fatal(err)
	}
	record := reloaded.List(roomID)[0].Invocations[0]
	if record.Status != "completed" || len(record.Calls) != 1 {
		t.Fatal("audit history was not restored")
	}
	data, _ := os.ReadFile(path)
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatal("incomplete append tail was not repaired")
	}
	// Append failure must surface, not silently lose the audit.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := manager.appendAuditLocked(manager.tasks[task.ID], "call", &record, &SupervisorCall{ID: "fail"}); err == nil {
		t.Fatal("append failure was ignored")
	}
}
func TestSupervisorSummaryAndHistoryAreLoadedSeparately(t *testing.T) {
	manager, provider, task, roomID := supervisorControlFixture(t)
	for i := 0; i < 3; i++ {
		startSupervisorTest(t, manager, roomID, task.ID)
		provider.finish()
		manager.tick()
	}
	server := &Server{supervisors: manager, rooms: manager.rooms, sessions: manager.sessions}
	mux := http.NewServeMux()
	server.registerSupervisorRoutes(mux)
	get := func(path string) map[string]any {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			t.Fatalf("GET %s: %s", path, response.Body.String())
		}
		var result map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		return result
	}
	list := get("/api/rooms/" + roomID + "/supervisors")
	summary := list["tasks"].([]any)[0].(map[string]any)
	if summary["invocations"] != nil || summary["prompt"] != nil || list["serverNow"] == nil {
		t.Fatal("summary contains full history/config or lacks server time")
	}
	page := get("/api/rooms/" + roomID + "/supervisors/" + task.ID + "/history?limit=2")
	if len(page["items"].([]any)) != 2 || !boolValue(page["hasMore"]) {
		t.Fatal("history pagination did not bound response")
	}
	item := page["items"].([]any)[0].(map[string]any)
	if item["calls"] != nil || item["prompt"] != nil {
		t.Fatal("history summary contains details")
	}
	detail := get("/api/rooms/" + roomID + "/supervisors/" + task.ID + "/history/" + stringValue(item["id"]))
	if mapValue(detail["invocation"])["prompt"] != task.Prompt {
		t.Fatal("invocation details were not available")
	}
}

func TestSupervisorAuditRotationRetainsCurrentRun(t *testing.T) {
	manager, _, task, _ := supervisorControlFixture(t)
	inv := SupervisorInvocation{ID: newUUID(), StartedAt: millis(), Status: "running", Prompt: task.Prompt}
	start, _ := json.Marshal(supervisorAuditEvent{Type: "start", InvocationID: inv.ID, Invocation: &inv})
	call, _ := json.Marshal(supervisorAuditEvent{Type: "call", InvocationID: inv.ID, Call: &SupervisorCall{ID: "call", Summary: strings.Repeat("x", 2000)}})
	var data bytes.Buffer
	data.Write(start)
	data.WriteByte('\n')
	for data.Len()+len(call)+1 < supervisorAuditLimit-200 {
		data.Write(call)
		data.WriteByte('\n')
	}
	path := filepath.Join(manager.directory, task.ID+".audit.jsonl")
	if err := os.WriteFile(path, data.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	inv.EndedAt = millis()
	inv.Status = "completed"
	inv.Summary = strings.Repeat("done", 1000)
	if err := manager.appendAuditLocked(manager.tasks[task.ID], "end", &inv, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(manager.directory, task.ID+".audit.1.jsonl")); err != nil {
		t.Fatal("audit was not rotated")
	}
	runs, err := manager.readAuditLocked(task.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != "completed" || len(runs[0].Calls) != 200 {
		t.Fatal("rotation lost invocation or ignored call bound")
	}
}

func TestSupervisorStopPermissionRequiresRead(t *testing.T) {
	manager, _, task, roomID := supervisorControlFixture(t)
	input := task
	input.Targets = append([]SupervisorTarget(nil), task.Targets...)
	input.Targets[0].Read = false
	input.Targets[0].Stop = true
	for _, id := range []string{"", task.ID} {
		if _, err := manager.Save(roomID, id, input); err == nil || !strings.Contains(err.Error(), "Stop permission requires Read") {
			t.Fatalf("accepted stop without read: %v", err)
		}
	}
	if !manager.tasks[task.ID].Targets[0].Read || manager.tasks[task.ID].Targets[0].Stop {
		t.Fatal("invalid edit mutated saved permissions")
	}
	input.Targets[0].Read = true
	input.Targets[0].Send = false
	if _, err := manager.Save(roomID, task.ID, input); err != nil {
		t.Fatalf("rejected read + stop without send: %v", err)
	}
	input.Targets[0].Read, input.Targets[0].Stop, input.Targets[0].Send = false, false, true
	if _, err := manager.Save(roomID, task.ID, input); err != nil {
		t.Fatalf("rejected independent send permission: %v", err)
	}
}
