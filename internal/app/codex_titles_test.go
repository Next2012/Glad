package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// Optional offline wire-protocol check. It starts and detaches the actual
// ephemeral thread but never submits turn/start or makes a model request.
func TestCodexTitleNativeProtocol(t *testing.T) {
	binary := os.Getenv("GLAD_TITLE_PROTOCOL_BINARY")
	if binary == "" {
		t.Skip("set GLAD_TITLE_PROTOCOL_BINARY for native protocol verification")
	}
	session := newSession("native-title", "Codex", "codex-structured", ToolInfo{Key: "codex", Command: binary}, t.TempDir())
	provider := NewCodexProvider(session, nil)
	t.Cleanup(func() { session.cancel(); _ = provider.Close(context.Background()) })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := provider.Start(ctx); err != nil {
		t.Fatal(err)
	}
	config, err := provider.rpc(ctx, "config/read", map[string]any{"cwd": session.WorkingDirectory, "includeLayers": false})
	if err != nil {
		t.Fatal(err)
	}
	provider.mu.Lock()
	model := stringValue(provider.options["model"])
	params := codexTitleThreadParams(mapValue(config["config"]), model, "openai", session.WorkingDirectory)
	response := &codexTitleResponse{done: make(chan codexTitleResult, 1)}
	result, err := provider.requestLockedTracked(ctx, "thread/start", params, response)
	provider.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	id := stringValue(mapValue(result["thread"])["id"])
	if id == "" || !boolValue(mapValue(result["thread"])["ephemeral"]) || stringValue(mapValue(result["sandbox"])["type"]) != "readOnly" {
		t.Fatalf("invalid isolated thread: %#v", result)
	}
	if _, err := provider.rpc(ctx, "thread/unsubscribe", map[string]any{"threadId": id}); err != nil {
		t.Fatal(err)
	}
	provider.mu.Lock()
	current := provider.threadID
	provider.mu.Unlock()
	session.mu.RLock()
	count := len(session.Messages)
	session.mu.RUnlock()
	if current != "" || count != 0 {
		t.Fatalf("native title thread leaked into main session: %q %d", current, count)
	}
}

type titleTestPeer struct {
	mu      sync.Mutex
	names   map[string]string
	methods []string
	starts  []map[string]any
	turns   []map[string]any
	started chan struct{}
	release chan struct{}
	invalid bool
}

func newTitleTestPeer(t *testing.T, delayed, invalid bool) (*CodexProvider, *titleTestPeer) {
	t.Helper()
	provider, writes, _ := historyTestProvider(t)
	provider.models = []map[string]any{{"id": codexTitleModel}}
	provider.options["model"] = "main-model"
	provider.titles.enabled = true
	peer := &titleTestPeer{names: map[string]string{}, started: make(chan struct{}, 1), release: make(chan struct{}), invalid: invalid}
	if !delayed {
		close(peer.release)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	t.Cleanup(func() {
		provider.session.cancel()
		_ = provider.Close(context.Background())
		cancel()
		<-done
	})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case data := <-writes:
				var request map[string]any
				if json.Unmarshal(data, &request) != nil {
					continue
				}
				method, params := stringValue(request["method"]), mapValue(request["params"])
				result := map[string]any{}
				peer.mu.Lock()
				peer.methods = append(peer.methods, method)
				switch method {
				case "thread/read":
					result["thread"] = map[string]any{"name": peer.names[stringValue(params["threadId"])]}
				case "thread/name/set":
					peer.names[stringValue(params["threadId"])] = stringValue(params["name"])
				case "config/read":
					result["config"] = map[string]any{"model_provider": "openai", "mcp_servers": map[string]any{"sensitive": map[string]any{"enabled": true}}}
				case "account/read":
					result["account"] = map[string]any{"type": "chatgpt"}
				case "thread/start":
					peer.starts = append(peer.starts, params)
					result = map[string]any{"thread": map[string]any{"id": "hidden-title", "ephemeral": true}, "sandbox": map[string]any{"type": "readOnly"}}
				case "turn/start":
					peer.turns = append(peer.turns, params)
					result["turn"] = map[string]any{"id": "hidden-turn"}
				case "thread/turns/list":
					result["data"] = []any{map[string]any{"items": []any{
						map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "修复旧项目构建"}}},
					}}}
				}
				peer.mu.Unlock()
				if method == "thread/start" {
					provider.handleRPC(map[string]any{"method": "thread/started", "params": map[string]any{"thread": map[string]any{"id": "hidden-title", "ephemeral": true}}})
				}
				provider.handleRPC(map[string]any{"id": request["id"], "result": result})
				if method == "turn/start" {
					provider.handleRPC(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "hidden-title", "turn": map[string]any{"id": "hidden-turn"}}})
					peer.started <- struct{}{}
					go func() {
						select {
						case <-ctx.Done():
							return
						case <-peer.release:
						}
						provider.titles.mu.Lock()
						_, subscribed := provider.titles.hidden["hidden-title"]
						provider.titles.mu.Unlock()
						if !subscribed {
							return
						}
						text := `{"title":"修复项目构建"}`
						if peer.invalid {
							text = "invalid title"
						}
						provider.handleRPC(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "hidden-title", "item": map[string]any{"type": "agentMessage", "text": text}}})
						provider.handleRPC(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "hidden-title", "turn": map[string]any{"id": "hidden-turn", "status": "completed"}}})
					}()
				}
			}
		}
	}()
	return provider, peer
}

func waitForTitle(t *testing.T, peer *titleTestPeer, expected string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		peer.mu.Lock()
		name := peer.names["current"]
		peer.mu.Unlock()
		if name == expected {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("wanted title %q, got %q", expected, name)
		case <-tick.C:
		}
	}
}

func TestCodexAutomaticTitleUsesIsolatedStructuredTurn(t *testing.T) {
	provider, peer := newTitleTestPeer(t, false, false)
	provider.turnID = "main-turn"
	provider.session.StatusValue = "running"
	provider.titles.schedule("current", "检查项目构建错误", false)
	waitForTitle(t, peer, "修复项目构建")
	peer.mu.Lock()
	defer peer.mu.Unlock()
	start := peer.starts[0]
	config := mapValue(start["config"])
	if start["model"] != codexTitleModel || start["ephemeral"] != true || start["threadSource"] != "system" || start["sandbox"] != "read-only" || config["features.hooks"] != false || mapValue(mapValue(config["mcp_servers"])["sensitive"])["enabled"] != false {
		t.Fatalf("incorrect temporary thread isolation: %#v", start)
	}
	if peer.turns[0]["effort"] != "low" || mapValue(peer.turns[0]["outputSchema"])["additionalProperties"] != false {
		t.Fatal("missing structured output/low effort")
	}
	provider.mu.Lock()
	id, turn := provider.threadID, provider.turnID
	provider.mu.Unlock()
	provider.session.mu.RLock()
	status, count := provider.session.StatusValue, len(provider.session.Messages)
	provider.session.mu.RUnlock()
	if id != "current" || turn != "main-turn" || status != "running" || count != 0 {
		t.Fatalf("title leaked into main conversation: %s %s %s %d", id, turn, status, count)
	}
	if !strings.Contains(strings.Join(peer.methods, ","), "thread/unsubscribe") {
		t.Fatal("temporary thread was not detached")
	}
}

func TestCodexManualRenameWinsDuringTitleGeneration(t *testing.T) {
	provider, peer := newTitleTestPeer(t, true, false)
	provider.titles.schedule("current", "临时问题", false)
	select {
	case <-peer.started:
	case <-time.After(time.Second):
		t.Fatal("title did not start")
	}
	provider.session.mu.Lock()
	provider.session.NameManual = true
	provider.session.Name = "我的命名"
	provider.session.mu.Unlock()
	if err := provider.titles.rename(context.Background(), "我的命名"); err != nil {
		t.Fatal(err)
	}
	if provider.titles.diagnostics()["status"] != "cancelled" {
		t.Fatal("manual rename left title diagnostics running")
	}
	close(peer.release)
	waitForTitle(t, peer, "我的命名")
	provider.session.mu.RLock()
	name := provider.session.Name
	provider.session.mu.RUnlock()
	if name != "我的命名" {
		t.Fatal("manual window name overwritten")
	}
}

func TestCodexExistingTitleIsReusedAndOldHistoryGetsRecentPrompt(t *testing.T) {
	provider, peer := newTitleTestPeer(t, false, false)
	peer.mu.Lock()
	peer.names["current"] = "已有标题"
	peer.mu.Unlock()
	provider.titles.schedule("current", "", true)
	deadline := time.After(time.Second)
	for {
		provider.session.mu.RLock()
		name := provider.session.Name
		provider.session.mu.RUnlock()
		if name == "已有标题" {
			break
		}
		select {
		case <-deadline:
			t.Fatal("existing name was not applied")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	peer.mu.Lock()
	starts := len(peer.starts)
	peer.mu.Unlock()
	if starts != 0 {
		t.Fatal("existing title caused a model request")
	}
	provider.titles.reset()
	peer.mu.Lock()
	peer.names["current"] = ""
	peer.mu.Unlock()
	provider.titles.schedule("current", "", true)
	waitForTitle(t, peer, "修复项目构建")
	peer.mu.Lock()
	prompt := stringValue(mapValue(sliceValue(peer.turns[0]["input"])[0])["text"])
	peer.mu.Unlock()
	if !strings.Contains(prompt, "Recent conversation messages") || !strings.Contains(prompt, "修复旧项目构建") {
		t.Fatal("history did not use recent messages")
	}
}

func TestCodexTitleCancelledStartCleansLateResponse(t *testing.T) {
	provider, writes, _ := historyTestProvider(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		provider.mu.Lock()
		_, err := provider.requestLockedTracked(ctx, "thread/start", map[string]any{"ephemeral": true}, &codexTitleResponse{done: make(chan codexTitleResult, 1)})
		provider.mu.Unlock()
		done <- err
	}()
	request := historyTestRequest(t, writes)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancelled start")
		}
	case <-time.After(time.Second):
		t.Fatal("start remained blocked")
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"thread": map[string]any{"id": "late-hidden"}}})
	detach := historyTestRequest(t, writes)
	if detach["method"] != "thread/unsubscribe" || mapValue(detach["params"])["threadId"] != "late-hidden" {
		t.Fatal("late title thread was not cleaned")
	}
	provider.handleRPC(map[string]any{"id": detach["id"], "result": map[string]any{}})
	provider.session.cancel()
}

func TestCodexTitleWaitsForUserItemAndRetriesMetadataFailure(t *testing.T) {
	provider, writes, _ := historyTestProvider(t)
	provider.cmd = exec.Command("codex") // synthetic running transport
	provider.titles.enabled = true
	t.Cleanup(func() { provider.session.cancel(); _ = provider.Close(context.Background()) })
	done := make(chan error, 1)
	go func() {
		done <- provider.Send(context.Background(), ProviderInput{Text: "检查项目构建", AgentText: "检查项目构建"})
	}()
	request := historyTestRequest(t, writes)
	if request["method"] != "turn/start" {
		t.Fatal("expected normal user turn")
	}
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"turn": map[string]any{"id": "main-turn"}}})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-writes:
		t.Fatal("title started before user item acknowledgement")
	default:
	}
	userItem := map[string]any{"threadId": "current", "turnId": "main-turn", "item": map[string]any{
		"id": "user-item", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "检查项目构建"}},
	}}
	provider.handleNotification("item/completed", userItem)
	request = historyTestRequest(t, writes)
	if request["method"] != "thread/read" {
		t.Fatal("title did not begin after user item")
	}
	provider.handleRPC(map[string]any{"id": request["id"], "error": map[string]any{"message": "metadata temporarily unavailable"}})
	deadline := time.After(time.Second)
	for provider.titles.diagnostics()["status"] != "failed" {
		select {
		case <-deadline:
			t.Fatal("metadata failure was not observable")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if provider.titles.diagnostics()["error"] != "metadata temporarily unavailable" {
		t.Fatal("lost diagnostic error")
	}
	provider.handleNotification("item/completed", userItem)
	request = historyTestRequest(t, writes)
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{"thread": map[string]any{"name": "已保存的标题"}}})
	deadline = time.After(time.Second)
	for provider.titles.diagnostics()["status"] != "completed" {
		select {
		case <-deadline:
			t.Fatal("title did not retry after failure")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if provider.titles.diagnostics()["attempts"] != 2 {
		t.Fatal("incorrect retry accounting")
	}
	provider.session.mu.RLock()
	name := provider.session.Name
	provider.session.mu.RUnlock()
	if name != "已保存的标题" {
		t.Fatal("retry failed to adopt the stored name")
	}
}
