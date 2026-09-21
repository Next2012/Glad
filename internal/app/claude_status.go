package app

import (
	"strconv"
	"strings"
)

func (provider *ClaudeProvider) appendLocalCommandMessage(command string, raw map[string]any) {
	provider.mu.Lock()
	statusPending := provider.statusPending
	contextTurnID := provider.contextTurnID
	if command == "/context" && contextTurnID != "" {
		provider.contextTurnID = ""
	}
	provider.mu.Unlock()
	if statusPending && command == "/usage" {
		usage, err := claudeUsageFromCommand(raw)
		provider.mu.Lock()
		if err == nil {
			provider.statusUsage = usage
		} else {
			provider.statusUsage = map[string]any{"error": err.Error()}
		}
		provider.mu.Unlock()
		if err := provider.RunLocalCommand(provider.session.ctx, "/context"); err != nil {
			provider.finishStatus(nil, err)
		}
		return
	}
	if command == "/usage" {
		if usage, err := claudeUsageFromCommand(raw); err == nil {
			provider.session.appendMessage(map[string]any{
				"kind": "usage", "title": "Claude usage",
				"usage": map[string]any{"source": "claude-cli-command", "session": usage, "fetchedAt": millis()},
			})
			return
		}
	}
	if command == "/context" {
		var contextValue map[string]any
		if contextUsage := mapValue(raw["contextUsage"]); len(contextUsage) > 0 {
			contextValue = claudeStructuredContext(contextUsage)
		} else if parsed, err := parseClaudeContext(stringValue(raw["content"])); err == nil {
			contextValue = parsed
		}
		if statusPending {
			provider.finishStatus(contextValue, nil)
			return
		}
		if contextTurnID != "" {
			provider.patchTurnContext(contextTurnID, contextValue)
			provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
			return
		}
		if contextValue != nil {
			provider.session.appendMessage(map[string]any{"kind": "context", "title": "Claude context", "context": contextValue})
			return
		}
	}
	if command == "/compact" {
		provider.session.appendMessage(map[string]any{
			"kind": "compaction", "compactionStatus": "completed", "text": stringValue(raw["content"]),
		})
		provider.session.setState(map[string]any{"compacting": false, "canCompact": true})
		return
	}
	provider.appendLocalCommand(command, stringValue(raw["content"]), nil)
}

func (provider *ClaudeProvider) requestTurnContext(turnID string) bool {
	provider.mu.Lock()
	if provider.localCommand != "" || provider.stdin == nil {
		provider.mu.Unlock()
		return false
	}
	provider.contextTurnID = turnID
	provider.mu.Unlock()
	if err := provider.RunLocalCommand(provider.session.ctx, "/context"); err != nil {
		provider.mu.Lock()
		if provider.contextTurnID == turnID {
			provider.contextTurnID = ""
		}
		provider.mu.Unlock()
		return false
	}
	return true
}

func (provider *ClaudeProvider) patchTurnContext(turnID string, contextValue map[string]any) {
	if len(contextValue) == 0 {
		return
	}
	messageID := ""
	provider.session.mu.RLock()
	for index := len(provider.session.Messages) - 1; index >= 0; index-- {
		message := provider.session.Messages[index]
		if stringValue(message["kind"]) == "turn-end" && stringValue(message["turnId"]) == turnID {
			messageID = stringValue(message["id"])
			break
		}
	}
	provider.session.mu.RUnlock()
	if messageID != "" {
		provider.session.patchMessage(messageID, map[string]any{"context": contextValue})
	}
}

func claudeUsageFromCommand(raw map[string]any) (map[string]any, error) {
	if report := mapValue(raw["usageReport"]); len(report) > 0 {
		return claudeStructuredUsage(report), nil
	}
	return parseClaudeUsage(stringValue(raw["content"]))
}

func claudeStructuredUsage(report map[string]any) map[string]any {
	session := mapValue(report["session"])
	result := map[string]any{
		"totalCostUsd": session["total_cost_usd"], "apiDurationMs": session["total_api_duration_ms"],
		"wallDurationMs": session["total_duration_ms"], "linesAdded": session["total_lines_added"],
		"linesRemoved": session["total_lines_removed"],
	}
	models := []any{}
	var inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens int64
	for name, raw := range mapValue(session["model_usage"]) {
		model := mapValue(raw)
		input := numberInt64(firstNonNil(model["inputTokens"], model["input_tokens"]))
		output := numberInt64(firstNonNil(model["outputTokens"], model["output_tokens"]))
		cacheRead := numberInt64(firstNonNil(model["cacheReadInputTokens"], model["cache_read_input_tokens"]))
		cacheWrite := numberInt64(firstNonNil(model["cacheCreationInputTokens"], model["cache_creation_input_tokens"]))
		inputTokens += input
		outputTokens += output
		cacheReadTokens += cacheRead
		cacheWriteTokens += cacheWrite
		models = append(models, map[string]any{
			"model": name, "inputTokens": input, "outputTokens": output,
			"cacheReadTokens": cacheRead, "cacheWriteTokens": cacheWrite,
			"costUsd": firstNonNil(model["costUSD"], model["cost_usd"]),
		})
	}
	result["inputTokens"], result["outputTokens"] = inputTokens, outputTokens
	result["cacheReadTokens"], result["cacheWriteTokens"] = cacheReadTokens, cacheWriteTokens
	result["models"] = models
	limits := []any{}
	for _, raw := range sliceValue(mapValue(report["rate_limits"])["limits"]) {
		limit := mapValue(raw)
		limits = append(limits, map[string]any{
			"kind": limit["kind"], "group": limit["group"], "usedPercent": limit["percent"],
			"resetsAt": limit["resets_at"], "active": limit["is_active"],
		})
	}
	result["rateLimits"] = limits
	return result
}

func (provider *ClaudeProvider) finishStatus(contextValue map[string]any, statusErr error) {
	provider.mu.Lock()
	usage := provider.statusUsage
	provider.statusPending = false
	provider.statusUsage = nil
	provider.mu.Unlock()
	message := map[string]any{
		"kind": "status", "title": "Claude status", "usage": usage, "context": contextValue,
	}
	if statusErr != nil {
		message["error"] = statusErr.Error()
	}
	provider.session.appendMessage(message)
	provider.session.setState(map[string]any{"status": "idle", "canAbort": false})
}

func claudeStructuredContext(value map[string]any) map[string]any {
	total := numberInt64(value["raw_max_tokens"])
	used := numberInt64(value["total_tokens"])
	categories := []any{}
	for _, raw := range sliceValue(value["categories"]) {
		item := mapValue(raw)
		kind := stringValue(item["kind"])
		if kind == "free" {
			continue
		}
		categories = append(categories, map[string]any{
			"label": item["name"], "tokens": item["tokens"],
			"percent": func() string {
				if total <= 0 {
					return ""
				}
				return strconv.FormatInt(numberInt64(item["tokens"])*100/total, 10) + "%"
			}(),
		})
	}
	return map[string]any{
		"model": value["model"], "usedTokens": used, "maxTokens": total,
		"contextWindow": total, "usedPercent": value["percentage"], "remainingTokens": max64(0, total-used),
		"remainingPercent": max64(0, total-used) * 100 / max64(1, total), "categories": categories,
	}
}

func (provider *ClaudeProvider) appendCompactionMessage(raw map[string]any) {
	subtype := strings.ToLower(stringValue(raw["subtype"]))
	status := "completed"
	if strings.Contains(subtype, "start") {
		status = "running"
	}
	provider.session.appendMessage(map[string]any{
		"kind": "compaction", "compactionStatus": status, "text": stringValue(raw["content"]),
	})
	provider.session.setState(map[string]any{"compacting": status == "running", "canCompact": status != "running"})
}
