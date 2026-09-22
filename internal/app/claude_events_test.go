package app

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

func claudeFeatureTestProvider() (*ClaudeProvider, *Session) {
	session := newSession("claude-features", "Claude", "claude-structured", ToolInfo{Key: "claude-code"}, ".")
	provider := NewClaudeProvider(session, nil)
	provider.stdin = nopWriteCloser{Buffer: &bytes.Buffer{}}
	return provider, session
}

type nopWriteCloser struct{ *bytes.Buffer }

func (writer nopWriteCloser) Close() error { return nil }

func TestClaudeRichStreamVersionGate(t *testing.T) {
	if !claudeSupportsRichStream("2.1.278 (Claude Code)") {
		t.Fatal("current Claude version should enable rich stream support")
	}
	if claudeSupportsRichStream("1.9.0") || claudeSupportsRichStream("unknown") {
		t.Fatal("old or unknown Claude versions should use the compatibility transport")
	}
}

func TestClaudePartialAssistantPatchesOneMessage(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	provider.turns = []claudeTurn{{ID: "turn-1", Started: millis()}}
	provider.handleStreamEvent(map[string]any{
		"type": "stream_event", "uuid": "assistant-1",
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": "api-message-1"}},
	})
	for index, delta := range []string{"Hello", " world"} {
		provider.handleStreamEvent(map[string]any{
			"type": "stream_event", "uuid": "stream-delta-" + string(rune('1'+index)),
			"event": map[string]any{"type": "content_block_delta", "delta": map[string]any{"type": "text_delta", "text": delta}},
		})
	}
	provider.handleMessage(map[string]any{
		"type": "assistant", "uuid": "assistant-final",
		"message": map[string]any{"id": "api-message-1", "content": []any{map[string]any{"type": "text", "text": "Hello world"}}},
	})
	if len(session.Messages) != 1 {
		t.Fatalf("expected one patched assistant message, got %#v", session.Messages)
	}
	message := session.Messages[0]
	if message["text"] != "Hello world" || boolValue(message["streaming"]) {
		t.Fatalf("unexpected completed stream message: %#v", message)
	}
}

func TestClaudeQuestionIsNotPermissionAndReturnsAnswers(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	output := &bytes.Buffer{}
	provider.stdin = nopWriteCloser{Buffer: output}
	provider.handleControlRequest(map[string]any{
		"request_id": "question-rpc", "request": map[string]any{
			"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": "question-tool",
			"input": map[string]any{"questions": []any{map[string]any{
				"question": "Which database?", "header": "Database", "multiSelect": false,
				"options": []any{map[string]any{"label": "SQLite", "description": "Local"}, map[string]any{"label": "Postgres", "description": "Server"}},
			}}},
		},
	})
	if len(session.Permissions) != 0 || len(provider.questions) != 1 {
		t.Fatalf("question leaked into permissions: questions=%#v permissions=%#v", provider.questions, session.Permissions)
	}
	questionID := stringValue(session.Messages[0]["id"])
	if err := provider.RespondUserInput(context.Background(), questionID, map[string]any{
		"answers": map[string]any{"Which database?": "SQLite"},
	}); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatalf("decode control response: %v (%q)", err, output.String())
	}
	updated := mapValue(mapValue(mapValue(response["response"])["response"])["updatedInput"])
	if mapValue(updated["answers"])["Which database?"] != "SQLite" {
		t.Fatalf("question answer not returned to Claude: %#v", response)
	}
	if session.Messages[0]["questionStatus"] != "answered" {
		t.Fatalf("question card was not settled: %#v", session.Messages[0])
	}
}

func TestClaudeTaskToolsProduceDurablePlan(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	provider.handleTaskToolCall("turn-1", "TodoWrite", "todo-1", map[string]any{
		"todos": []any{
			map[string]any{"content": "Inspect code", "status": "completed"},
			map[string]any{"content": "Implement change", "activeForm": "Implementing change", "status": "in_progress"},
		},
	})
	if len(session.Messages) != 1 || session.Messages[0]["kind"] != "task-plan" {
		t.Fatalf("expected a single task plan: %#v", session.Messages)
	}
	steps := sliceValue(session.Messages[0]["plan"])
	if len(steps) != 2 || mapValue(steps[1])["status"] != "inProgress" {
		t.Fatalf("unexpected normalized tasks: %#v", steps)
	}
	provider.finishTaskPlan("turn-1", "completed")
	if session.Messages[0]["planTurnStatus"] != "completed" {
		t.Fatalf("task plan did not finish: %#v", session.Messages[0])
	}
}

func TestClaudeStatusUsesStructuredContextData(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	provider.statusPending = true
	provider.statusUsage = map[string]any{"inputTokens": int64(10), "outputTokens": int64(2)}
	provider.appendLocalCommandMessage("/context", map[string]any{
		"contextUsage": map[string]any{
			"model": "haiku", "total_tokens": float64(1200), "raw_max_tokens": float64(200000), "percentage": float64(1),
			"categories": []any{map[string]any{"name": "Messages", "tokens": float64(500), "kind": "used"}},
		},
	})
	if len(session.Messages) != 1 || session.Messages[0]["kind"] != "status" {
		t.Fatalf("expected one combined status card: %#v", session.Messages)
	}
	contextValue := mapValue(session.Messages[0]["context"])
	if contextValue["model"] != "haiku" || numberInt64(contextValue["remainingTokens"]) != 198800 {
		t.Fatalf("unexpected structured context: %#v", contextValue)
	}
	if provider.statusPending {
		t.Fatal("status request remained pending")
	}
}

func TestClaudeStatusMergesRateLimitWindowsAndReusesCard(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	provider.statusPending = true
	provider.statusUsage = map[string]any{"rateLimits": []any{
		map[string]any{"kind": "session", "group": "session", "usedPercent": float64(8), "resetsAt": "2026-09-22T05:00:00Z"},
	}}
	provider.finishStatus(map[string]any{"model": "haiku"}, nil)

	provider.statusPending = true
	provider.statusUsage = map[string]any{"rateLimits": []any{
		map[string]any{"kind": "weekly_all", "group": "weekly", "usedPercent": float64(7), "resetsAt": "2026-09-23T07:00:00Z"},
	}}
	provider.finishStatus(map[string]any{"model": "haiku"}, nil)

	statusMessages := []map[string]any{}
	for _, message := range session.Messages {
		if stringValue(message["kind"]) == "status" {
			statusMessages = append(statusMessages, message)
		}
	}
	if len(statusMessages) != 1 {
		t.Fatalf("status refresh appended duplicate cards: %#v", session.Messages)
	}
	limits := sliceValue(mapValue(statusMessages[0]["usage"])["rateLimits"])
	if len(limits) != 2 || stringValue(mapValue(limits[0])["kind"]) != "session" ||
		stringValue(mapValue(limits[1])["kind"]) != "weekly_all" {
		t.Fatalf("rate-limit windows were not merged in display order: %#v", limits)
	}
}

func TestClaudeUsageParsesSubscriptionReport(t *testing.T) {
	usage, err := claudeUsageFromCommand(map[string]any{"usageReport": map[string]any{
		"session": map[string]any{
			"total_cost_usd": float64(0.16), "total_api_duration_ms": float64(2300),
			"model_usage": map[string]any{"claude-sonnet-5": map[string]any{
				"inputTokens": float64(2), "outputTokens": float64(73),
				"cacheReadInputTokens": float64(10), "cacheCreationInputTokens": float64(41162),
			}},
		},
		"rate_limits": map[string]any{"limits": []any{
			map[string]any{"kind": "session", "percent": float64(3), "resets_at": "2026-09-21T05:20:00Z"},
			map[string]any{"kind": "weekly_all", "percent": float64(0), "resets_at": "2026-09-23T07:00:00Z"},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if numberInt64(usage["outputTokens"]) != 73 || numberInt64(usage["cacheWriteTokens"]) != 41162 {
		t.Fatalf("unexpected subscription usage: %#v", usage)
	}
	if limits := sliceValue(usage["rateLimits"]); len(limits) != 2 || mapValue(limits[0])["usedPercent"] != float64(3) {
		t.Fatalf("subscription limits missing: %#v", usage)
	}
}

func TestClaudeAutomaticContextPatchesTurnEnd(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	turnEnd := session.appendMessage(map[string]any{"kind": "turn-end", "turnId": "turn-1", "turnStatus": "completed"})
	provider.contextTurnID = "turn-1"
	provider.localCommand = "/context"
	provider.handleMessage(map[string]any{"type": "system", "subtype": "local_command", "contextUsage": map[string]any{
		"model": "haiku", "total_tokens": float64(1200), "raw_max_tokens": float64(200000), "percentage": float64(1),
	}})
	var patched map[string]any
	for _, message := range session.Messages {
		if message["id"] == turnEnd["id"] {
			patched = message
		}
	}
	contextValue := mapValue(patched["context"])
	if numberInt64(contextValue["remainingTokens"]) != 198800 || numberInt64(contextValue["remainingPercent"]) != 99 {
		t.Fatalf("turn context was not patched: %#v", patched)
	}
	if session.StatusValue != "idle" || provider.contextTurnID != "" {
		t.Fatalf("automatic context did not settle: state=%s pending=%q", session.StatusValue, provider.contextTurnID)
	}
}

func TestClaudeLocalCommandResultPatchesTurnContext(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	provider.session.Tool.Version = "2.1.278 (Claude Code)"
	turnEnd := session.appendMessage(map[string]any{"kind": "turn-end", "turnId": "turn-1", "turnStatus": "completed"})
	provider.contextTurnID = "turn-1"
	provider.localCommand = "/context"
	provider.handleMessage(map[string]any{
		"type": "result", "subtype": "success",
		"result": "## Context Usage\n\n**Model:** haiku\n**Tokens:** 1.2k / 200k (1%)",
	})
	if numberInt64(mapValue(turnEnd["context"])["remainingTokens"]) != 198800 || provider.localCommand != "" {
		t.Fatalf("local command result did not patch the turn: command=%q message=%#v", provider.localCommand, turnEnd)
	}
}

func TestClaudeUsageParsesSubscriptionText(t *testing.T) {
	usage, err := parseClaudeUsage("You are currently using your subscription to power your Claude Code usage\n\n" +
		"Current session: 3% used · resets Sep 21, 1:20pm (Asia/Shanghai)\n" +
		"Current week (all models): 0% used · resets Sep 23, 3pm (Asia/Shanghai)\n")
	if err != nil {
		t.Fatal(err)
	}
	limits := sliceValue(usage["rateLimits"])
	if len(limits) != 2 || numberInt64(mapValue(limits[0])["usedPercent"]) != 3 {
		t.Fatalf("subscription text limits missing: %#v", usage)
	}
}

func TestClaudeReadyEventIsEmittedOncePerRuntime(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	initMessage := map[string]any{
		"type": "system", "subtype": "init", "session_id": "claude-session", "model": "haiku",
	}
	provider.handleMessage(initMessage)
	provider.handleMessage(initMessage)
	ready := 0
	for _, message := range session.Messages {
		if stringValue(message["text"]) == "Claude ready (haiku)" {
			ready++
		}
	}
	if ready != 1 {
		t.Fatalf("expected one ready event, got %d: %#v", ready, session.Messages)
	}
}

func TestClaudePermissionRememberEchoesProviderSuggestion(t *testing.T) {
	provider, session := claudeFeatureTestProvider()
	output := &bytes.Buffer{}
	provider.stdin = nopWriteCloser{Buffer: output}
	provider.turns = []claudeTurn{{ID: "turn-1", Started: millis()}}
	provider.permissions["permission-1"] = claudePending{
		RequestID: "permission-rpc", ToolUseID: "tool-1", ToolName: "Bash",
		Input:       map[string]any{"command": "go test ./..."},
		Suggestions: []any{map[string]any{"type": "addRules", "destination": "session"}},
	}
	provider.session.Permissions["permission-1"] = Permission{ID: "permission-1", Status: "pending"}
	if err := provider.Approve(context.Background(), "permission-1", "allow-remember", nil); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	wire := mapValue(mapValue(response["response"])["response"])
	if len(sliceValue(wire["updatedPermissions"])) != 1 {
		t.Fatalf("provider suggestion was not echoed: %#v", response)
	}
	if session.StatusValue != "thinking" || stringValue(session.State["status"]) != "thinking" ||
		numberInt64(session.State["pendingPermissionCount"]) != 0 {
		t.Fatalf("resolved approval left stale session state: status=%s state=%#v", session.StatusValue, session.State)
	}
}
