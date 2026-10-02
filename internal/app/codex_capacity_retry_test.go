package app

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	sessioncore "glad-web/internal/session"
)

func capacityFailure(provider *CodexProvider, thread, turn, code string) {
	provider.handleNotification("turn/completed", map[string]any{
		"threadId": thread,
		"turn": map[string]any{"id": turn, "status": "failed", "error": map[string]any{
			"codexErrorInfo": code, "message": "Selected model is at capacity. Please try a different model.",
		}},
	})
}

func readCapacityRequest(t *testing.T, writes <-chan []byte) map[string]any {
	t.Helper()
	select {
	case raw := <-writes:
		var request map[string]any
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		return request
	case <-time.After(time.Second):
		t.Fatal("automatic retry did not send a request")
		return nil
	}
}

// 手动推进定时回调，让计数、通知和取消测试不依赖实际等待 150 秒。
func triggerCapacityRetry(t *testing.T, provider *CodexProvider, writes <-chan []byte, turn string) map[string]any {
	t.Helper()
	provider.mu.Lock()
	if provider.capacityRetryTimer == nil {
		provider.mu.Unlock()
		t.Fatal("no retry scheduled")
	}
	provider.capacityRetryTimer.Stop()
	generation := provider.capacityRetryGeneration
	provider.mu.Unlock()
	done := make(chan struct{})
	go func() { provider.runCapacityRetry(generation); close(done) }()
	request := readCapacityRequest(t, writes)
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": turn}}})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retry start did not finish")
	}
	return request
}

func TestCodexCapacityRetryWaitsThirtySecondsAndCanStop(t *testing.T) {
	provider, writes := questionTestProvider(t)
	before := millis()
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	state := provider.session.snapshot()["state"].(map[string]any)
	if numberInt64(state["capacityRetryAt"]) < before+30000 || numberInt64(state["capacityRetryAt"]) > millis()+30000 ||
		numberInt64(state["capacityRetryAttempt"]) != 1 || state["status"] != "running" || !boolValue(state["canAbort"]) {
		t.Fatalf("incorrect waiting state: %v", state)
	}
	if boolValue(provider.session.snapshot()["hasUnreadCompletion"]) || len(writes) != 0 {
		t.Fatal("retry notified completion or sent before its delay")
	}
	provider.mu.Lock()
	generation := provider.capacityRetryGeneration
	provider.mu.Unlock()
	if err := provider.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	provider.runCapacityRetry(generation)
	if len(writes) != 0 || provider.session.snapshot()["status"] != "idle" {
		t.Fatal("cancelled callback sent a request or stopped the app-server")
	}
}

func TestCodexCapacityRetryRunsAtMostFiveTimesAndNotifiesOnce(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	provider.options = map[string]any{"model": "original-model", "effort": "high", "permissionMode": "never", "sandboxMode": "danger-full-access"}
	turn := "turn"
	for attempt := 1; attempt <= 5; attempt++ {
		capacityFailure(provider, "root", turn, "serverOverloaded")
		for _, message := range provider.session.snapshot()["messages"].([]map[string]any) {
			if _, notify := classifyNotification(provider.session, map[string]any{"type": "message", "message": message}); notify {
				t.Fatal("intermediate failure notified")
			}
		}
		if provider.session.snapshot()["completionRevision"].(uint64) != 0 {
			t.Fatal("intermediate failure became unread completion")
		}
		turn = fmt.Sprintf("retry-%d", attempt)
		request := triggerCapacityRetry(t, provider, writes, turn)
		params := mapValue(request["params"])
		text := textFromCodexInput(params["input"])
		if request["method"] != "turn/start" || params["threadId"] != "root" || params["model"] != "original-model" ||
			params["effort"] != "high" || params["approvalPolicy"] != "never" || mapValue(params["sandboxPolicy"])["type"] != "dangerFullAccess" ||
			text != "继续" {
			t.Fatalf("retry lost context or settings: %v", request)
		}
	}
	capacityFailure(provider, "root", turn, "serverOverloaded")
	capacityFailure(provider, "root", turn, "serverOverloaded") // 重复通知不能再次触发重试或推送。
	notifications := 0
	for _, message := range provider.session.snapshot()["messages"].([]map[string]any) {
		if _, notify := classifyNotification(provider.session, map[string]any{"type": "message", "message": message}); notify {
			notifications++
		}
	}
	if notifications != 1 || provider.session.snapshot()["completionRevision"].(uint64) != 1 ||
		provider.session.snapshot()["status"] != "idle" || len(writes) != 0 || provider.capacityRetryTimer != nil {
		t.Fatalf("incorrect final failure: notifications=%d snapshot=%v", notifications, provider.session.snapshot())
	}
}

func TestCodexCapacityRetrySuccessAndNewRequestResetBudget(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	capacityFailure(provider, "root", "turn", "server_overloaded")
	triggerCapacityRetry(t, provider, writes, "recovered")
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "recovered", "status": "completed"}})
	if provider.session.snapshot()["status"] != "idle" || provider.session.snapshot()["completionRevision"].(uint64) != 1 || provider.capacityRetryAttempts != 0 {
		t.Fatal("successful retry did not complete normally")
	}
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "new"}})
	capacityFailure(provider, "root", "new", "serverOverloaded")
	provider.mu.Lock()
	oldGeneration := provider.capacityRetryGeneration
	provider.mu.Unlock()
	done := make(chan error, 1)
	go func() {
		done <- provider.Send(context.Background(), ProviderInput{Text: "new task", AgentText: "new task"})
	}()
	request := readCapacityRequest(t, writes)
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "manual"}}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	provider.runCapacityRetry(oldGeneration)
	if provider.capacityRetryAttempts != 0 || len(writes) != 0 || textFromCodexInput(mapValue(request["params"])["input"]) != "new task" {
		t.Fatal("new user request did not replace automatic retry")
	}
}

func TestCodexCapacityRetryIgnoresNativeRetriesOtherErrorsAndOldTurns(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	provider.handleNotification("error", map[string]any{
		"threadId": "root", "turnId": "turn", "willRetry": true,
		"error": map[string]any{"codexErrorInfo": "serverOverloaded", "message": "native retry"},
	})
	capacityFailure(provider, "child", "child-turn", "serverOverloaded")
	capacityFailure(provider, "root", "old-turn", "serverOverloaded")
	if provider.capacityRetryTimer != nil || len(writes) != 0 {
		t.Fatal("native retry, child, or old turn triggered another turn")
	}
	capacityFailure(provider, "root", "turn", "usageLimitExceeded")
	if provider.capacityRetryTimer != nil || provider.session.snapshot()["completionRevision"].(uint64) != 1 {
		t.Fatal("unrelated failure was retried or its notification suppressed")
	}
}

func TestCodexCapacityRetryCloseAndAbortDoNotRestart(t *testing.T) {
	for _, action := range []string{"close", "aborting", "session-cancel"} {
		t.Run(action, func(t *testing.T) {
			provider, writes := questionTestProvider(t)
			provider.capacityRetryDelay = time.Hour
			if action == "aborting" {
				provider.aborting = true
			}
			capacityFailure(provider, "root", "turn", "serverOverloaded")
			provider.mu.Lock()
			generation := provider.capacityRetryGeneration
			provider.mu.Unlock()
			if action == "close" {
				_ = provider.Close(context.Background())
			} else if action == "session-cancel" {
				provider.session.cancel()
			}
			provider.runCapacityRetry(generation)
			if len(writes) != 0 {
				t.Fatal("stopped session restarted")
			}
		})
	}
}

func TestCodexCapacityRetryFastCompletionDoesNotReviveTurn(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	provider.mu.Lock()
	provider.capacityRetryTimer.Stop()
	generation := provider.capacityRetryGeneration
	provider.mu.Unlock()
	done := make(chan struct{})
	go func() { provider.runCapacityRetry(generation); close(done) }()
	request := readCapacityRequest(t, writes)
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "fast"}})
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "fast", "status": "completed"}})
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "fast"}}})
	<-done
	if provider.session.snapshot()["status"] != "idle" || provider.turnID != "" || provider.session.snapshot()["completionRevision"].(uint64) != 1 {
		t.Fatal("late start response revived a finished retry")
	}
}

func TestCodexCapacityRetryTimerStartsAndRejectedRequestNotifies(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = 20 * time.Millisecond
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	request := readCapacityRequest(t, writes)
	provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "model access denied"}})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		snapshot := provider.session.snapshot()
		if snapshot["status"] == "idle" && snapshot["completionRevision"].(uint64) == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if provider.session.snapshot()["status"] != "idle" || provider.session.snapshot()["completionRevision"].(uint64) != 1 {
		t.Fatal("rejected retry did not settle and notify")
	}
}

func TestServerChanCapacityRetryOnlyDeliversFinalResult(t *testing.T) {
	session, provider, service, drain := notificationFixture(t)
	provider.capacityRetryDelay = time.Hour
	t.Cleanup(func() { _ = provider.Close(context.Background()) })
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "first"}})
	capacityFailure(provider, "root", "first", "serverOverloaded")
	drain()
	if len(service.deliveries) != 0 || session.snapshot()["completionRevision"].(uint64) != 0 {
		t.Fatal("intermediate capacity failure pushed a notification")
	}
	provider.mu.Lock()
	provider.capacityRetryTimer.Stop()
	provider.capacityRetryTimer = nil
	provider.capacityRetryAttempts = 5
	provider.mu.Unlock()
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "last"}})
	capacityFailure(provider, "root", "last", "serverOverloaded")
	drain()
	if len(service.deliveries) != 1 || (<-service.deliveries).title != "执行失败｜当前对话" || session.snapshot()["completionRevision"].(uint64) != 1 {
		t.Fatal("final failure did not notify exactly once")
	}
}

func TestCodexCapacityRetryStartedTurnWaitsDespiteRPCError(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = 20 * time.Millisecond
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	request := readCapacityRequest(t, writes)
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "accepted"}})
	provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "late start response failed"}})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		provider.mu.Lock()
		sending := provider.sending
		provider.mu.Unlock()
		if !sending {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if provider.session.snapshot()["status"] != "running" || provider.session.snapshot()["completionRevision"].(uint64) != 0 {
		t.Fatal("accepted retry was incorrectly treated as failed")
	}
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "accepted", "status": "completed"}})
	if provider.session.snapshot()["completionRevision"].(uint64) != 1 {
		t.Fatal("accepted retry did not notify once on real completion")
	}
}

func TestRoomCapacityRetryDoesNotMarkIntermediateFailureUnread(t *testing.T) {
	manager, session, _, room, _ := newRuntimeRoomTest(t)
	event := sessioncore.Event{SessionID: session.ID, Payload: map[string]any{"type": "message", "message": map[string]any{
		"kind": "turn-end", "turnId": "capacity-failure", "status": "failed", "isRootTurn": true, "retryScheduled": true,
	}}}
	manager.sessionEvent(event)
	view, _ := manager.GetPublic(room.ID)
	if view["completionRevision"] != uint64(0) || boolValue(view["hasUnreadCompletion"]) {
		t.Fatal("intermediate retry failure marked group unread")
	}
	mapValue(event.Payload["message"])["retryScheduled"] = false
	manager.sessionEvent(event)
	view, _ = manager.GetPublic(room.ID)
	if view["completionRevision"] != uint64(1) || !boolValue(view["hasUnreadCompletion"]) {
		t.Fatal("final group result did not mark completion")
	}
}

func TestCodexCapacityRetryWaitingTransportFailureNotifiesOnce(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	provider.mu.Lock()
	command, generation := provider.cmd, provider.capacityRetryGeneration
	provider.mu.Unlock()
	provider.transportFailed(command, fmt.Errorf("connection closed while waiting"))
	provider.runCapacityRetry(generation)
	notifications := 0
	for _, message := range provider.session.snapshot()["messages"].([]map[string]any) {
		if _, notify := classifyNotification(provider.session, map[string]any{"type": "message", "message": message}); notify {
			notifications++
		}
	}
	if notifications != 1 || provider.session.snapshot()["completionRevision"].(uint64) != 1 || provider.session.snapshot()["status"] != "idle" || len(writes) != 0 {
		t.Fatal("waiting connection failure did not settle once")
	}
}

func TestCodexCapacityRetryStartingTransportFailureNotifiesOnce(t *testing.T) {
	provider, writes := questionTestProvider(t)
	provider.capacityRetryDelay = time.Hour
	capacityFailure(provider, "root", "turn", "serverOverloaded")
	provider.mu.Lock()
	provider.capacityRetryTimer.Stop()
	command, generation := provider.cmd, provider.capacityRetryGeneration
	provider.mu.Unlock()
	done := make(chan struct{})
	go func() { provider.runCapacityRetry(generation); close(done) }()
	request := readCapacityRequest(t, writes)
	if request["method"] != "turn/start" {
		t.Fatalf("unexpected retry request: %v", request)
	}
	// 请求已写出，故意不给 turn/start 响应和 turn/started 通知。
	provider.transportFailed(command, fmt.Errorf("connection closed before retry startup confirmation"))
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retry request remained blocked after transport failure")
	}
	notifications := 0
	for _, message := range provider.session.snapshot()["messages"].([]map[string]any) {
		if _, notify := classifyNotification(provider.session, map[string]any{"type": "message", "message": message}); notify {
			notifications++
		}
	}
	if notifications != 1 || provider.session.snapshot()["completionRevision"].(uint64) != 1 || provider.session.snapshot()["status"] != "idle" {
		t.Fatal("retry startup connection failure did not notify exactly once")
	}
	// 原连接的迟到启动通知也不能重新启动已经结束的恢复。
	provider.handleProcessRPC(command, map[string]any{"method": "turn/started", "params": map[string]any{
		"threadId": "root", "turn": map[string]any{"id": "late-retry"},
	}})
	if provider.session.snapshot()["status"] != "idle" || len(writes) != 0 {
		t.Fatal("late startup notification revived the failed retry")
	}
}
