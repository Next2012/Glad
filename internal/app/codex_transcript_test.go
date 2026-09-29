package app

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestReadCodexTranscriptKeepsUserTurnsAndDetailsButSkipsInjectedContext(t *testing.T) {
	rows := []map[string]any{
		{"timestamp": "2026-09-29T06:00:00Z", "type": "event_msg", "payload": map[string]any{
			"type": "task_started", "turn_id": "turn-1", "started_at": 1790661600,
		}},
		{"timestamp": "2026-09-29T06:00:01Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "injected", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "environment context"}},
			"internal_chat_message_metadata_passthrough": map[string]any{
				"turn_id": "turn-1", "content_item_kinds": []any{"environments.environment_context"},
			},
		}},
		{"timestamp": "2026-09-29T06:00:02Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "user-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "visible question"}},
			"internal_chat_message_metadata_passthrough": map[string]any{
				"turn_id": "turn-1", "content_item_kinds": []any{"user.text"},
			},
		}},
		{"timestamp": "2026-09-29T06:00:03Z", "type": "response_item", "payload": map[string]any{
			"type": "reasoning", "id": "reason-1", "summary": []any{map[string]any{"text": "reason summary"}},
		}},
		{"timestamp": "2026-09-29T06:00:04Z", "type": "response_item", "payload": map[string]any{
			"type": "custom_tool_call", "id": "tool-1", "call_id": "call-1", "name": "exec", "input": "pwd",
		}},
		{"timestamp": "2026-09-29T06:00:05Z", "type": "response_item", "payload": map[string]any{
			"type": "custom_tool_call_output", "id": "result-1", "call_id": "call-1", "output": "done",
		}},
		{"timestamp": "2026-09-29T06:00:06Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "assistant-1", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "visible answer"}},
		}},
		{"timestamp": "2026-09-29T06:00:07Z", "type": "event_msg", "payload": map[string]any{
			"type": "task_complete", "turn_id": "turn-1", "completed_at": 1790661607,
		}},
	}
	var input bytes.Buffer
	for _, row := range rows {
		encoded, _ := json.Marshal(row)
		input.Write(encoded)
		input.WriteByte('\n')
	}
	messages, err := readCodexTranscriptReader(&input, "thread-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 7 {
		t.Fatalf("messages = %#v", messages)
	}
	if stringValue(messages[1]["kind"]) != "user" || stringValue(messages[1]["text"]) != "visible question" ||
		stringValue(messages[5]["kind"]) != "assistant" || stringValue(messages[5]["text"]) != "visible answer" {
		t.Fatalf("visible conversation was not normalized: %#v", messages)
	}
	for _, message := range messages {
		if stringValue(message["text"]) == "environment context" {
			t.Fatal("injected environment context leaked into native history")
		}
	}
}
