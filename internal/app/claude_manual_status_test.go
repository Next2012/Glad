package app

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestClaudeCompletionImmediatelyAllowsNextMessageWithoutContext(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	t.Cleanup(session.cancel)
	buffer := provider.stdin.(nopWriteCloser).Buffer
	provider.cmd = &exec.Cmd{}
	provider.turns = []claudeTurn{{ID: "turn", Started: millis()}}
	session.setState(map[string]any{"status": "thinking"})
	provider.handleMessage(map[string]any{"type": "result", "subtype": "success", "duration_ms": 1234, "usage": map[string]any{"input_tokens": 12}, "total_cost_usd": 0.1})
	if session.StatusValue != "idle" || buffer.Len() != 0 || provider.localCommand != "" || provider.statusPending {
		t.Fatal("回合结束仍读取自动统计或未恢复输入")
	}
	if err := provider.Send(context.Background(), ProviderInput{Text: "第二条", AgentText: "第二条"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buffer.String(), "第二条") || len(provider.turns) != 1 {
		t.Fatal("下一条消息未发到CLI")
	}
	for _, message := range session.Messages {
		if message["kind"] == "turn-end" && numberInt64(message["durationMs"]) != 1234 {
			t.Fatal("原结果统计丢失")
		}
	}
}

func TestClaudeManualStatusRefreshCanRepeatAndThenChat(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	t.Cleanup(session.cancel)
	provider.cmd = &exec.Cmd{}
	buffer := provider.stdin.(nopWriteCloser).Buffer
	for i := 0; i < 2; i++ {
		buffer.Reset()
		if err := provider.Status(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(buffer.String(), "/usage") || session.State["statusReading"] != true {
			t.Fatal("手动统计未启动")
		}
		before := append([]byte(nil), buffer.Bytes()...)
		if err := provider.Send(context.Background(), ProviderInput{Text: "过早输入"}); err == nil || !bytes.Equal(before, buffer.Bytes()) {
			t.Fatal("统计期间混入新输入")
		}
		provider.handleMessage(map[string]any{"type": "system", "subtype": "local_command", "usageReport": map[string]any{"session": map[string]any{"total_cost_usd": 0.25}}})
		if !strings.Contains(buffer.String(), "/context") {
			t.Fatal("手动统计未读取上下文")
		}
		provider.handleMessage(map[string]any{"type": "system", "subtype": "local_command", "contextUsage": map[string]any{"model": "test", "total_tokens": 1200, "raw_max_tokens": 200000, "percentage": 1}})
		if provider.statusPending || provider.localCommand != "" || session.State["statusReading"] != false || session.StatusValue != "idle" {
			t.Fatal("手动读取完成后未恢复")
		}
	}
	count := 0
	for _, m := range session.Messages {
		if m["kind"] == "status" {
			count++
			if numberInt64(mapValue(m["context"])["remainingTokens"]) != 198800 {
				t.Fatal("手动统计内容缺失")
			}
		}
	}
	if count != 1 {
		t.Fatal("重复刷新应更新同一张统计卡片")
	}
	if err := provider.Send(context.Background(), ProviderInput{Text: "统计后的消息", AgentText: "继续"}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeManualStatusProcessExitClearsBusyState(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	t.Cleanup(session.cancel)
	command := &exec.Cmd{}
	provider.cmd = command
	if err := provider.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	provider.handleProcessExit(command, context.Canceled)
	if provider.statusPending || provider.localCommand != "" || session.State["statusReading"] != false {
		t.Fatal("退出后统计仍占用")
	}
	provider.cmd = &exec.Cmd{}
	provider.stdin = nopWriteCloser{Buffer: &bytes.Buffer{}}
	if err := provider.Send(context.Background(), ProviderInput{Text: "重试", AgentText: "重试"}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeManualContextErrorIsVisible(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	t.Cleanup(session.cancel)
	provider.cmd = &exec.Cmd{}
	provider.statusPending = true
	provider.localCommand = "/context"
	provider.statusUsage = map[string]any{"totalCostUsd": 0.2}
	provider.handleMessage(map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true, "errors": []any{"synthetic context failure"}})
	last := session.Messages[len(session.Messages)-1]
	if last["kind"] != "status" || !strings.Contains(stringValue(last["error"]), "synthetic context failure") || mapValue(last["usage"])["totalCostUsd"] != 0.2 {
		t.Fatal("统计错误丢失或已读取用量丢失")
	}
	if provider.statusPending || session.State["statusReading"] != false {
		t.Fatal("错误后未恢复输入")
	}
}
