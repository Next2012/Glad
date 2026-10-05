package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexEmptyHistoryDoesNotEraseKnownConversation(t *testing.T) {
	for _, evidence := range []string{"messages", "preview", "rollout", "unavailable-rollout"} {
		t.Run(evidence, func(t *testing.T) {
			provider, _, _ := historyTestProvider(t)
			thread := map[string]any{"id": "current"}
			switch evidence {
			case "messages":
				provider.session.appendMessage(map[string]any{"kind": "user", "text": "保留原消息"})
			case "preview":
				thread["preview"] = "原消息"
			case "rollout":
				thread["path"] = writePlanRollout(t, "current", planRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "original-turn"}))
			case "unavailable-rollout":
				thread["path"] = filepath.Join(t.TempDir(), "missing.jsonl")
			}
			before := len(provider.session.Messages)
			err := provider.hydrateThread(context.Background(), map[string]any{
				"thread": thread, "initialTurnsPage": map[string]any{"data": []any{}, "nextCursor": nil},
			})
			if err == nil || !strings.Contains(err.Error(), "历史尚未加载") || len(provider.session.Messages) != before {
				t.Fatalf("empty history was accepted or erased messages: err=%v messages=%d", err, len(provider.session.Messages))
			}
		})
	}
}

func TestCodexNewEmptyThreadCanResume(t *testing.T) {
	provider, _, _ := historyTestProvider(t)
	// 已有另一线程的消息以及启动提示，都不能把合法新空线程误判为丢历史。
	provider.session.appendMessage(map[string]any{"kind": "user", "threadId": "other", "text": "别的线程"})
	provider.session.appendMessage(map[string]any{"kind": "event", "text": "连接提示"})
	path := filepath.Join(t.TempDir(), "empty.jsonl")
	meta, _ := json.Marshal(planRecord("session_meta", map[string]any{"id": "new-empty"}))
	if err := os.WriteFile(path, append(meta, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := provider.hydrateThread(context.Background(), map[string]any{
		"thread":           map[string]any{"id": "new-empty", "path": path},
		"initialTurnsPage": map[string]any{"data": []any{}, "nextCursor": nil},
	}); err != nil {
		t.Fatalf("verified empty new thread rejected: %v", err)
	}
}

func TestCodexMalformedHistoryPageIsNotSuccessfulRecovery(t *testing.T) {
	provider, _, _ := historyTestProvider(t)
	for _, page := range []map[string]any{{"nextCursor": nil}, {"data": "invalid"}} {
		if _, err := provider.loadThreadTurns(context.Background(), "current", page, nil); err == nil {
			t.Fatal("malformed page reported successful history load")
		}
	}
}

func TestCodexInvalidTurnOrCursorCannotReplaceOriginalHistory(t *testing.T) {
	for _, invalid := range []any{nil, "bad", map[string]any{"id": "bad", "items": "wrong"},
		map[string]any{"id": 42, "items": []any{}}, map[string]any{"id": "valid", "items": []any{nil}}} {
		provider, _, _ := historyTestProvider(t)
		provider.session.appendMessage(map[string]any{"kind": "user", "text": "保留原历史"})
		err := provider.hydrateThread(context.Background(), map[string]any{
			"thread":           map[string]any{"id": "current"},
			"initialTurnsPage": map[string]any{"data": []any{invalid}, "nextCursor": nil},
		})
		if err == nil || len(provider.session.Messages) != 1 || provider.session.Messages[0]["text"] != "保留原历史" {
			t.Fatal("invalid turn replaced original history")
		}
	}
	provider, writes, _ := historyTestProvider(t)
	for _, cursor := range []any{42, true, []any{"next"}, map[string]any{"next": "page"}} {
		_, err := provider.loadThreadTurns(context.Background(), "current", map[string]any{
			"data": []any{map[string]any{"id": "valid", "items": []any{}}}, "nextCursor": cursor,
		}, nil)
		if err == nil {
			t.Fatal("invalid cursor accepted")
		}
		select {
		case <-writes:
			t.Fatal("invalid cursor was sent to the native API")
		default:
		}
	}
}

func TestCodexFailedResumePreservesOriginalThreadAndMessages(t *testing.T) {
	provider, writes, _ := historyTestProvider(t)
	provider.session.appendMessage(map[string]any{"kind": "user", "text": "保留原对话"})
	done := make(chan error, 1)
	go func() { done <- provider.Resume(context.Background(), "selected") }()
	request := historyTestRequest(t, writes)
	provider.handleRPC(map[string]any{"id": request["id"], "result": map[string]any{
		"thread":           map[string]any{"id": "selected", "preview": "existing history"},
		"initialTurnsPage": map[string]any{"data": []any{}, "nextCursor": nil},
	}})
	if err := <-done; err == nil {
		t.Fatal("empty existing history returned successful resume")
	}
	if provider.threadID != "current" || !provider.needsThreadResume || len(provider.session.Messages) != 1 {
		t.Fatal("failed resume changed the original conversation")
	}
}
