package app

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const codexCapacityRetryDelay = 30 * time.Second
const codexCapacityRetryLimit = 5

func isCodexCapacityError(err map[string]any) bool {
	code := stringValue(err["codexErrorInfo"])
	return code == "serverOverloaded" || code == "server_overloaded"
}

// 只在原任务最终因容量不足失败后安排下一轮，Codex 自身的重试仍由它处理。
func (provider *CodexProvider) scheduleCapacityRetryLocked(turn map[string]any) bool {
	if !isCodexCapacityError(mapValue(turn["error"])) || provider.capacityRetryAttempts >= codexCapacityRetryLimit ||
		provider.aborting || provider.closed || provider.session.ctx.Err() != nil {
		return false
	}
	provider.capacityRetryAttempts++
	provider.capacityRetryGeneration++
	generation := provider.capacityRetryGeneration
	delay := provider.capacityRetryDelay
	if delay <= 0 {
		delay = codexCapacityRetryDelay
	}
	provider.capacityRetryAt = millis() + delay.Milliseconds()
	provider.capacityRetryTimer = time.AfterFunc(delay, func() { provider.runCapacityRetry(generation) })
	provider.session.appendMessage(map[string]any{
		"kind": "event", "level": "info",
		"text": fmt.Sprintf("模型容量不足，%g 秒后自动重试（%d/%d），可点击停止取消。", delay.Seconds(), provider.capacityRetryAttempts, codexCapacityRetryLimit),
	})
	return true
}

func (provider *CodexProvider) cancelCapacityRetryLocked() {
	if provider.capacityRetryTimer != nil {
		provider.capacityRetryTimer.Stop()
		provider.capacityRetryTimer = nil
	}
	// 已触发的定时回调也必须失效，避免停止或新请求后继续发送。
	provider.capacityRetryGeneration++
	provider.capacityRetryAttempts = 0
	provider.capacityRetryAt = 0
}

func (provider *CodexProvider) runCapacityRetry(generation uint64) {
	ctx, cancel := context.WithTimeout(provider.session.ctx, 30*time.Second)
	defer cancel()
	// 续跑消息保持简短，次数和通知由 Glad 管理。
	err := provider.send(ctx, ProviderInput{ClientMessageID: newUUID(), Text: "继续", AgentText: "继续"}, generation)
	if err == nil {
		return
	}
	provider.mu.Lock()
	if generation != provider.capacityRetryGeneration || provider.closed || provider.aborting || provider.session.ctx.Err() != nil {
		provider.mu.Unlock()
		return
	}
	if provider.turnID != "" {
		// 启动响应失败前已经收到 turn/started，继续等待真实结果，避免重复失败通知。
		provider.updatePublicStateLocked("running")
		provider.mu.Unlock()
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		// 尚未确认启动的超时请求可能稍后执行，关闭原连接后再报告最终失败。
		provider.aborting = true
		provider.abortSequence++
		sequence := provider.abortSequence
		provider.turnID = "glad-retry-" + newUUID()
		provider.mu.Unlock()
		provider.stopRuntime(sequence, "自动重试启动超时，已停止原连接。", "failed")
		return
	}
	// 发起请求失败时没有 turn/completed，由 Glad 结束本次续跑并发送一次失败通知。
	provider.cancelCapacityRetryLocked()
	provider.session.appendMessage(map[string]any{"kind": "event", "level": "error", "text": "自动重试未能发起：" + err.Error()})
	provider.session.appendMessage(map[string]any{
		"kind": "turn-end", "threadId": provider.threadID, "turnId": newUUID(),
		"status": "failed", "isRootTurn": true,
		"error": map[string]any{"message": err.Error()},
	})
	provider.session.markCompletionUnread()
	provider.updatePublicStateLocked("idle")
	provider.mu.Unlock()
}
