package app

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Claude's stream-json transport is message-oriented rather than the
// thread/turn/item protocol exposed by Codex app-server. These reducers keep
// transport details out of the browser and publish the same durable Glad
// message shapes used by snapshots and reconnects.
type claudeTextStream struct {
	MessageID       string
	ProviderID      string
	ParentToolUseID string
	TurnID          string
	Text            strings.Builder
}

var claudeVersionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

func enrichClaudePlanInput(input map[string]any) map[string]any {
	result := cloneMap(input)
	if stringValue(result["plan"]) != "" {
		return result
	}
	path := strings.TrimSpace(firstNonEmpty(stringValue(result["planFilePath"]), stringValue(result["plan_file_path"])))
	if path == "" {
		return result
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return result
	}
	plansRoot, err := filepath.Abs(filepath.Join(home, ".claude", "plans"))
	if err != nil {
		return result
	}
	resolved, err := filepath.Abs(path)
	if err != nil || resolved != plansRoot && !strings.HasPrefix(resolved, plansRoot+string(os.PathSeparator)) {
		return result
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() || info.Size() > 1<<20 {
		return result
	}
	content, err := os.ReadFile(resolved)
	if err == nil {
		result["plan"] = string(content)
	}
	return result
}

func claudeSupportsRichStream(version string) bool {
	match := claudeVersionPattern.FindStringSubmatch(version)
	if len(match) != 4 {
		return false
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	return major > 2 || major == 2 && minor >= 1
}

func (provider *ClaudeProvider) currentTurnID() string {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.currentTurnIDLocked()
}

func (provider *ClaudeProvider) currentTurnIDLocked() string {
	if len(provider.turns) == 0 {
		return ""
	}
	return provider.turns[0].ID
}

func claudeStreamKey(message, event map[string]any) string {
	// Claude assigns a fresh outer uuid to individual stream events. It is not
	// the assistant-message identity, so keying on it fragments one response
	// into one Glad message per token. The parent tool-use id is the stable
	// stream lane for subagents; root output has only one active lane.
	if parentID := stringValue(message["parent_tool_use_id"]); parentID != "" {
		return "parent:" + parentID
	}
	return "root"
}

func (provider *ClaudeProvider) handleStreamEvent(message map[string]any) {
	event := mapValue(message["event"])
	eventType := stringValue(event["type"])
	key := claudeStreamKey(message, event)
	parentID := stringValue(message["parent_tool_use_id"])
	provider.mu.Lock()
	if alias := provider.streamAliases[key]; alias != "" {
		key = alias
	}
	stream := provider.streams[key]
	if eventType == "message_start" {
		providerID := stringValue(mapValue(event["message"])["id"])
		stream = &claudeTextStream{ProviderID: providerID, ParentToolUseID: parentID, TurnID: provider.currentTurnIDLocked()}
		provider.streams[key] = stream
		if providerID != "" {
			provider.streamAliases[providerID] = key
		}
	}
	if stream == nil {
		stream = &claudeTextStream{ParentToolUseID: parentID, TurnID: provider.currentTurnIDLocked()}
		provider.streams[key] = stream
	}
	if eventType != "content_block_delta" || stringValue(mapValue(event["delta"])["type"]) != "text_delta" {
		provider.mu.Unlock()
		return
	}
	delta := stringValue(mapValue(event["delta"])["text"])
	if delta == "" {
		provider.mu.Unlock()
		return
	}
	stream.Text.WriteString(delta)
	text := stream.Text.String()
	messageID := stream.MessageID
	turnID := stream.TurnID
	providerID := stream.ProviderID
	parentID = stream.ParentToolUseID
	provider.mu.Unlock()
	patch := map[string]any{
		"text": text, "streaming": true, "turnId": nilIfEmpty(turnID),
		"providerId": nilIfEmpty(providerID), "parentToolUseId": nilIfEmpty(parentID),
	}
	if messageID != "" {
		provider.session.patchMessage(messageID, patch)
		return
	}
	patch["kind"] = "assistant"
	created := provider.session.appendMessage(patch)
	if created == nil {
		return
	}
	provider.mu.Lock()
	if current := provider.streams[key]; current == stream && current.MessageID == "" {
		current.MessageID = stringValue(created["id"])
	}
	provider.mu.Unlock()
}

func (provider *ClaudeProvider) finishTextStream(message map[string]any, text string) string {
	keys := []string{
		stringValue(mapValue(message["message"])["id"]),
		claudeStreamKey(message, nil),
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	for _, candidate := range keys {
		if candidate == "" {
			continue
		}
		key := candidate
		if alias := provider.streamAliases[key]; alias != "" {
			key = alias
		}
		stream := provider.streams[key]
		if stream == nil {
			continue
		}
		delete(provider.streams, key)
		for alias, target := range provider.streamAliases {
			if target == key {
				delete(provider.streamAliases, alias)
			}
		}
		if text == "" {
			text = stream.Text.String()
		}
		return stream.MessageID
	}
	return ""
}

func (provider *ClaudeProvider) applyAssistantMessage(message map[string]any, turnID string) {
	content := sliceValue(mapValue(message["message"])["content"])
	text := strings.TrimSpace(textFromClaudeContent(content))
	parentID := stringValue(message["parent_tool_use_id"])
	providerID := stringValue(mapValue(message["message"])["id"])
	streamMessageID := provider.finishTextStream(message, text)
	if text != "" || streamMessageID != "" {
		patch := map[string]any{
			"kind": "assistant", "text": text, "raw": message, "streaming": false,
			"turnId": nilIfEmpty(turnID), "providerId": nilIfEmpty(providerID),
			"parentToolUseId": nilIfEmpty(parentID), "completedAtMs": millis(),
		}
		if streamMessageID != "" {
			delete(patch, "kind")
			provider.session.patchMessage(streamMessageID, patch)
		} else {
			provider.session.appendMessage(patch)
		}
	}
	for _, blockValue := range content {
		block := mapValue(blockValue)
		switch stringValue(block["type"]) {
		case "thinking":
			thinking := firstNonEmpty(stringValue(block["thinking"]), stringValue(block["text"]))
			if strings.TrimSpace(thinking) != "" {
				provider.session.appendMessage(map[string]any{
					"kind": "reasoning", "text": thinking, "turnId": nilIfEmpty(turnID),
					"parentToolUseId": nilIfEmpty(parentID),
				})
			}
		case "tool_use":
			name := firstNonEmpty(stringValue(block["name"]), "tool")
			if name == "AskUserQuestion" {
				continue
			}
			input := mapValue(block["input"])
			toolUseID := stringValue(block["id"])
			provider.session.appendMessage(map[string]any{
				"kind": "tool", "name": name, "summary": summarizeToolInput(input), "input": input,
				"toolUseId": toolUseID, "providerId": toolUseID, "turnId": nilIfEmpty(turnID),
				"parentToolUseId": nilIfEmpty(parentID), "startedAtMs": millis(),
			})
			provider.handleTaskToolCall(turnID, name, toolUseID, input)
		}
	}
}

func (provider *ClaudeProvider) applyToolResults(message map[string]any, turnID string) {
	parentID := stringValue(message["parent_tool_use_id"])
	toolUseResult := message["tool_use_result"]
	for _, blockValue := range sliceValue(mapValue(message["message"])["content"]) {
		block := mapValue(blockValue)
		if stringValue(block["type"]) != "tool_result" {
			continue
		}
		toolUseID := stringValue(block["tool_use_id"])
		text := strings.TrimSpace(textFromClaudeContent([]any{block}))
		provider.session.appendMessage(map[string]any{
			"kind": "tool-result", "toolUseId": toolUseID, "text": text,
			"isError": boolValue(block["is_error"]), "turnId": nilIfEmpty(turnID),
			"parentToolUseId": nilIfEmpty(parentID), "completedAtMs": millis(),
		})
		provider.handleTaskToolResult(turnID, toolUseID, toolUseResult, text)
	}
}
