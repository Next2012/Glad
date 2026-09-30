package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClaudeWorkbenchBootstrapStaysHiddenAfterRestore(t *testing.T) {
	records := []map[string]any{
		{"type": "user", "uuid": "bootstrap", "message": map[string]any{"content": claudeWorkbenchBootstrap}},
		{"type": "assistant", "uuid": "opening", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "请确认当前需求。"}}}},
		{"type": "user", "uuid": "real-user", "message": map[string]any{"content": "我的需求是保留历史。"}},
	}
	var transcript strings.Builder
	for _, record := range records {
		data, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		transcript.Write(data)
		transcript.WriteByte('\n')
	}
	messages, err := readClaudeTranscriptReader(strings.NewReader(transcript.String()))
	if err != nil {
		t.Fatal(err)
	}
	var users, assistants []string
	for _, message := range messages {
		switch message["kind"] {
		case "user":
			users = append(users, stringValue(message["text"]))
		case "assistant":
			assistants = append(assistants, stringValue(message["text"]))
		}
	}
	if len(users) != 1 || users[0] != "我的需求是保留历史。" || len(assistants) != 1 || assistants[0] != "请确认当前需求。" {
		t.Fatalf("恢复历史应隐藏内部输入并保留用户及开场回复: users=%v assistants=%v", users, assistants)
	}
	questions, _, err := claudeTranscriptSummaryReader(strings.NewReader(transcript.String()))
	if err != nil || len(questions) != 1 || questions[0] != users[0] {
		t.Fatalf("历史摘要出现内部提示: questions=%v err=%v", questions, err)
	}
}

func TestClaudeTranscriptRestoresStructuredConversationWithoutInternalUserMessages(t *testing.T) {
	transcript := strings.Join([]string{
		`{"type":"user","uuid":"user-1","timestamp":"2026-09-21T10:00:00Z","message":{"role":"user","content":"Inspect the project"}}`,
		`{"type":"assistant","uuid":"assistant-tool","timestamp":"2026-09-21T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"I will inspect it."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"find . -maxdepth 2"}}]}}`,
		`{"type":"user","uuid":"tool-result-1","timestamp":"2026-09-21T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"very large terminal output"}]}}`,
		`{"type":"user","uuid":"meta-1","isMeta":true,"timestamp":"2026-09-21T10:00:03Z","message":{"role":"user","content":"Base directory for this skill: /tmp/bundled-skill"}}`,
		`{"type":"user","uuid":"command-1","timestamp":"2026-09-21T10:00:04Z","message":{"role":"user","content":"<command-name>/context</command-name>"}}`,
		`{"type":"assistant","uuid":"assistant-final","timestamp":"2026-09-21T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Inspection complete."}]}}`,
	}, "\n")

	messages, err := readClaudeTranscriptReader(strings.NewReader(transcript))
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	userTexts := []string{}
	var restoredTool, restoredResult map[string]any
	for _, message := range messages {
		kind := stringValue(message["kind"])
		kinds = append(kinds, kind)
		if kind == "user" {
			userTexts = append(userTexts, stringValue(message["text"]))
		}
		if kind == "tool" {
			restoredTool = message
		}
		if kind == "tool-result" {
			restoredResult = message
		}
	}
	if len(userTexts) != 1 || userTexts[0] != "Inspect the project" {
		t.Fatalf("internal transcript records became user messages: %#v", userTexts)
	}
	if restoredTool == nil || restoredTool["toolUseId"] != "tool-1" || restoredTool["name"] != "Bash" {
		t.Fatalf("tool call was not restored: kinds=%v tool=%#v", kinds, restoredTool)
	}
	if restoredResult == nil || restoredResult["toolUseId"] != "tool-1" || restoredResult["text"] != "very large terminal output" {
		t.Fatalf("tool result was not restored structurally: %#v", restoredResult)
	}
	for _, message := range messages {
		text := stringValue(message["text"])
		if strings.Contains(text, "Base directory for this skill") || strings.Contains(text, "<command-name>") {
			t.Fatalf("internal text leaked into restored history: %#v", message)
		}
	}
}

func TestClaudeTranscriptSummaryUsesOnlyRealPrompts(t *testing.T) {
	transcript := strings.Join([]string{
		`{"type":"user","uuid":"user-1","timestamp":"2026-09-21T10:00:00Z","message":{"role":"user","content":"First real prompt"}}`,
		`{"type":"user","uuid":"result-1","timestamp":"2026-09-21T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"terminal output must not be a title"}]}}`,
		`{"type":"user","uuid":"meta-1","isMeta":true,"timestamp":"2026-09-21T10:00:02Z","message":{"role":"user","content":"internal skill instructions"}}`,
		`{"type":"user","uuid":"user-2","timestamp":"2026-09-21T10:00:03Z","message":{"role":"user","content":"Second real prompt"}}`,
	}, "\n")

	questions, createdAt, err := claudeTranscriptSummaryReader(strings.NewReader(transcript))
	if err != nil {
		t.Fatal(err)
	}
	if createdAt == 0 || len(questions) != 2 || questions[0] != "Second real prompt" || questions[1] != "First real prompt" {
		t.Fatalf("unexpected transcript summary: created=%d questions=%#v", createdAt, questions)
	}
}
