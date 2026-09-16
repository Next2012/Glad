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

func normalizeCodexHistoryPlan(params map[string]any) (map[string]any, bool) {
	items, ok := params["plan"].([]any)
	if !ok {
		return nil, false
	}
	steps := make([]any, 0, len(items))
	for _, value := range items {
		item := mapValue(value)
		step, textOK := item["step"].(string)
		status := stringValue(item["status"])
		if status == "in_progress" {
			status = "inProgress"
		}
		if !textOK || strings.TrimSpace(step) == "" || (status != "pending" && status != "inProgress" && status != "completed") {
			return nil, false
		}
		steps = append(steps, map[string]any{"step": step, "status": status})
	}
	return map[string]any{"plan": steps, "explanation": stringValue(params["explanation"])}, true
}

func codexPlanCall(payload map[string]any) (map[string]any, bool) {
	name := stringValue(payload["name"])
	if name == "update_plan" || name == "functions.update_plan" || name == "tools.update_plan" {
		params := mapValue(payload["arguments"])
		if text, ok := payload["arguments"].(string); ok {
			if json.Unmarshal([]byte(text), &params) != nil {
				return nil, true
			}
		}
		plan, _ := normalizeCodexHistoryPlan(params)
		return plan, true
	}
	if payload["type"] == "custom_tool_call" && (name == "exec" || name == "functions.exec") {
		return codexCodePlan(stringValue(payload["input"]))
	}
	return nil, false
}

func codexPlanCallSucceeded(payload map[string]any) bool {
	if boolValue(payload["is_error"]) || payload["error"] != nil {
		return false
	}
	output := payload["output"]
	text, ok := output.(string)
	if !ok {
		for _, value := range sliceValue(output) {
			text += stringValue(mapValue(value)["text"]) + "\n"
		}
	}
	text = strings.TrimSpace(text)
	var result map[string]any
	if json.Unmarshal([]byte(text), &result) == nil && result["error"] != nil {
		return false
	}
	text = strings.ToLower(text)
	return text != "" && !strings.HasPrefix(text, "error") && !strings.HasPrefix(text, "failed") &&
		!strings.Contains(text, "script failed") && !strings.Contains(text, "script error:")
}

// Read only the rollout path supplied by Codex for the selected thread. The
// ordinary turn API omits update_plan calls, especially inside code-mode exec.
func readCodexPlanHistory(ctx context.Context, path, threadID string) (map[string]map[string]any, error) {
	plans := map[string]map[string]any{}
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Codex rollout is not a regular file")
	}
	type pendingPlan struct {
		turnID string
		plan   map[string]any
	}
	pending := map[string]pendingPlan{}
	turnID, matchedThread := "", false
	reader := bufio.NewReaderSize(file, 64*1024)
	var line []byte
	oversized := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > 8<<20 {
			oversized = true
			line = nil
		}
		if !oversized {
			line = append(line, part...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil && err != io.EOF {
			return nil, err
		}
		var record struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if !oversized && json.Unmarshal(line, &record) == nil {
			payload := record.Payload
			switch record.Type {
			case "session_meta":
				if stringValue(payload["id"]) != threadID {
					return nil, errors.New("Codex rollout belongs to another thread")
				}
				matchedThread = true
			case "turn_context":
				turnID = stringValue(payload["turn_id"])
			case "event_msg":
				switch stringValue(payload["type"]) {
				case "task_started":
					turnID = stringValue(payload["turn_id"])
					pending = map[string]pendingPlan{}
				case "plan_update":
					id := firstNonEmpty(stringValue(payload["turn_id"]), turnID)
					if plan, ok := normalizeCodexHistoryPlan(payload); matchedThread && ok && id != "" {
						plans[id] = plan
					}
				case "task_complete", "turn_aborted":
					turnID = ""
				}
			case "response_item":
				callID := stringValue(payload["call_id"])
				switch stringValue(payload["type"]) {
				case "function_call", "custom_tool_call":
					id := firstNonEmpty(stringValue(mapValue(payload["internal_chat_message_metadata_passthrough"])["turn_id"]), turnID)
					if plan, ok := codexPlanCall(payload); matchedThread && ok && id != "" && callID != "" {
						pending[callID] = pendingPlan{turnID: id, plan: plan}
					}
				case "function_call_output", "custom_tool_call_output":
					if candidate, ok := pending[callID]; ok {
						if codexPlanCallSucceeded(payload) {
							if candidate.plan != nil {
								plans[candidate.turnID] = candidate.plan
							} else {
								delete(plans, candidate.turnID)
							}
						}
						delete(pending, callID)
					}
				}
			}
		}
		line = line[:0]
		oversized = false
		if err == io.EOF {
			break
		}
	}
	if !matchedThread {
		return nil, errors.New("Codex rollout has no thread metadata")
	}
	return plans, nil
}
