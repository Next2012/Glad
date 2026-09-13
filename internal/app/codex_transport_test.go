package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func transportTestProvider(t *testing.T) (*CodexProvider, chan []byte) {
	t.Helper()
	session := newSession("transport", "Codex", "codex-structured", ToolInfo{Key: "codex"}, t.TempDir())
	provider := NewCodexProvider(session, nil)
	session.Provider = provider
	provider.cmd = exec.Command("unused-test-peer")
	writes := make(chan []byte, 8)
	provider.stdin = &channelWriteCloser{writes: writes}
	provider.threadID, provider.turnID = "saved-thread", "active-turn"
	provider.turnStarted = millis() - 100
	provider.permissions["approval"] = codexPendingPermission{Method: "item/commandExecution/requestApproval"}
	session.Permissions["approval"] = Permission{}
	session.setState(map[string]any{"status": "running"})
	session.appendMessage(map[string]any{"id": "active-tool", "kind": "tool", "turnId": "active-turn", "toolStatus": "running"})
	t.Cleanup(func() { session.cancel(); _ = provider.Close(context.Background()) })
	return provider, writes
}

func assertTransportStopped(t *testing.T, provider *CodexProvider) {
	t.Helper()
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.cmd != nil || provider.turnID != "" || provider.turnStarted != 0 || len(provider.permissions) != 0 || !provider.needsThreadResume {
		t.Fatalf("runtime was not cleared: command=%v turn=%q started=%d approvals=%d resume=%v", provider.cmd, provider.turnID, provider.turnStarted, len(provider.permissions), provider.needsThreadResume)
	}
	provider.session.mu.RLock()
	defer provider.session.mu.RUnlock()
	if provider.session.StatusValue != "idle" || len(provider.session.Permissions) != 0 {
		t.Fatalf("public state was not cleared: %s", provider.session.StatusValue)
	}
	failedTurn, failedTool := false, false
	for _, message := range provider.session.Messages {
		if message["kind"] == "turn-end" && message["status"] == "failed" {
			failedTurn = true
		}
		if message["id"] == "active-tool" && message["toolStatus"] == "failed" {
			failedTool = true
		}
	}
	if !failedTurn || !failedTool {
		t.Fatalf("missing failure state: turn=%v tool=%v", failedTurn, failedTool)
	}
}

type transportErrorReader struct{}

func (transportErrorReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestCodexTransportReadFailureClearsTurnAndRequests(t *testing.T) {
	for name, reader := range map[string]io.Reader{"eof": strings.NewReader(""), "read-error": transportErrorReader{}} {
		t.Run(name, func(t *testing.T) {
			provider, _ := transportTestProvider(t)
			pending := make(chan codexRPCResult, 1)
			provider.pending[99] = pending
			provider.readStdout(provider.cmd, reader)
			select {
			case result := <-pending:
				if result.Err == nil {
					t.Fatal("pending RPC succeeded after disconnect")
				}
			default:
				t.Fatal("pending RPC still blocked")
			}
			assertTransportStopped(t, provider)
		})
	}
}

func TestCodexTransportMonitorDetectsSilentLivePeer(t *testing.T) {
	provider, _ := transportTestProvider(t)
	done := make(chan struct{})
	// 模拟主进程存活、stdout 仍打开，但 RPC 永远没有响应。
	provider.monitorTransport(provider.cmd, done, time.Millisecond, 10*time.Millisecond)
	assertTransportStopped(t, provider)
}

func TestCodexTransportMonitorAcceptsRPCErrorAsAlive(t *testing.T) {
	provider, writes := transportTestProvider(t)
	command := provider.cmd
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		provider.monitorTransport(command, done, time.Millisecond, 100*time.Millisecond)
	}()
	for i := 0; i < 2; i++ {
		select {
		case raw := <-writes:
			var request map[string]any
			if err := json.Unmarshal(raw, &request); err != nil {
				t.Fatal(err)
			}
			if request["method"] != "thread/loaded/list" {
				t.Fatalf("unexpected probe: %v", request)
			}
			provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "unsupported method"}})
		case <-time.After(time.Second):
			t.Fatal("probe did not arrive")
		}
	}
	close(done)
	<-finished
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if provider.cmd != command || provider.turnID != "active-turn" {
		t.Fatal("RPC error incorrectly stopped a live process")
	}
}

func TestCodexTransportOldCallbackCannotChangeNewRuntime(t *testing.T) {
	provider, _ := transportTestProvider(t)
	old := provider.cmd
	provider.cmd = exec.Command("new-test-peer")
	provider.transportFailed(old, errors.New("late EOF"))
	if provider.session.StatusValue != "running" || provider.turnID != "active-turn" {
		t.Fatal("old callback changed the new runtime")
	}
}

func TestCodexTransportExitHelper(t *testing.T) {}

func TestCodexTransportWaitClearsOnlyCurrentProcess(t *testing.T) {
	for _, current := range []bool{true, false} {
		t.Run(map[bool]string{true: "current", false: "old"}[current], func(t *testing.T) {
			provider, _ := transportTestProvider(t)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(executable, "-test.run=^TestCodexTransportExitHelper$")
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			if current {
				provider.cmd = command
			}
			provider.wait(command)
			if current {
				assertTransportStopped(t, provider)
			} else if provider.session.StatusValue != "running" {
				t.Fatal("old wait reset new session")
			}
		})
	}
}

func TestCodexStderrDrainsLongLines(t *testing.T) {
	provider, _ := transportTestProvider(t)
	reader := strings.NewReader(strings.Repeat("x", 256<<10) + "\nlast line\n")
	provider.readStderr(reader)
	if reader.Len() != 0 {
		t.Fatalf("stderr stopped with %d bytes unread", reader.Len())
	}
}

func TestCodexTransportDropsOldProcessNotifications(t *testing.T) {
	provider, _ := transportTestProvider(t)
	old := provider.cmd
	provider.cmd = exec.Command("replacement")
	provider.handleProcessRPC(old, map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "saved-thread", "turn": map[string]any{"id": "stale-turn"}}})
	if provider.turnID != "active-turn" {
		t.Fatalf("stale notification changed turn to %q", provider.turnID)
	}
}

func TestCodexTransportFailureWakesResumeAndCancelsTitle(t *testing.T) {
	provider, writes := transportTestProvider(t)
	provider.turnID = ""
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	provider.titles.cancel = cancel
	provider.titles.threadID = "old-title"
	finished := make(chan error, 1)
	go func() { finished <- provider.Resume(context.Background(), "restored-thread") }()
	select {
	case <-writes:
	case <-time.After(time.Second):
		t.Fatal("resume did not start")
	}
	provider.transportFailed(provider.cmd, io.EOF)
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("resume succeeded after transport loss")
		}
	case <-time.After(time.Second):
		t.Fatal("resume still blocked")
	}
	if ctx.Err() == nil || provider.titles.threadID != "" {
		t.Fatal("title generation was not reset")
	}
	if provider.resumeInFlight || provider.session.StatusValue != "idle" {
		t.Fatal("resume state was not cleared")
	}
}

func TestCodexTransportCleanupBlocksNewSend(t *testing.T) {
	provider, _ := transportTestProvider(t)
	command := provider.cmd
	// 卡在公开消息清理，检查新输入无法在清理中途启动另一个进程。
	provider.session.mu.Lock()
	finished := make(chan struct{})
	go func() { defer close(finished); provider.transportFailed(command, io.EOF) }()
	deadline := time.Now().Add(time.Second)
	for {
		provider.mu.Lock()
		stopping := provider.aborting && provider.cmd == nil
		provider.mu.Unlock()
		if stopping {
			break
		}
		if time.Now().After(deadline) {
			provider.session.mu.Unlock()
			t.Fatal("cleanup did not start")
		}
		time.Sleep(time.Millisecond)
	}
	err := provider.Send(context.Background(), ProviderInput{Text: "new input"})
	provider.session.mu.Unlock()
	<-finished
	if err == nil {
		t.Fatal("Send started during cleanup")
	}
	assertTransportStopped(t, provider)
}

func TestCodexTransportInputWriteHasDeadline(t *testing.T) {
	provider, _ := transportTestProvider(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	provider.stdin = writer
	provider.mu.Lock()
	started := time.Now()
	err = provider.writeLocked(map[string]any{"method": "large-request", "params": strings.Repeat("x", 1<<20)})
	provider.mu.Unlock()
	if err == nil || time.Since(started) > codexHealthTimeout+2*time.Second {
		t.Fatalf("blocked input did not time out: %v", err)
	}
}

type transportWriteFunc func([]byte) (int, error)

func (write transportWriteFunc) Write(data []byte) (int, error) { return write(data) }
func (transportWriteFunc) Close() error                         { return nil }

func TestCodexTransportRejectsSuccessFromStoppedProcess(t *testing.T) {
	provider, _ := transportTestProvider(t)
	provider.turnID = ""
	provider.stdin = transportWriteFunc(func(data []byte) (int, error) {
		var request map[string]any
		if err := json.Unmarshal(data, &request); err != nil {
			t.Fatal(err)
		}
		id := numberInt64(request["id"])
		channel := provider.pending[id]
		delete(provider.pending, id)
		// 成功结果已经入队，但在 Send 取回锁之前，该进程已经被清理。
		channel <- codexRPCResult{Result: map[string]any{"turn": map[string]any{"id": "obsolete-turn"}}}
		close(channel)
		provider.cmd = nil
		provider.session.setState(map[string]any{"status": "idle"})
		return len(data), nil
	})
	err := provider.Send(context.Background(), ProviderInput{Text: "do not revive the old turn"})
	if err == nil || provider.turnID != "" || provider.session.StatusValue != "idle" {
		t.Fatalf("stale success revived session: err=%v turn=%q status=%s", err, provider.turnID, provider.session.StatusValue)
	}
}

func TestCodexLetsNativeReconnectFinish(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		t.Run(status, func(t *testing.T) {
			session := newSession("reconnect", "Codex", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir())
			t.Cleanup(session.cancel)
			provider := NewCodexProvider(session, nil)
			writes := make(chan []byte, 4)
			provider.stdin = &channelWriteCloser{writes: writes}
			provider.threadID = "thread-reconnect"
			provider.handleNotification("turn/started", map[string]any{
				"threadId": "thread-reconnect", "turn": map[string]any{"id": "turn-reconnect"},
			})

			for attempt := 1; attempt <= 5; attempt++ {
				provider.handleNotification("error", map[string]any{
					"threadId": "thread-reconnect", "turnId": "turn-reconnect",
					"error": map[string]any{"message": fmt.Sprintf("Reconnecting... %d/5", attempt)}, "willRetry": true,
				})
			}
			select {
			case encoded := <-writes:
				var request map[string]any
				if err := json.Unmarshal(encoded, &request); err != nil {
					t.Fatal(err)
				}
				provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{}})
				t.Fatalf("Glad interrupted native connection recovery: %s", encoded)
			case <-time.After(50 * time.Millisecond):
			}
			if session.StatusValue != "running" || provider.turnID != "turn-reconnect" || provider.aborting {
				t.Fatal("retries settled or aborted the active turn")
			}

			if status == "failed" {
				provider.handleNotification("error", map[string]any{
					"threadId": "thread-reconnect", "turnId": "turn-reconnect",
					"error": map[string]any{"message": "Connection retries exhausted"}, "willRetry": false,
				})
				if session.StatusValue != "running" || provider.turnID != "turn-reconnect" {
					t.Fatal("terminal error settled the turn before turn/completed")
				}
			}
			provider.handleNotification("turn/completed", map[string]any{
				"threadId": "thread-reconnect", "turn": map[string]any{"id": "turn-reconnect", "status": status},
			})
			if session.StatusValue != "idle" || provider.turnID != "" {
				t.Fatal("native completion did not settle the turn")
			}
			last := session.Messages[len(session.Messages)-1]
			if last["kind"] != "turn-end" || last["status"] != status {
				t.Fatalf("unexpected completion after retries: %#v", last)
			}
		})
	}
}
