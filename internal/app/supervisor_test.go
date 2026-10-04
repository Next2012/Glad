package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type supervisorTestProvider struct {
	stubProvider
	session *Session
	calls   atomic.Int32
	turnID  string
}

func (provider *supervisorTestProvider) CanAccept() (bool, string) {
	provider.session.mu.RLock()
	defer provider.session.mu.RUnlock()
	return provider.session.StatusValue == "idle", "Test session busy"
}
func (provider *supervisorTestProvider) Send(_ context.Context, input ProviderInput) error {
	provider.calls.Add(1)
	provider.session.beginInput(input)
	provider.session.appendMessage(map[string]any{"kind": "user", "text": input.Text, "agentText": input.AgentText, "clientMessageId": input.ClientMessageID, "turnId": "test-turn-" + fmt.Sprint(provider.calls.Load())})
	provider.session.appendMessage(map[string]any{"kind": "turn-start", "turnId": "test-turn-" + fmt.Sprint(provider.calls.Load()), "isRootTurn": true})
	provider.session.setState(map[string]any{"status": "running"})
	return nil
}
func (provider *supervisorTestProvider) finish() {
	provider.session.appendMessage(map[string]any{"kind": "assistant", "turnId": "test-turn-" + fmt.Sprint(provider.calls.Load()), "text": "Checked the worker"})
	provider.session.appendMessage(map[string]any{"kind": "turn-end", "turnId": "test-turn-" + fmt.Sprint(provider.calls.Load()), "status": "completed", "isRootTurn": true})
	provider.session.markCompletionUnread()
	provider.session.setState(map[string]any{"status": "idle"})
}

func TestSessionControlSerializesBusySendsAndDeduplicates(t *testing.T) {
	session := newSession("control-test", "Test", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := &supervisorTestProvider{session: session}
	session.Provider = provider
	var wait sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if sendSessionControlled(context.Background(), session, ProviderInput{ClientMessageID: newUUID(), Text: "work", AgentText: "work"}) == nil {
				accepted.Add(1)
			}
		}()
	}
	wait.Wait()
	if accepted.Load() != 1 || provider.calls.Load() != 1 {
		t.Fatalf("concurrent sends accepted %d; provider calls %d", accepted.Load(), provider.calls.Load())
	}
	session.mu.RLock()
	id := stringValue(session.Messages[0]["clientMessageId"])
	session.mu.RUnlock()
	if err := sendSessionControlled(context.Background(), session, ProviderInput{ClientMessageID: id, Text: "work", AgentText: "work"}); err != nil {
		t.Fatal(err)
	}
	if err := sendSessionControlled(context.Background(), session, ProviderInput{ClientMessageID: id, Text: "different", AgentText: "different"}); err == nil {
		t.Fatal("ID reused with different content")
	}
}
func TestSessionOutputTracksPatchesStateAndReset(t *testing.T) {
	session := newSession("output-test", "Test", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.Provider = &stubProvider{}
	message := session.appendMessage(map[string]any{"kind": "assistant", "text": "first"})
	first := sessionOutput(session, 0, 50, 0, false)
	cursor := first["cursor"].(uint64)
	session.patchMessage(stringValue(message["id"]), map[string]any{"text": "first and second"})
	updated := sessionOutput(session, cursor, 50, 0, false)
	if boolValue(updated["reset"]) || len(updated["messages"].([]map[string]any)) != 1 || stringValue(updated["messages"].([]map[string]any)[0]["text"]) != "first and second" {
		t.Fatalf("missing patch: %#v", updated)
	}
	cursor = updated["cursor"].(uint64)
	session.setState(map[string]any{"status": "running"})
	state := sessionOutput(session, cursor, 50, 0, false)
	if state["cursor"].(uint64) <= cursor || stringValue(state["status"]) != "running" {
		t.Fatal("state revision did not advance")
	}
	session.replaceMessages([]map[string]any{{"id": "native", "kind": "assistant", "text": "loaded history"}})
	reset := sessionOutput(session, cursor, 50, 0, false)
	if !boolValue(reset["reset"]) {
		t.Fatal("history replacement did not reset cursor")
	}
}

func TestSessionOutputCursorDoesNotReplaceCompletionRevision(t *testing.T) {
	session := newSession("completion-cursor", "Test", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	subscription := session.events.Subscribe(session.ID, 16)
	defer subscription.Close()
	for i := 0; i < 5; i++ {
		session.appendMessage(map[string]any{"kind": "assistant", "text": "progress"})
	}
	revision := session.markCompletionUnread()
	for i := 0; i < 6; i++ {
		event := <-subscription.Events()
		if stringValue(event.Payload["type"]) != "completion" {
			continue
		}
		if numberInt64(event.Payload["revision"]) != int64(revision) || numberInt64(event.Payload["outputRevision"]) <= int64(revision) {
			t.Fatal("output cursor replaced completion revision")
		}
		if ok, _ := session.markCompletionRead(uint64(numberInt64(event.Payload["revision"]))); !ok {
			t.Fatal("completion acknowledgement was rejected")
		}
		return
	}
	t.Fatal("missing completion event")
}
func TestSupervisorEnvelopeSurvivesNativeHistoryAndOnlyMatchesTopLevel(t *testing.T) {
	source := &SupervisorSource{Version: 1, TaskID: "task-test", InvocationID: "invocation-test", Kind: "trigger"}
	text := supervisorAgentText(source, "work")
	parsed, body := supervisorEnvelope(text)
	if parsed == nil || parsed.InvocationID != source.InvocationID || body != "work" {
		t.Fatal("envelope did not roundtrip")
	}
	if parsed, _ := supervisorEnvelope("Quoted example:\n" + text); parsed != nil {
		t.Fatal("ordinary quoted text treated as an invocation")
	}
	rooms, session, _, room, member := newRuntimeRoomTest(t)
	session.Messages = []map[string]any{{"kind": "user", "text": text, "turnId": "native-turn", "createdAt": int64(1)}, {"kind": "assistant", "text": "private check", "turnId": "native-turn", "createdAt": int64(2)}}
	view, err := rooms.GetPublic(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(view["entries"].([]map[string]any)) != 0 {
		t.Fatal("native supervisor trigger leaked into room")
	}
	source.Kind = "command"
	session.Messages[0]["text"] = supervisorAgentText(source, buildRoomAgentTextForRoom(room.ID, "visible command", nil, nil))
	view, _ = rooms.GetPublic(room.ID)
	entries := view["entries"].([]map[string]any)
	if len(entries) != 2 || entries[0]["text"] != "visible command" {
		t.Fatalf("command was not visible for %s: %#v", member.ID, entries)
	}
}
func TestSupervisorInvocationPermissionsHistoryAndLifecycle(t *testing.T) {
	rooms, executor, _, room, executorMember := newRuntimeRoomTest(t)
	provider := &supervisorTestProvider{session: executor}
	executor.Provider = provider
	worker := newSession("worker-test", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	worker.Provider = &stubProvider{}
	rooms.sessions.sessions[worker.ID] = worker
	workerMember, err := rooms.AddSession(room.ID, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := OpenSupervisorManager(filepath.Join(t.TempDir(), "supervisors"), rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	manager.ctx = context.Background()
	task, err := manager.Save(room.ID, "", SupervisorTask{ExecutorMemberID: executorMember.ID, Targets: []SupervisorTarget{{MemberID: workerMember.ID, Read: true}}, IntervalSeconds: 60, Prompt: "Check the worker", Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Call(context.Background(), executor, "list_targets", "normal", map[string]any{"invocationId": "unknown"}); err == nil {
		t.Fatal("ordinary conversation got supervisor permissions")
	}
	if err := manager.Action(room.ID, task.ID, "trigger"); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	manager.wg.Wait()
	tasks := manager.List(room.ID)
	inv := tasks[0].Invocations[0]
	args := map[string]any{"invocationId": inv.ID, "memberId": workerMember.ID}
	if _, err := manager.Call(context.Background(), executor, "read_session", "read", args); err != nil {
		t.Fatal(err)
	}
	args["text"] = "do work"
	if _, err := manager.Call(context.Background(), executor, "send_to_session", "denied", args); err == nil {
		t.Fatal("send permission was ignored")
	}
	provider.finish()
	manager.tick()
	tasks = manager.List(room.ID)
	if tasks[0].Status != "scheduled" || tasks[0].NextAt < tasks[0].Invocations[0].EndedAt+60000 || tasks[0].Invocations[0].Status != "completed" {
		t.Fatalf("did not schedule after completion: %#v", tasks[0])
	}
	if executor.HasUnreadCompletion {
		t.Fatal("automated completion marked unread")
	}
	if _, err := manager.Call(context.Background(), executor, "read_session", "old", args); err == nil {
		t.Fatal("old invocation kept permissions")
	}
	if len(tasks[0].Invocations[0].Calls) != 2 {
		t.Fatal("successful call not audited")
	}
	if err := rooms.Close(room.ID); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	if manager.List(room.ID)[0].Enabled {
		t.Fatal("closing the room did not pause the task")
	}
	reloaded, err := OpenSupervisorManager(manager.directory, rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.List(room.ID)[0].Enabled {
		t.Fatal("restart automatically enabled supervision")
	}
}
func TestSupervisorMCPProtocolAndDaemonErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing credential")
		}
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"error":"Current turn is not a supervisor invocation"}`))
	}))
	defer server.Close()
	t.Setenv("GLAD_SUPERVISOR_URL", server.URL)
	t.Setenv("GLAD_SUPERVISOR_TOKEN", "test-token")
	t.Setenv("GLAD_SUPERVISOR_SESSION", "test-session")
	input := strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\"}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"list_targets\",\"arguments\":{\"invocationId\":\"old\"}}}\n")
	var output bytes.Buffer
	if err := serveSupervisorMCP(input, &output); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("unexpected stdout: %s", output.String())
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(lines[2]), &response); err != nil {
		t.Fatal(err)
	}
	if !boolValue(mapValue(response["result"])["isError"]) {
		t.Fatal("denial was not returned as MCP tool error")
	}
}
func TestSupervisorQuietEventsKeepFailuresVisible(t *testing.T) {
	source := (&SupervisorSource{Version: 1, TaskID: "task-test", InvocationID: "inv-test", Kind: "trigger"}).values()
	event := map[string]any{"supervisorSource": source, "message": map[string]any{"kind": "turn-end", "status": "completed"}}
	if !quietSupervisorCompletion(event) {
		t.Fatal("completion was not quiet")
	}
	mapValue(event["message"])["status"] = "failed"
	if quietSupervisorCompletion(event) {
		t.Fatal("failure was muted")
	}
}

func TestSupervisorCapacityRetryInheritsInvocationEnvelope(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	source := &SupervisorSource{Version: 1, TaskID: "task-retry", InvocationID: "invocation-retry", Kind: "trigger"}
	provider.session.beginInput(ProviderInput{Source: source})
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	request := triggerCapacityRetry(t, provider, writes, "retried-supervisor-turn")
	parsed, text := supervisorEnvelope(textFromCodexInput(mapValue(request["params"])["input"]))
	if parsed == nil || parsed.InvocationID != source.InvocationID || text != "继续" {
		t.Fatalf("retry lost provenance: %#v", request)
	}
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "retried-supervisor-turn"}})
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "retried-supervisor-turn", "status": "completed"}})
	if provider.session.HasUnreadCompletion {
		t.Fatal("retry completion was not quiet")
	}
}

func TestDeletingRunningSupervisorReleasesReservationOnlyAfterSettlement(t *testing.T) {
	rooms, executor, _, room, executorMember := newRuntimeRoomTest(t)
	provider := &supervisorTestProvider{session: executor}
	executor.Provider = provider
	worker := newSession("delete-worker", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	worker.Provider = &stubProvider{}
	rooms.sessions.sessions[worker.ID] = worker
	member, err := rooms.AddSession(room.ID, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := OpenSupervisorManager(t.TempDir(), rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	manager.ctx = context.Background()
	task, err := manager.Save(room.ID, "", SupervisorTask{ExecutorMemberID: executorMember.ID, Targets: []SupervisorTarget{{MemberID: member.ID, Read: true}}, IntervalSeconds: 60, Prompt: "Check"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Action(room.ID, task.ID, "trigger"); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	manager.wg.Wait()
	if err := manager.Action(room.ID, task.ID, "delete"); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	if ready, _ := sessionCanAccept(executor); ready {
		t.Fatal("running executor became available after deleting its task")
	}
	provider.finish()
	manager.tick()
	if ready, _ := sessionCanAccept(executor); !ready {
		t.Fatal("deleted supervisor left a permanent reservation")
	}
}
