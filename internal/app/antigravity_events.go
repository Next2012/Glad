package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (p *AntigravityProvider) updateLocked(params map[string]any) {
	id := stringValue(params["sessionId"])
	update := mapValue(params["update"])
	if p.replay != nil {
		if p.replay.sessionID == "" {
			p.replay.sessionID = id
		}
		if id == p.replay.sessionID {
			p.replay.updated = time.Now()
			p.reduceReplayLocked(update)
		}
		return
	}
	if id != p.nativeID {
		return
	}
	kind := stringValue(update["sessionUpdate"])
	p.session.speed.antigravityUpdate(update)
	switch kind {
	case "agent_message_chunk", "agent_thought_chunk", "user_message_chunk":
		if p.turnID == "" {
			return
		}
		messageKind := "assistant"
		if kind == "agent_thought_chunk" {
			messageKind = "reasoning"
		}
		if kind == "user_message_chunk" {
			return
		} // Native echo of an already accepted user input.
		text := antigravityContentText(update["content"])
		if text == "" {
			return
		}
		key := kind + ":" + stringValue(update["messageId"])
		stream := p.streams[key]
		if stream == nil {
			stream = &antigravityStream{id: newUUID()}
			p.streams[key] = stream
			p.appendLocked(map[string]any{"id": stream.id, "kind": messageKind, "text": "", "streaming": true})
		}
		// Bound retained stream text without making every delta copy the full body.
		if stream.text.Len() < 8<<20 {
			remaining := (8 << 20) - stream.text.Len()
			if len(text) > remaining {
				text = text[:remaining]
			}
			stream.text.WriteString(text)
		}
		stream.completedAt = 0
		p.session.patchMessage(stream.id, map[string]any{"text": stream.text.String(), "streaming": true, "completedAtMs": nil, "timeSource": "observed"})
		if p.deferred {
			p.scheduleSettleLocked()
		}
	case "tool_call", "tool_call_update":
		if p.turnID == "" {
			return
		}
		providerID := stringValue(update["toolCallId"])
		if providerID == "" {
			return
		}
		id := "antigravity-tool-" + p.turnID + "-" + providerID
		tool := p.tools[id]
		created := tool == nil
		if tool == nil {
			tool = map[string]any{"id": id, "kind": "tool", "providerId": providerID, "toolUseId": providerID, "status": "pending"}
			p.tools[id] = tool
		}
		for _, key := range []string{"title", "name", "kind", "status", "rawInput", "rawOutput", "content", "locations"} {
			if value, ok := update[key]; ok {
				if key == "kind" {
					tool["toolKind"] = value
				} else {
					budget := 8 << 20
					tool[key] = antigravityBoundValue(value, &budget)
				}
			}
		}
		budget := 8 << 20
		for _, key := range []string{"rawInput", "rawOutput", "content", "locations"} {
			if value, ok := tool[key]; ok {
				tool[key] = antigravityBoundValue(value, &budget)
			}
		}
		tool["toolName"] = firstNonEmpty(stringValue(tool["name"]), stringValue(tool["title"]), "Tool")
		if strings.Contains(strings.ToLower(stringValue(tool["toolName"])), "subagent") {
			p.invalidateSubagentDirectory()
		}
		tool["toolStatus"] = map[string]string{"pending": "pending", "in_progress": "running", "completed": "completed", "failed": "failed"}[stringValue(tool["status"])]
		tool["input"] = tool["rawInput"]
		tool["output"] = tool["rawOutput"]
		tool["text"] = antigravityToolText(tool)
		status := stringValue(tool["status"])
		tool["streaming"] = status == "pending" || status == "in_progress"
		if !boolValue(tool["streaming"]) {
			if numberInt64(tool["completedAtMs"]) == 0 {
				tool["completedAtMs"] = millis()
			}
		} else {
			delete(tool, "completedAtMs")
		}
		if created {
			p.appendLocked(cloneMap(tool))
		} else {
			p.session.patchMessage(id, cloneMap(tool))
		}
		p.scheduleSettleLocked()
		p.publishStateLocked()
	case "plan":
		if p.turnID == "" {
			return
		}
		id := "antigravity-plan-" + p.turnID
		entries := []map[string]any{}
		for _, entry := range mapsFromAny(update["entries"]) {
			entries = append(entries, map[string]any{"step": entry["content"], "content": entry["content"], "status": antigravityPlanStatus(entry["status"]), "priority": entry["priority"]})
		}
		message := map[string]any{"id": id, "kind": "task-plan", "title": "Plan", "plan": entries, "steps": entries, "status": "in_progress", "planTurnStatus": "running"}
		if p.tools[id] == nil {
			p.tools[id] = map[string]any{"status": "completed"}
			p.appendLocked(message)
		} else {
			p.session.patchMessage(id, message)
		}
	case "compaction_update":
		nativeID := firstNonEmpty(stringValue(update["compactionId"]), "current")
		id := "antigravity-compaction-" + p.nativeID + "-" + nativeID
		if p.compacting && p.compactionMessageID != "" {
			id = p.compactionMessageID
		}
		status := firstNonEmpty(stringValue(update["status"]), "in_progress")
		message := map[string]any{"id": id, "kind": "compaction", "compactionStatus": status, "text": firstNonEmpty(stringValue(update["message"]), stringValue(update["summary"]), "Antigravity conversation compaction"), "trigger": update["trigger"]}
		p.session.mu.RLock()
		exists := false
		for _, old := range p.session.Messages {
			if old["id"] == id {
				exists = true
				break
			}
		}
		p.session.mu.RUnlock()
		if exists {
			p.session.patchMessage(id, message)
		} else {
			p.appendLocked(message)
		}
		if status == "completed" || status == "failed" {
			p.compacting = false
		} else {
			p.compacting = true
			p.compactionMessageID = id
		}
		p.publishStateLocked()
	case "usage_update":
		if p.deferredTools && !p.hasOpenToolsLocked() && p.wirePrompts == 0 {
			p.followupSettled = true
		}
		p.usage = cloneMap(update)
		delete(p.usage, "sessionUpdate")
		p.publishStateLocked()
		p.scheduleSettleLocked()
	case "config_option_update":
		p.configOptions = mapsFromAny(update["configOptions"])
		p.publishStateLocked()
	case "current_mode_update":
		p.modes = cloneMap(p.modes)
		p.modes["currentModeId"] = update["currentModeId"]
		p.configOptions = append([]map[string]any(nil), p.configOptions...)
		for index, option := range p.configOptions {
			if option["id"] == "mode" {
				replacement := cloneMap(option)
				replacement["currentValue"] = update["currentModeId"]
				p.configOptions[index] = replacement
			}
		}
		p.publishStateLocked()
	case "available_commands_update":
		p.commands = mapsFromAny(update["availableCommands"])
		p.publishStateLocked()
	case "session_info_update":
		if title := stringValue(update["title"]); title != "" {
			p.session.setAutomaticName(title)
		}
	}
}
func antigravityContentText(value any) string {
	switch content := value.(type) {
	case string:
		return content
	case []any:
		parts := []string{}
		for _, block := range content {
			if text := antigravityContentText(block); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		if text := stringValue(content["text"]); text != "" {
			return text
		}
		if nested := content["content"]; nested != nil {
			return antigravityContentText(nested)
		}
		if resource := mapValue(content["resource"]); len(resource) > 0 {
			return stringValue(resource["text"])
		}
	}
	return ""
}
func antigravityToolText(tool map[string]any) string {
	text := antigravityContentText(tool["content"])
	if text == "" {
		switch output := tool["rawOutput"].(type) {
		case string:
			text = output
		case map[string]any:
			text = firstNonEmpty(stringValue(output["output"]), stringValue(output["text"]))
		}
	}
	if len(text) > 8<<20 {
		text = text[:8<<20]
	}
	return text
}
func (p *AntigravityProvider) serverRequestLocked(rpcID any, method string, params map[string]any, generation uint64) {
	if p.replay != nil || (stringValue(params["sessionId"]) != "" && stringValue(params["sessionId"]) != p.nativeID) {
		_ = p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": rpcID, "error": map[string]any{"code": -32000, "message": "Session is not active"}})
		return
	}
	switch method {
	case "session/request_permission":
		id := newUUID()
		tool := mapValue(params["toolCall"])
		options := mapsFromAny(params["options"])
		p.permissions[id] = antigravityInteraction{rpcID, generation, params}
		permission := Permission{ID: id, Status: "pending", Title: firstNonEmpty(stringValue(tool["title"]), "Antigravity tool permission"), ToolName: firstNonEmpty(stringValue(tool["name"]), stringValue(tool["title"])), ThreadID: p.nativeID, TurnID: p.turnID, Input: mapValue(tool["rawInput"]), Options: options, CreatedAt: millis(), ToolUseID: stringValue(tool["toolCallId"])}
		p.session.addPermission(permission)
		p.publishStateLocked()
	case "elicitation/create":
		if mode := stringValue(params["mode"]); mode != "" && mode != "form" {
			_ = p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": rpcID, "result": map[string]any{"action": "cancel"}})
			return
		}
		schema := mapValue(params["requestedSchema"])
		if stringValue(schema["type"]) != "object" {
			_ = p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": rpcID, "error": map[string]any{"code": -32602, "message": "Unsupported elicitation schema"}})
			return
		}
		id := newUUID()
		questions := []map[string]any{}
		properties := mapValue(schema["properties"])
		keys := make([]string, 0, len(properties))
		for key := range properties {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			property := mapValue(properties[key])
			choices := []map[string]any{}
			for _, choice := range sliceValue(property["enum"]) {
				choices = append(choices, map[string]any{"label": fmt.Sprint(choice), "value": choice})
			}
			questions = append(questions, map[string]any{"id": key, "question": firstNonEmpty(stringValue(property["title"]), stringValue(property["description"]), key), "options": choices, "type": property["type"], "default": property["default"]})
		}
		p.questions[id] = antigravityInteraction{rpcID, generation, params}
		p.appendLocked(map[string]any{"id": id, "kind": "question", "questions": questions, "requestedSchema": schema, "text": stringValue(params["message"]), "questionStatus": "pending", "blocking": true})
		p.publishStateLocked()
		p.session.emit(map[string]any{"type": "question-request", "id": id, "threadId": p.nativeID, "turnId": p.turnID})
	default:
		_ = p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": rpcID, "error": map[string]any{"code": -32601, "message": "Unsupported ACP client method: " + method}})
	}
}
func (p *AntigravityProvider) Approve(ctx context.Context, id, decision string, payload map[string]any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	pending, ok := p.permissions[id]
	if !ok || pending.generation != p.generation {
		return errors.New("Antigravity permission request not found")
	}
	selected := stringValue(payload["optionId"])
	options := mapsFromAny(pending.params["options"])
	allowed := false
	found := false
	deny := decision == "denied" || decision == "deny" || decision == "abort" || decision == "cancel"
	if selected == "" {
		wanted := "allow_once"
		if deny {
			wanted = "reject_once"
		}
		if decision == "allow-remember" {
			wanted = "allow_always"
		}
		for _, option := range options {
			if option["kind"] == wanted {
				selected = stringValue(option["optionId"])
				break
			}
		}
	}
	for _, option := range options {
		if option["optionId"] == selected {
			found = true
			allowed = strings.HasPrefix(stringValue(option["kind"]), "allow_")
		}
	}
	outcome := map[string]any{"outcome": "cancelled"}
	if selected != "" {
		if !found {
			return errors.New("Antigravity permission option is not offered by the CLI")
		}
		outcome = map[string]any{"outcome": "selected", "optionId": selected}
	}
	if !found && !deny {
		return errors.New("Antigravity CLI did not offer a matching permission option")
	}
	if err := p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": pending.rpcID, "result": map[string]any{"outcome": outcome}}); err != nil {
		return err
	}
	delete(p.permissions, id)
	status := "denied"
	if allowed {
		status = "approved"
	}
	p.session.finishPermission(id, status, decision)
	p.publishStateLocked()
	p.scheduleSettleLocked()
	return nil
}
func (p *AntigravityProvider) RespondUserInput(ctx context.Context, id string, payload map[string]any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	pending, ok := p.questions[id]
	if !ok || pending.generation != p.generation {
		clientID := stringValue(payload["clientMessageId"])
		if clientID != "" {
			p.session.mu.RLock()
			answered := false
			for _, message := range p.session.Messages {
				if message["id"] == id && message["questionStatus"] == "answered" && message["answerClientMessageId"] == clientID {
					answered = true
					break
				}
			}
			p.session.mu.RUnlock()
			if answered {
				return nil
			}
		}
		return errors.New("Antigravity question not found")
	}
	action := firstNonEmpty(stringValue(payload["action"]), "accept")
	if action != "accept" && action != "decline" && action != "cancel" {
		return errors.New("invalid Antigravity question action")
	}
	result := map[string]any{"action": action}
	var answers map[string]any
	if action == "accept" {
		answers = mapValue(firstNonNil(payload["answers"], payload["content"]))
		var err error
		answers, err = antigravityFormAnswers(mapValue(pending.params["requestedSchema"]), answers)
		if err != nil {
			return err
		}
		result["content"] = answers
	}
	if err := p.writeLocked(map[string]any{"jsonrpc": "2.0", "id": pending.rpcID, "result": result}); err != nil {
		return err
	}
	delete(p.questions, id)
	status := "answered"
	if action != "accept" {
		status = "cancelled"
	}
	p.session.patchMessage(id, map[string]any{"questionStatus": status, "answers": answers, "answerClientMessageId": payload["clientMessageId"], "answerSupervisorSource": payload["supervisorSource"]})
	p.publishStateLocked()
	p.scheduleSettleLocked()
	return nil
}
func antigravityFormAnswers(schema, answers map[string]any) (map[string]any, error) {
	content := map[string]any{}
	properties := mapValue(schema["properties"])
	required := map[string]bool{}
	for _, value := range sliceValue(schema["required"]) {
		required[stringValue(value)] = true
	}
	for key := range answers {
		if _, ok := properties[key]; !ok {
			return nil, fmt.Errorf("unknown question field %s", key)
		}
	}
	for key, raw := range properties {
		property := mapValue(raw)
		value, exists := answers[key]
		if !exists {
			if fallback, ok := property["default"]; ok {
				value = fallback
				exists = true
			}
		}
		if !exists || value == nil {
			if required[key] {
				return nil, fmt.Errorf("answer required for %s", key)
			}
			continue
		}
		if wrapped := mapValue(value); wrapped["answers"] != nil {
			values := sliceValue(wrapped["answers"])
			if len(values) > 0 {
				value = values[0]
			}
		}
		kind := stringValue(property["type"])
		switch kind {
		case "boolean":
			if text, ok := value.(string); ok {
				parsed, err := strconv.ParseBool(text)
				if err != nil {
					return nil, fmt.Errorf("%s must be a boolean", key)
				}
				value = parsed
			}
			if _, ok := value.(bool); !ok {
				return nil, fmt.Errorf("%s must be a boolean", key)
			}
		case "number", "integer":
			text := fmt.Sprint(value)
			parsed, err := strconv.ParseFloat(text, 64)
			if err != nil || (kind == "integer" && parsed != float64(int64(parsed))) {
				return nil, fmt.Errorf("%s must be %s", key, kind)
			}
			if minimum, ok := property["minimum"]; ok && parsed < antigravityNumber(minimum) {
				return nil, fmt.Errorf("%s is below its minimum", key)
			}
			if maximum, ok := property["maximum"]; ok && parsed > antigravityNumber(maximum) {
				return nil, fmt.Errorf("%s exceeds its maximum", key)
			}
			value = parsed
		case "string", "":
			if _, ok := value.(string); !ok {
				return nil, fmt.Errorf("%s must be text", key)
			}
		default:
			return nil, fmt.Errorf("unsupported question field type: %s", kind)
		}
		choices := sliceValue(property["enum"])
		if len(choices) > 0 {
			valid := false
			for _, choice := range choices {
				if fmt.Sprint(choice) == fmt.Sprint(value) {
					valid = true
				}
			}
			if !valid {
				return nil, fmt.Errorf("invalid choice for %s", key)
			}
		}
		content[key] = value
	}
	return content, nil
}
func antigravityNumber(value any) float64 {
	number, _ := strconv.ParseFloat(fmt.Sprint(value), 64)
	return number
}

// Supervisor questions share the same form contract as direct browser answers.
func (p *AntigravityProvider) AnswerUserInput(ctx context.Context, id, clientID string, answers map[string]string, images []Attachment, sources ...*SupervisorSource) error {
	if len(images) > 0 {
		return errors.New("Antigravity form questions do not accept image answers")
	}
	values := map[string]any{}
	for key, value := range answers {
		values[key] = value
	}
	payload := map[string]any{"answers": values, "action": "accept", "clientMessageId": clientID}
	if len(sources) > 0 && sources[0] != nil {
		payload["supervisorSource"] = sources[0].values()
	}
	return p.RespondUserInput(ctx, id, payload)
}

// Bound native details before retaining them; unknown future fields never bypass
// the retained-payload limit. A truncated value is display data only.
func antigravityBoundValue(value any, budget *int) any {
	if *budget <= 0 {
		return "[truncated]"
	}
	switch value := value.(type) {
	case string:
		if len(value) > *budget {
			value = value[:*budget]
			for len(value) > 0 && !utf8.ValidString(value) {
				value = value[:len(value)-1]
			}
			*budget = 0
			return value + "\n[truncated]"
		}
		*budget -= len(value)
		return value
	case []any:
		out := make([]any, 0, len(value))
		for _, item := range value {
			if *budget <= 0 {
				break
			}
			out = append(out, antigravityBoundValue(item, budget))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for key, item := range value {
			if *budget <= 0 {
				break
			}
			*budget -= len(key)
			out[key] = antigravityBoundValue(item, budget)
		}
		return out
	default:
		*budget -= 16
		return value
	}
}

func antigravityPlanStatus(value any) string {
	status := stringValue(value)
	if status == "in_progress" {
		return "inProgress"
	}
	return status
}
func antigravityPlanEntries(value any) []map[string]any {
	entries := []map[string]any{}
	for _, entry := range mapsFromAny(value) {
		entries = append(entries, map[string]any{"step": entry["content"], "content": entry["content"], "status": antigravityPlanStatus(entry["status"]), "priority": entry["priority"]})
	}
	return entries
}
