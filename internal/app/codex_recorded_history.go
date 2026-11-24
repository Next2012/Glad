package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// Turn summaries can omit commentary and tool executions. Supplement only the
// turns returned by Codex, using its own completed-item audit records. Never
// request an unbounded full-turn RPC or introduce rolled-back/foreign turns.
func supplementCodexRecordedHistory(ctx context.Context, path, threadID string, turns []any) ([]any, error) {
	if path == "" {
		return turns, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return turns, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return turns, err
	}
	if !info.Mode().IsRegular() {
		return turns, errors.New("Codex rollout is not a regular file")
	}
	allowed := map[string]bool{}
	for _, value := range turns {
		allowed[stringValue(mapValue(value)["id"])] = true
	}
	recorded := map[string][]any{}
	positions := map[string]map[string]int{}
	matched, oversized := false, false
	reader := bufio.NewReaderSize(file, 64<<10)
	var line []byte
	retained := 0
	for {
		if err := ctx.Err(); err != nil {
			return turns, err
		}
		part, readErr := reader.ReadSlice('\n')
		if len(line)+len(part) > 8<<20 {
			oversized = true
			line = nil
		}
		if !oversized {
			line = append(line, part...)
		}
		if readErr == bufio.ErrBufferFull {
			continue
		}
		if readErr != nil && readErr != io.EOF {
			return turns, readErr
		}
		var record struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if !oversized && json.Unmarshal(line, &record) == nil {
			payload := record.Payload
			if record.Type == "session_meta" {
				if stringValue(payload["id"]) != threadID {
					return turns, errors.New("Codex rollout belongs to another thread")
				}
				matched = true
			}
			turnID := stringValue(payload["turn_id"])
			if matched && record.Type == "event_msg" && payload["type"] == "item_completed" && allowed[turnID] && (stringValue(payload["thread_id"]) == "" || payload["thread_id"] == threadID) {
				item := normalizeCodexRecordedItem(mapValue(payload["item"]))
				id := stringValue(item["id"])
				if id != "" && retained+len(line) <= 32<<20 {
					if positions[turnID] == nil {
						positions[turnID] = map[string]int{}
					}
					if index, found := positions[turnID][id]; found {
						recorded[turnID][index] = item
					} else {
						positions[turnID][id] = len(recorded[turnID])
						recorded[turnID] = append(recorded[turnID], item)
					}
					retained += len(line)
				}
			}
		}
		line = line[:0]
		oversized = false
		if readErr == io.EOF {
			break
		}
	}
	if !matched {
		return turns, errors.New("Codex rollout has no thread metadata")
	}
	result := make([]any, len(turns))
	for index, value := range turns {
		turn := mapValue(value)
		items := recorded[stringValue(turn["id"])]
		if len(items) == 0 {
			result[index] = value
			continue
		}
		apiItems := sliceValue(turn["items"])
		apiByID := map[string]map[string]any{}
		for _, value := range apiItems {
			api := mapValue(value)
			if id := stringValue(api["id"]); id != "" {
				apiByID[id] = api
			}
		}
		merged := []any{}
		emitted := map[string]bool{}
		appendRecorded := func(from, to int) {
			for _, value := range items[from:to] {
				id := stringValue(mapValue(value)["id"])
				// Shared items belong at their API position, even when their
				// native completion order differs (parallel tool executions).
				if apiByID[id] != nil || emitted[id] {
					continue
				}
				merged = append(merged, value)
				emitted[id] = true
			}
		}
		next := 0
		for _, apiValue := range apiItems {
			if err := ctx.Err(); err != nil {
				return turns, err
			}
			api := mapValue(apiValue)
			id := stringValue(api["id"])
			if id != "" && emitted[id] {
				continue
			}
			found, exists := positions[stringValue(turn["id"])][id]
			if !exists {
				merged = append(merged, apiValue)
				emitted[id] = true
				continue
			}
			if found >= next {
				appendRecorded(next, found)
				next = found + 1
			}
			// The API owns current content; recorded fields fill omissions.
			combined := cloneMap(mapValue(items[found]))
			for key, value := range api {
				if value != nil {
					combined[key] = value
				}
			}
			merged = append(merged, combined)
			emitted[id] = true
		}
		appendRecorded(next, len(items))
		copy := cloneMap(turn)
		copy["items"] = merged
		result[index] = copy
	}
	return result, nil
}

func normalizeCodexRecordedItem(value map[string]any) map[string]any {
	raw := map[string]any{}
	for key, value := range value {
		parts := strings.Split(key, "_")
		for index := 1; index < len(parts); index++ {
			if parts[index] != "" {
				parts[index] = strings.ToUpper(parts[index][:1]) + parts[index][1:]
			}
		}
		raw[strings.Join(parts, "")] = value
	}
	kind := stringValue(raw["type"])
	if kind != "" {
		kind = strings.ToLower(kind[:1]) + kind[1:]
		raw["type"] = kind
	}
	if kind == "agentMessage" {
		raw["text"] = firstNonEmpty(stringValue(raw["text"]), codexRolloutContentText(raw["content"]))
	}
	if kind == "commandExecution" {
		if command, ok := raw["command"].([]any); ok {
			raw["command"] = strings.Join(stringsFromAny(command), " ")
		}
		raw["aggregatedOutput"] = limitCodexToolOutput(stringValue(raw["aggregatedOutput"]))
		duration := mapValue(raw["duration"])
		raw["durationMs"] = numberInt64(duration["secs"])*1000 + numberInt64(duration["nanos"])/1_000_000
	}
	return raw
}
