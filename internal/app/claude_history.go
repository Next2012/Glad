package app

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	claudeHistoryMessageLimit = 1000
	claudeHistoryTextLimit    = 64 << 10
	claudeHistoryToolLimit    = 16 << 10
	claudeHistoryInputLimit   = 32 << 10
)

func readClaudeTranscript(cwd, id string) []map[string]any {
	messages, _ := readClaudeTranscriptFile(cwd, id)
	return messages
}

func readClaudeTranscriptFile(cwd, id string) ([]map[string]any, error) {
	file, err := os.Open(filepathForClaudeTranscript(cwd, id))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return readClaudeTranscriptReader(file)
}

func filepathForClaudeTranscript(cwd, id string) string {
	return filepath.Join(claudeProjectDir(cwd), id+".jsonl")
}

func readClaudeTranscriptReader(reader io.Reader) ([]map[string]any, error) {
	messages := []map[string]any{}
	currentTurnID := ""
	turnStartedAt := int64(0)
	lastTimestamp := int64(0)

	finishTurn := func(timestamp int64) {
		if currentTurnID == "" {
			return
		}
		if timestamp <= 0 {
			timestamp = lastTimestamp
		}
		messages = append(messages, map[string]any{
			"id": "history-turn-end-" + currentTurnID, "kind": "turn-end",
			"turnId": currentTurnID, "turnStatus": "completed", "createdAt": timestamp,
			"durationMs": max64(0, timestamp-turnStartedAt),
		})
		currentTurnID = ""
		turnStartedAt = 0
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil || boolValue(record["isSidechain"]) {
			continue
		}
		timestamp := parseTimeMillis(stringValue(record["timestamp"]))
		if timestamp > 0 {
			lastTimestamp = timestamp
		}
		typeName := stringValue(record["type"])
		if typeName == "user" {
			if text := claudeTranscriptUserText(record); text != "" {
				finishTurn(timestamp)
				currentTurnID = firstNonEmpty(stringValue(record["uuid"]), stringValue(record["promptId"]), newUUID())
				turnStartedAt = timestamp
				messages = append(messages,
					map[string]any{
						"id": "history-turn-start-" + currentTurnID, "kind": "turn-start",
						"turnId": currentTurnID, "createdAt": timestamp,
					},
					map[string]any{
						"id": claudeHistoryRecordID(record, "user"), "kind": "user",
						"text":   codexPreviewText(text, claudeHistoryTextLimit),
						"turnId": currentTurnID, "createdAt": timestamp,
					},
				)
				continue
			}
			for index, blockValue := range sliceValue(mapValue(record["message"])["content"]) {
				block := mapValue(blockValue)
				if stringValue(block["type"]) != "tool_result" {
					continue
				}
				text := strings.TrimSpace(textFromClaudeContent([]any{block}))
				messages = append(messages, map[string]any{
					"id":   claudeHistoryRecordID(record, "result-"+numberText(index)),
					"kind": "tool-result", "toolUseId": block["tool_use_id"],
					"text":    codexPreviewText(text, claudeHistoryToolLimit),
					"isError": boolValue(block["is_error"]), "turnId": nilIfEmpty(currentTurnID),
					"createdAt": timestamp, "completedAtMs": timestamp,
				})
			}
			continue
		}
		if typeName != "assistant" {
			continue
		}
		content := sliceValue(mapValue(record["message"])["content"])
		text := strings.TrimSpace(textFromClaudeContent(content))
		if text != "" {
			messages = append(messages, map[string]any{
				"id": claudeHistoryRecordID(record, "assistant"), "kind": "assistant",
				"text": codexPreviewText(text, claudeHistoryTextLimit), "streaming": false,
				"turnId": nilIfEmpty(currentTurnID), "providerId": mapValue(record["message"])["id"],
				"createdAt": timestamp, "completedAtMs": timestamp,
			})
		}
		for index, blockValue := range content {
			block := mapValue(blockValue)
			switch stringValue(block["type"]) {
			case "thinking":
				thinking := strings.TrimSpace(firstNonEmpty(stringValue(block["thinking"]), stringValue(block["text"])))
				if thinking != "" {
					messages = append(messages, map[string]any{
						"id":   claudeHistoryRecordID(record, "thinking-"+numberText(index)),
						"kind": "reasoning", "text": codexPreviewText(thinking, claudeHistoryToolLimit),
						"turnId": nilIfEmpty(currentTurnID), "createdAt": timestamp,
					})
				}
			case "tool_use":
				name := firstNonEmpty(stringValue(block["name"]), "tool")
				if name == "AskUserQuestion" {
					continue
				}
				input := boundedClaudeHistoryInput(mapValue(block["input"]))
				toolUseID := stringValue(block["id"])
				messages = append(messages, map[string]any{
					"id":   claudeHistoryRecordID(record, "tool-"+numberText(index)),
					"kind": "tool", "name": name, "summary": summarizeToolInput(input), "input": input,
					"toolUseId": toolUseID, "providerId": toolUseID,
					"turnId": nilIfEmpty(currentTurnID), "startedAtMs": timestamp, "createdAt": timestamp,
				})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	finishTurn(lastTimestamp)
	if len(messages) > claudeHistoryMessageLimit {
		messages = messages[len(messages)-claudeHistoryMessageLimit:]
	}
	return messages, nil
}

func claudeTranscriptUserText(record map[string]any) string {
	if stringValue(record["type"]) != "user" || boolValue(record["isMeta"]) || boolValue(record["isSidechain"]) {
		return ""
	}
	content := mapValue(record["message"])["content"]
	if text, ok := content.(string); ok {
		return visibleClaudePrompt(text)
	}
	parts := []string{}
	for _, value := range sliceValue(content) {
		block := mapValue(value)
		if stringValue(block["type"]) == "tool_result" {
			return ""
		}
		if stringValue(block["type"]) == "text" {
			if text := visibleClaudePrompt(stringValue(block["text"])); text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func visibleClaudePrompt(text string) string {
	text = strings.TrimSpace(text)
	for _, prefix := range []string{
		"<command-name>", "<command-message>", "<local-command-caveat>", "<system-reminder>",
	} {
		if strings.HasPrefix(text, prefix) {
			return ""
		}
	}
	return text
}

func boundedClaudeHistoryInput(input map[string]any) map[string]any {
	encoded, _ := json.Marshal(input)
	if len(encoded) <= claudeHistoryInputLimit {
		return input
	}
	summary := firstNonEmpty(stringValue(input["command"]), stringValue(input["file_path"]), stringValue(input["path"]))
	if summary == "" {
		summary = string(encoded)
	}
	return map[string]any{"summary": codexPreviewText(summary, 2000), "truncated": true}
}

func claudeHistoryRecordID(record map[string]any, suffix string) string {
	base := firstNonEmpty(stringValue(record["uuid"]), newUUID())
	return base + "-" + suffix
}

func numberText(value int) string {
	return strconv.Itoa(value)
}

func claudeTranscriptSummary(filename string) ([]string, int64) {
	file, err := os.Open(filename)
	if err != nil {
		return []string{}, 0
	}
	defer file.Close()
	questions, createdAt, _ := claudeTranscriptSummaryReader(file)
	return questions, createdAt
}

func claudeTranscriptSummaryReader(reader io.Reader) ([]string, int64, error) {
	questions := []string{}
	createdAt := int64(0)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		if timestamp := stringValue(record["timestamp"]); createdAt == 0 && timestamp != "" {
			createdAt = parseTimeMillis(timestamp)
		}
		text := claudeTranscriptUserText(record)
		if text == "" {
			continue
		}
		questions = append(questions, codexPreviewText(text, 500))
		if len(questions) > 2 {
			questions = questions[len(questions)-2:]
		}
	}
	if err := scanner.Err(); err != nil {
		return questions, createdAt, err
	}
	for i, j := 0, len(questions)-1; i < j; i, j = i+1, j-1 {
		questions[i], questions[j] = questions[j], questions[i]
	}
	return questions, createdAt, nil
}
