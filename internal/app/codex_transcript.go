package app

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	codexTranscriptMessageLimit = 12000
	codexTranscriptTextLimit    = 128 << 10
)

// readCodexTranscriptFile is a read-only fallback for rooms. It never starts
// or resumes Codex, so a group can show history while another process owns the
// conversation writer.
func readCodexTranscriptFile(id string) ([]map[string]any, error) {
	id = strings.TrimSpace(id)
	if id == "" || strings.ContainsAny(id, `/\\`) {
		return nil, errors.New("invalid Codex conversation ID")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	matches, err := filepath.Glob(filepath.Join(codexHome, "sessions", "*", "*", "*", "*-"+id+".jsonl"))
	if err != nil || len(matches) == 0 {
		return nil, os.ErrNotExist
	}
	file, err := os.Open(matches[len(matches)-1])
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return readCodexTranscriptReader(file, id)
}

func readCodexTranscriptReader(reader io.Reader, conversationID string) ([]map[string]any, error) {
	messages := []map[string]any{}
	currentTurnID := ""
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		payload := mapValue(record["payload"])
		createdAt := parseTimeMillis(stringValue(record["timestamp"]))
		switch stringValue(record["type"]) {
		case "event_msg":
			typeName := stringValue(payload["type"])
			turnID := stringValue(payload["turn_id"])
			switch typeName {
			case "task_started":
				currentTurnID = turnID
				messages = append(messages, map[string]any{
					"id": "rollout-turn-start-" + turnID, "kind": "turn-start",
					"threadId": conversationID, "turnId": turnID, "createdAt": firstPositiveMillis(payload["started_at"], createdAt),
				})
			case "task_complete", "turn_aborted":
				status := "completed"
				if typeName == "turn_aborted" {
					status = "cancelled"
				}
				messages = append(messages, map[string]any{
					"id": "rollout-turn-end-" + turnID, "kind": "turn-end",
					"threadId": conversationID, "turnId": turnID, "status": status, "isRootTurn": true,
					"createdAt": firstPositiveMillis(payload["completed_at"], createdAt), "durationMs": numberInt64(payload["duration_ms"]),
				})
				if turnID == currentTurnID {
					currentTurnID = ""
				}
			}
		case "response_item":
			turnID := firstNonEmpty(
				stringValue(mapValue(payload["internal_chat_message_metadata_passthrough"])["turn_id"]), currentTurnID,
			)
			if turnID == "" {
				continue
			}
			message := codexRolloutItem(payload, conversationID, turnID, createdAt)
			if message != nil {
				messages = append(messages, message)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(messages) > codexTranscriptMessageLimit {
		messages = messages[len(messages)-codexTranscriptMessageLimit:]
	}
	return messages, nil
}

func codexRolloutItem(payload map[string]any, conversationID, turnID string, createdAt int64) map[string]any {
	typeName := stringValue(payload["type"])
	message := map[string]any{
		"id":       firstNonEmpty(stringValue(payload["id"]), stringValue(payload["call_id"]), newUUID()),
		"threadId": conversationID, "turnId": turnID, "createdAt": createdAt,
	}
	switch typeName {
	case "message":
		role := stringValue(payload["role"])
		if role == "user" && !codexRolloutUserAuthored(payload) {
			return nil
		}
		if role != "user" && role != "assistant" {
			return nil
		}
		text := strings.TrimSpace(codexRolloutContentText(payload["content"]))
		if text == "" {
			return nil
		}
		message["kind"], message["text"] = role, codexPreviewText(text, codexTranscriptTextLimit)
		message["streaming"] = false
	case "reasoning":
		parts := []string{}
		for _, value := range sliceValue(payload["summary"]) {
			if text := strings.TrimSpace(stringValue(mapValue(value)["text"])); text != "" {
				parts = append(parts, text)
			}
		}
		if len(parts) == 0 {
			return nil
		}
		message["kind"], message["text"] = "reasoning", codexPreviewText(strings.Join(parts, "\n"), codexTranscriptTextLimit)
	case "custom_tool_call", "function_call":
		message["kind"], message["name"] = "tool", firstNonEmpty(stringValue(payload["name"]), "Tool")
		message["providerId"] = firstNonNil(payload["call_id"], payload["id"])
		message["toolStatus"] = firstNonEmpty(stringValue(payload["status"]), "completed")
		message["input"] = firstNonNil(payload["input"], payload["arguments"])
	case "custom_tool_call_output", "function_call_output":
		message["kind"], message["toolUseId"] = "tool-result", payload["call_id"]
		message["text"] = codexPreviewText(codexRolloutOutputText(payload["output"]), codexTranscriptTextLimit)
		message[resourceDownloadsKey] = mcpDownloads(payload["output"])
	case "agent_message":
		text := strings.TrimSpace(codexRolloutContentText(payload["content"]))
		if text == "" {
			return nil
		}
		message["kind"], message["text"] = "subagent-message", codexPreviewText(text, codexTranscriptTextLimit)
	default:
		return nil
	}
	return message
}

func codexRolloutUserAuthored(payload map[string]any) bool {
	metadata := mapValue(payload["internal_chat_message_metadata_passthrough"])
	for _, value := range sliceValue(metadata["content_item_kinds"]) {
		if strings.HasPrefix(stringValue(value), "user.") {
			return true
		}
	}
	return false
}

func codexRolloutContentText(value any) string {
	parts := []string{}
	for _, itemValue := range sliceValue(value) {
		item := mapValue(itemValue)
		if text := strings.TrimSpace(stringValue(item["text"])); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func codexRolloutOutputText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return codexRolloutContentText(value)
}

func firstPositiveMillis(value any, fallback int64) int64 {
	if timestamp := timestampMillis(value); timestamp > 0 {
		return timestamp
	}
	return fallback
}
