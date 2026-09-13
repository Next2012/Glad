package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func notificationFixture(t *testing.T) (*Session, *CodexProvider, *NotificationService, func()) {
	t.Helper()
	session := newSession("notification-test", "当前对话", "codex-structured", ToolInfo{Key: "codex", DisplayName: "Codex"}, t.TempDir())
	session.ServerChanNotificationEnabled = true
	provider := NewCodexProvider(session, nil)
	provider.threadID = "root"
	config := &ConfigStore{data: map[string]any{"serverChan": map[string]any{"sendKey": "FAKE_LOCAL_TEST_KEY"}}}
	service := NewNotificationService(config, nil)
	subscription := session.events.Subscribe(session.ID, 128)
	t.Cleanup(func() { subscription.Close(); session.cancel() })
	drain := func() {
		for {
			select {
			case event := <-subscription.Events():
				service.HandleEvent(session, event.Payload)
			default:
				return
			}
		}
	}
	return session, provider, service, drain
}

func TestServerChanAsyncQuestionsNotifyOncePerCard(t *testing.T) {
	for _, streamed := range []bool{false, true} {
		t.Run(fmt.Sprintf("streamed=%t", streamed), func(t *testing.T) {
			session, provider, service, drain := notificationFixture(t)
			provider.handleNotification("turn/started", map[string]any{
				"threadId": "root", "turn": map[string]any{"id": "current"},
			})
			for i := 0; i < 2; i++ {
				id := fmt.Sprintf("question-%d", i)
				if streamed {
					provider.handleNotification("item/agentMessage/delta", map[string]any{
						"threadId": "root", "turnId": "current", "itemId": id, "delta": "需要确认一个问题",
					})
				}
				item := map[string]any{
					"id": id, "type": "agentMessage", "delivery": "async",
					"questions": []any{map[string]any{"title": "使用哪种材料？", "options": []string{"铝", "塑料"}}},
				}
				event := map[string]any{"threadId": "root", "turnId": "current", "item": item}
				provider.handleNotification("item/completed", event)
				provider.handleNotification("item/completed", event)
			}
			drain()
			if len(service.deliveries) != 2 {
				t.Fatalf("expected one notification per question, got %d", len(service.deliveries))
			}
			for i := 0; i < 2; i++ {
				if title := (<-service.deliveries).title; title != "待回复｜当前对话" {
					t.Fatalf("unexpected question notification: %s", title)
				}
			}
			for _, message := range session.Messages {
				if message["kind"] != "question" {
					continue
				}
				// A replayed notification or a changed card must not send it again.
				service.HandleEvent(session, map[string]any{"type": "question-request", "id": message["id"]})
				session.patchMessage(stringValue(message["id"]), map[string]any{"questionStatus": "answered"})
			}
			drain()
			if len(service.deliveries) != 0 {
				t.Fatal("duplicate question or submitted answer triggered a notification")
			}
			provider.handleNotification("turn/completed", map[string]any{
				"threadId": "root", "turn": map[string]any{"id": "current", "status": "completed"},
			})
			drain()
			if len(service.deliveries) != 1 || (<-service.deliveries).title != "已完成｜当前对话" {
				t.Fatal("question notification suppressed completion of the same turn")
			}
		})
	}
}

func TestServerChanAsyncQuestionsRespectSettingsAndSkipHistory(t *testing.T) {
	for _, disabled := range []string{"session", "configuration"} {
		t.Run(disabled, func(t *testing.T) {
			session, provider, service, drain := notificationFixture(t)
			if disabled == "session" {
				session.ServerChanNotificationEnabled = false
			} else {
				service.config.data["serverChan"] = map[string]any{}
			}
			addTestQuestion(provider, true)
			drain()
			if len(service.deliveries) != 0 || len(service.seen) != 0 {
				t.Fatal("disabled question notification was queued or marked delivered")
			}
		})
	}
	session, provider, service, drain := notificationFixture(t)
	addTestQuestion(provider, false)
	history := codexHistoryItem(map[string]any{
		"id": "old-question", "type": "agentMessage", "delivery": "async",
		"questions": []any{map[string]any{"title": "以前的问题？"}},
	})
	session.replaceMessages([]map[string]any{history})
	drain()
	if len(service.deliveries) != 0 {
		t.Fatal("blocking question or restored history triggered an async-question notification")
	}
}

func TestServerChanOnlyCurrentRootCompletionNotifies(t *testing.T) {
	for _, status := range []string{"completed", "failed", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			session, provider, service, drain := notificationFixture(t)
			provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "current"}})
			for _, thread := range []string{"child", "old-thread", "root"} {
				turn := "other-turn-" + thread
				if thread != "root" {
					provider.handleNotification("turn/started", map[string]any{"threadId": thread, "turn": map[string]any{"id": turn}})
				}
				provider.handleNotification("turn/completed", map[string]any{"threadId": thread, "turn": map[string]any{"id": turn, "status": status}})
			}
			drain()
			if len(service.deliveries) != 0 || session.StatusValue != "running" || provider.turnID != "current" {
				t.Fatal("child or stale turn notified or settled root")
			}
			completed := map[string]any{"threadId": "root", "turn": map[string]any{"id": "current", "status": status}}
			provider.handleNotification("turn/completed", completed)
			provider.handleNotification("turn/completed", completed)
			drain()
			expected := 1
			if status == "interrupted" {
				expected = 0
			}
			if len(service.deliveries) != expected {
				t.Fatalf("notifications=%d want=%d", len(service.deliveries), expected)
			}
			if expected == 1 {
				title := "已完成｜当前对话"
				if status == "failed" {
					title = "执行失败｜当前对话"
				}
				if got := (<-service.deliveries).title; got != title {
					t.Fatalf("title=%q", got)
				}
			}
		})
	}
}

func completionEvent(thread, turn, status string) map[string]any {
	return map[string]any{"type": "message", "message": map[string]any{"kind": "turn-end", "threadId": thread, "turnId": turn, "status": status, "isRootTurn": true}}
}

func TestServerChanCompletionUsesEventScopeNotLaterSessionState(t *testing.T) {
	session, _, service, _ := notificationFixture(t)
	// 消费时下一轮可能已开始，仍须按事件生成时的归属处理一次有效的主轮次结束。
	session.StatusValue = "running"
	event := completionEvent("root", "previous-valid-root", "completed")
	service.HandleEvent(session, event)
	service.HandleEvent(session, event)
	if len(service.deliveries) != 1 {
		t.Fatal("valid root completion was dropped or duplicated")
	}
}

func TestServerChanIgnoresHistoryAndHiddenTitles(t *testing.T) {
	session, provider, service, drain := notificationFixture(t)
	provider.titles.hidden["hidden-title"] = nil
	provider.handleRPC(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "hidden-title", "turn": map[string]any{"id": "hidden", "status": "completed"}}})
	history, err := buildCodexHistoryMessages(context.Background(), "root", []any{map[string]any{"id": "history", "status": "completed"}})
	if err != nil {
		t.Fatal(err)
	}
	session.replaceMessages(history)
	drain()
	if len(service.deliveries) != 0 {
		t.Fatal("history or title emitted completion notification")
	}
}

func TestServerChanForcedFailureAndCancellation(t *testing.T) {
	for _, status := range []string{"failed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			_, provider, service, drain := notificationFixture(t)
			provider.settleStoppedTurn("root", "stopped-turn", millis()-100, "connection stopped", status)
			drain()
			count := 0
			if status == "failed" {
				count = 1
			}
			if len(service.deliveries) != count {
				t.Fatalf("stopped-turn notifications=%d", len(service.deliveries))
			}
		})
	}
}

func TestServerChanPermissionAndDisconnectIDs(t *testing.T) {
	session, _, service, _ := notificationFixture(t)
	events := []map[string]any{
		{"type": "permission-request", "request": Permission{ID: "permission-one"}},
		{"type": "permission-request", "request": &Permission{ID: "permission-two"}},
		{"type": "permission-request", "request": map[string]any{"id": "permission-three"}},
		{"type": "runtime-disconnected", "turnId": "turn-one"},
		{"type": "runtime-disconnected", "turnId": "turn-two"},
	}
	for _, event := range events {
		service.HandleEvent(session, event)
		service.HandleEvent(session, event)
	}
	if len(service.deliveries) != len(events) {
		t.Fatalf("distinct events collapsed: %d", len(service.deliveries))
	}
}

func TestServerChanDeduplicationRetainsNewestEvents(t *testing.T) {
	session, _, service, _ := notificationFixture(t)
	for i := 0; i < 150; i++ {
		event := completionEvent("root", fmt.Sprint(i), "completed")
		service.HandleEvent(session, event)
		if len(service.deliveries) != 1 {
			t.Fatalf("missing notification %d", i)
		}
		<-service.deliveries
		service.HandleEvent(session, event)
		if len(service.deliveries) != 0 {
			t.Fatalf("newest key evicted at %d", i)
		}
	}
	history := service.seen[session.ID]
	if len(history.keys) != 100 || len(history.order) != 100 || history.order[0] != "message:root:50" {
		t.Fatal("deduplication is not bounded FIFO")
	}
}

func TestServerChanQueueFullDoesNotMarkAsDelivered(t *testing.T) {
	session, _, service, _ := notificationFixture(t)
	for i := 0; i < cap(service.deliveries); i++ {
		service.deliveries <- notificationDelivery{}
	}
	event := completionEvent("root", "retry-after-full", "completed")
	service.HandleEvent(session, event)
	for len(service.deliveries) > 0 {
		<-service.deliveries
	}
	service.HandleEvent(session, event)
	if len(service.deliveries) != 1 {
		t.Fatal("dropped queue entry prevented later delivery")
	}
}

func TestServerChanClaudeCompletionAndUnknownStatus(t *testing.T) {
	session, _, service, _ := notificationFixture(t)
	session.Kind = "claude-structured"
	service.HandleEvent(session, map[string]any{"type": "message", "message": map[string]any{"kind": "turn-end", "turnId": "claude-turn", "turnStatus": "completed"}})
	if len(service.deliveries) != 1 {
		t.Fatal("Claude completion no longer notifies")
	}
	for _, status := range []string{"", "running", "interrupted", "cancelled"} {
		service.HandleEvent(session, completionEvent("root", status, status))
	}
	if len(service.deliveries) != 1 {
		t.Fatal("non-terminal status notified completion")
	}
}

func TestServerChanRealEventPipelineSendsQuestionsAndRootCompletionToLocalReceiver(t *testing.T) {
	received := make(chan string, 8)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		received <- r.Form.Get("title")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer receiver.Close()
	target, _ := url.Parse(receiver.URL)
	session, provider, service, _ := notificationFixture(t)
	manager := NewSessionManager(session.WorkingDirectory)
	manager.sessions[session.ID] = session
	session.events = manager.events
	service.sessions = manager
	// 所有网络请求都改写到本地接收器，绝不读取或发送真实 Server 酱 key。
	service.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r = r.Clone(r.Context())
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		return http.DefaultTransport.RoundTrip(r)
	}), Timeout: time.Second}
	service.Start(context.Background())
	defer service.Close()
	provider.handleNotification("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "root-turn"}})
	addTestQuestion(provider, true)
	select {
	case title := <-received:
		if title != "待回复｜当前对话" {
			t.Fatalf("wrong async question notification: %s", title)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("async question notification missing")
	}
	addTestQuestion(provider, true)
	provider.handleNotification("turn/completed", map[string]any{"threadId": "child", "turn": map[string]any{"id": "child-turn", "status": "completed"}})
	// 审批通知作为 FIFO 屏障，收到它即证明前面的子任务事件已被消费。
	session.addPermission(Permission{ID: "barrier-approval", Status: "pending"})
	select {
	case title := <-received:
		if title != "待审批｜当前对话" {
			t.Fatalf("child notified before root: %s", title)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("local receiver timed out")
	}
	provider.handleNotification("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "root-turn", "status": "completed"}})
	select {
	case title := <-received:
		if title != "已完成｜当前对话" {
			t.Fatalf("wrong root notification: %s", title)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("root notification missing")
	}
}
