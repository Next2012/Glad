package app

import (
	"strings"
	"testing"
)

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
