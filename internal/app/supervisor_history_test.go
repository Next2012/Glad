package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSupervisorHistoryIndexesOriginalAndReadsAllBytes(t *testing.T) {
	session := newSession("history", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.State["threadId"] = "original"
	path := filepath.Join(t.TempDir(), "original.jsonl")
	line := func(text string) string {
		data, _ := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}}})
		return string(data) + "\n"
	}
	original := line(strings.Repeat("完整原文", 10000)) + line("second request")
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "original", "path": path})
	manager := &SupervisorManager{}
	index, err := manager.sessionHistory(context.Background(), session, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if index["rawPath"] != path || !boolValue(index["hasMore"]) || numberInt64(index["total"]) != 2 {
		t.Fatalf("bad index: %#v", index)
	}
	var body strings.Builder
	offset := int64(0)
	for {
		chunk, err := readSessionRecord(context.Background(), session, offset, 8192)
		if err != nil {
			t.Fatal(err)
		}
		body.WriteString(stringValue(chunk["text"]))
		if !boolValue(chunk["hasMore"]) {
			break
		}
		next := numberInt64(chunk["nextOffset"])
		if next <= offset {
			t.Fatal("reader did not advance")
		}
		offset = next
	}
	if body.String() != original {
		t.Fatal("full original record was truncated or changed")
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	third := line("third request")
	_, _ = file.WriteString(third[:len(third)-1])
	_ = file.Close()
	index, err = manager.sessionHistory(context.Background(), session, 1, 50)
	if err != nil || numberInt64(index["total"]) != 2 {
		t.Fatal("partial record indexed", err)
	}
	file, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = file.WriteString("\n")
	_ = file.Close()
	index, err = manager.sessionHistory(context.Background(), session, 1, 50)
	if err != nil || numberInt64(index["total"]) != 3 || !strings.Contains(stringValue(index["indexMarkdown"]), "third request") {
		t.Fatal("appended history missing", err)
	}
	if err := os.WriteFile(path, []byte(line("replacement")), 0600); err != nil {
		t.Fatal(err)
	}
	index, err = manager.sessionHistory(context.Background(), session, 0, 50)
	if err != nil || numberInt64(index["total"]) != 1 {
		t.Fatal("replacement did not reset index", err)
	}
}

func TestSupervisorLargeIndexFallsBackToStreamingPages(t *testing.T) {
	session := newSession("index", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.State["threadId"] = "source"
	path := filepath.Join(t.TempDir(), "source.jsonl")
	record := "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"index entry\"}}\n"
	if err := os.WriteFile(path, []byte(strings.Repeat(record, 3)), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "source", "path": path})
	manager := &SupervisorManager{}
	if _, err := manager.sessionHistory(context.Background(), session, 0, 2); err != nil {
		t.Fatal(err)
	}
	// Reach the cache budget without allocating a large test fixture.
	manager.historyIndexes[path].Bytes = supervisorIndexCacheBytes
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(record); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	page, err := manager.sessionHistory(context.Background(), session, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if numberInt64(page["total"]) != 4 || numberInt64(page["nextOffset"]) != 3 || !boolValue(page["hasMore"]) || !strings.Contains(stringValue(page["indexMarkdown"]), "| 3 |") {
		t.Fatalf("streamed index lost its position: %#v", page)
	}
	if manager.historyIndexes[path] != nil {
		t.Fatal("oversized index remained cached")
	}
}

func TestOriginalRecordShortChunksPreserveUTF8(t *testing.T) {
	session := newSession("utf8", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	session.State["threadId"] = "source"
	path := filepath.Join(t.TempDir(), "source.jsonl")
	original := "a你b好\n"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	session.rememberTranscriptPath(map[string]any{"id": "source", "path": path})
	var actual strings.Builder
	for offset := int64(0); offset < int64(len(original)); {
		chunk, err := readSessionRecord(context.Background(), session, offset, 3)
		if err != nil {
			t.Fatal(err)
		}
		actual.WriteString(stringValue(chunk["text"]))
		next := numberInt64(chunk["nextOffset"])
		if next <= offset {
			t.Fatal("reader did not advance")
		}
		offset = next
	}
	if actual.String() != original {
		t.Fatal("short chunks dropped UTF-8 content")
	}
}

func TestSupervisorAnswersRunningQuestionWithPermissionsAndAudit(t *testing.T) {
	rooms, executor, _, room, executorMember := newRuntimeRoomTest(t)
	executorProvider := &supervisorTestProvider{session: executor}
	executor.Provider = executorProvider
	worker, writes := questionTestProvider(t)
	rooms.sessions.sessions[worker.session.ID] = worker.session
	member, err := rooms.AddSession(room.ID, worker.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := OpenSupervisorManager(filepath.Join(t.TempDir(), "supervisors"), rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	manager.ctx = context.Background()
	task, err := manager.Save(room.ID, "", SupervisorTask{ExecutorMemberID: executorMember.ID, Targets: []SupervisorTarget{{MemberID: member.ID, Read: true, Send: true}}, IntervalSeconds: 60, Prompt: "answer", Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Action(room.ID, task.ID, "trigger"); err != nil {
		t.Fatal(err)
	}
	manager.tick()
	manager.wg.Wait()
	inv := manager.List(room.ID)[0].Invocations[0]
	question := addTestQuestion(worker, true)
	for i := 0; i < 80; i++ {
		worker.session.appendMessage(map[string]any{"kind": "assistant", "text": "progress"})
	}
	args := map[string]any{"invocationId": inv.ID, "memberId": member.ID}
	result, err := manager.Call(context.Background(), executor, "read_session", "read", args)
	if err != nil || len(result["pendingQuestions"].([]map[string]any)) != 1 {
		t.Fatal("old pending question was not exposed", err)
	}
	args["questionId"] = question
	args["answers"] = map[string]any{"q1": "1000", "q2": "2"}
	done := make(chan error, 1)
	go func() {
		_, err := manager.Call(context.Background(), executor, "answer_question", "answer", args)
		done <- err
	}()
	var request map[string]any
	if err := json.Unmarshal(<-writes, &request); err != nil {
		t.Fatal(err)
	}
	if request["method"] != "turn/steer" {
		t.Fatalf("answer interrupted or restarted: %#v", request)
	}
	worker.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turnId": "turn"}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if worker.session.StatusValue != "running" || questionMessage(worker, question)["questionStatus"] != "answered" {
		t.Fatal("answer stopped worker")
	}
	if _, err := manager.Call(context.Background(), executor, "answer_question", "answer", args); err != nil || len(writes) != 0 {
		t.Fatal("retry was not idempotent", err)
	}
	manager.mu.Lock()
	manager.tasks[task.ID].Targets[0].Send = false
	manager.mu.Unlock()
	if _, err := manager.Call(context.Background(), executor, "answer_question", "denied", args); err == nil {
		t.Fatal("answer bypassed Send permission")
	}
	if calls := manager.List(room.ID)[0].Invocations[0].Calls; len(calls) < 3 || calls[1].Tool != "answer_question" || !calls[1].Success {
		t.Fatal("answer was not audited")
	}
}

func TestSupervisorQuestionWakeCoalescesWithoutOverlapping(t *testing.T) {
	rooms, executor, _, room, executorMember := newRuntimeRoomTest(t)
	provider := &supervisorTestProvider{session: executor}
	executor.Provider = provider
	worker := newSession("worker-wake", "Worker", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	worker.Provider = &stubProvider{}
	rooms.sessions.sessions[worker.ID] = worker
	member, _ := rooms.AddSession(room.ID, worker.ID)
	manager, err := OpenSupervisorManager(filepath.Join(t.TempDir(), "supervisors"), rooms, rooms.sessions)
	if err != nil {
		t.Fatal(err)
	}
	manager.ctx = context.Background()
	task, err := manager.Save(room.ID, "", SupervisorTask{ExecutorMemberID: executorMember.ID, Targets: []SupervisorTarget{{MemberID: member.ID, Read: true}}, IntervalSeconds: 120, Prompt: "inspect", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	manager.questionArrived(worker.ID, "first")
	manager.tick()
	manager.wg.Wait()
	if provider.calls.Load() != 1 {
		t.Fatal("question did not wake scheduled check")
	}
	manager.questionArrived(worker.ID, "second")
	manager.questionArrived(worker.ID, "second")
	manager.tick()
	if provider.calls.Load() != 1 {
		t.Fatal("overlapping executor turn")
	}
	provider.finish()
	manager.tick()
	manager.tick()
	manager.wg.Wait()
	if provider.calls.Load() != 2 {
		t.Fatal("queued question did not trigger next check")
	}
	_ = task
}
