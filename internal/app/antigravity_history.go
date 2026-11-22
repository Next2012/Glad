package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

func newAntigravityReplay(id string) *antigravityReplay {
	return &antigravityReplay{sessionID: id, streams: map[string]*antigravityStream{}, tools: map[string]map[string]any{}, updated: time.Now()}
}

// Native load emits replay notifications before, and in some releases shortly
// after, its response. These records never pass through live Session reducers.
func (p *AntigravityProvider) waitReplay(ctx context.Context, generation uint64) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			p.mu.Lock()
			valid := p.generation == generation && p.cmd != nil
			quiet := p.replay != nil && time.Since(p.replay.updated) >= 200*time.Millisecond
			p.mu.Unlock()
			if !valid {
				return errors.New("Antigravity ACP disconnected during history replay")
			}
			if quiet {
				return nil
			}
		}
	}
}
func (p *AntigravityProvider) reduceReplayLocked(update map[string]any) {
	replay := p.replay
	if replay == nil {
		return
	}
	kind := stringValue(update["sessionUpdate"])
	switch kind {
	case "session_info_update":
		replay.title = stringValue(update["title"])
		return
	case "available_commands_update":
		replay.commands = mapsFromAny(update["availableCommands"])
		return
	case "config_option_update":
		replay.configOptions = mapsFromAny(update["configOptions"])
		return
	case "current_mode_update":
		replay.modes = map[string]any{"currentModeId": update["currentModeId"]}
		return
	case "agent_message_chunk", "agent_thought_chunk", "user_message_chunk":
		text := antigravityContentText(update["content"])
		if text == "" {
			return
		}
		messageKind := "assistant"
		if kind == "agent_thought_chunk" {
			messageKind = "reasoning"
		}
		if kind == "user_message_chunk" {
			messageKind = "user"
		}
		key := kind + ":" + stringValue(update["messageId"])
		if messageKind == "user" && (replay.streams[key] == nil || stringValue(update["messageId"]) == "") {
			if replay.turnID != "" {
				replay.messages = append(replay.messages, antigravityReplayMessage(replay, map[string]any{"kind": "turn-end", "status": "completed", "turnStatus": "completed"}))
			}
			replay.turnID = "agy-history-turn-" + antigravityHistoryHash(replay.sessionID+":"+fmt.Sprint(len(replay.messages))+":"+stringValue(update["messageId"]))
			replay.streams = map[string]*antigravityStream{}
			replay.messages = append(replay.messages, antigravityReplayMessage(replay, map[string]any{"kind": "turn-start"}))
		}
		stream := replay.streams[key]
		if stream == nil {
			stream = &antigravityStream{id: "agy-history-message-" + antigravityHistoryHash(replay.sessionID+":"+replay.turnID+":"+key)}
			replay.streams[key] = stream
			replay.messages = append(replay.messages, antigravityReplayMessage(replay, map[string]any{"id": stream.id, "kind": messageKind, "text": "", "streaming": false}))
		}
		if stream.text.Len() < 8<<20 {
			remaining := (8 << 20) - stream.text.Len()
			if len(text) > remaining {
				text = text[:remaining]
			}
			stream.text.WriteString(text)
		}
		for _, message := range replay.messages {
			if message["id"] == stream.id {
				message["text"] = stream.text.String()
				break
			}
		}
	case "tool_call", "tool_call_update":
		id := stringValue(update["toolCallId"])
		if id == "" {
			return
		}
		tool := replay.tools[id]
		if tool == nil {
			tool = antigravityReplayMessage(replay, map[string]any{"kind": "tool", "providerId": id, "toolUseId": id, "status": "completed", "streaming": false})
			replay.tools[id] = tool
			replay.messages = append(replay.messages, tool)
		}
		for _, key := range []string{"title", "name", "status", "rawInput", "rawOutput", "content", "locations"} {
			if value, ok := update[key]; ok {
				budget := 8 << 20
				tool[key] = antigravityBoundValue(value, &budget)
			}
		}
		budget := 8 << 20
		for _, key := range []string{"rawInput", "rawOutput", "content", "locations"} {
			if value, ok := tool[key]; ok {
				tool[key] = antigravityBoundValue(value, &budget)
			}
		}
		tool["toolName"] = firstNonEmpty(stringValue(tool["name"]), stringValue(tool["title"]), "Tool")
		tool["toolStatus"] = tool["status"]
		tool["input"] = tool["rawInput"]
		tool["output"] = tool["rawOutput"]
		tool["text"] = antigravityToolText(tool)
	case "plan":
		replay.messages = append(replay.messages, antigravityReplayMessage(replay, map[string]any{"kind": "task-plan", "plan": antigravityPlanEntries(update["entries"]), "steps": antigravityPlanEntries(update["entries"]), "planTurnStatus": "completed"}))
	}
	// Keep a bounded normalized history; the original remains owned by agy.
	if len(replay.messages) > 10000 {
		replay.messages = replay.messages[len(replay.messages)-10000:]
	}
}
func antigravityReplayMessage(replay *antigravityReplay, message map[string]any) map[string]any {
	if message["id"] == nil {
		message["id"] = "agy-history-" + antigravityHistoryHash(replay.sessionID+":"+replay.turnID+":"+fmt.Sprint(len(replay.messages))+":"+stringValue(message["kind"]))
	}
	message["threadId"] = replay.sessionID
	message["turnId"] = replay.turnID
	message["isRootTurn"] = true
	message["createdAt"] = nil
	message["timeSource"] = "unknown"
	message["replayed"] = true
	return message
}
func antigravityFinishReplay(replay *antigravityReplay) []map[string]any {
	messages := replay.messages
	if replay.turnID != "" {
		messages = append(messages, antigravityReplayMessage(replay, map[string]any{"kind": "turn-end", "status": "completed", "turnStatus": "completed"}))
	}
	return messages
}
func (p *AntigravityProvider) Resume(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 256 || strings.ContainsAny(id, "\r\n\x00") {
		return errors.New("invalid Antigravity session id")
	}
	p.opMu.Lock()
	defer p.opMu.Unlock()
	if err := p.start(ctx); err != nil {
		return err
	}
	p.mu.Lock()
	if p.closed || p.turnID != "" || p.switching || len(p.permissions) > 0 || len(p.questions) > 0 {
		p.mu.Unlock()
		return errors.New("Antigravity conversation can only be resumed while idle")
	}
	if !boolValue(p.capabilities["loadSession"]) {
		p.mu.Unlock()
		return errors.New("Antigravity ACP does not support history loading")
	}
	resumeCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	p.switchCancel = cancel
	p.switching = true
	p.replay = newAntigravityReplay(id)
	generation := p.generation
	p.publishStateLocked()
	p.mu.Unlock()
	params, err := p.openParams(id)
	var response map[string]any
	if err == nil {
		response, err = p.rpc(resumeCtx, "session/load", params)
	}
	if err == nil {
		err = p.waitReplay(resumeCtx, generation)
	}
	p.mu.Lock()
	replay := p.replay
	p.replay = nil
	p.switching = false
	p.switchCancel = nil
	if err == nil && (p.closed || p.generation != generation || replay == nil) {
		err = errors.New("Antigravity session changed during resume")
	}
	if err == nil {
		p.nativeID = firstNonEmpty(stringValue(response["sessionId"]), id)
		p.streams = map[string]*antigravityStream{}
		p.tools = map[string]map[string]any{}
		p.usage = map[string]any{}
		p.applyOpenLocked(response)
		if replay.commands != nil {
			p.commands = replay.commands
		}
		if len(replay.configOptions) > 0 {
			p.configOptions = replay.configOptions
		}
		if len(replay.modes) > 0 {
			p.modes = replay.modes
		}
		if !p.session.replaceMessages(p.finishReplayWithTimesLocked(replay)) {
			err = errors.New("Antigravity session is closed")
		}
	}
	p.publishStateLocked()
	if err == nil && replay.title != "" {
		p.session.setAutomaticName(replay.title)
	}
	p.mu.Unlock()
	// A failed load can have mutated the native process before reporting failure.
	// Restore the old native identity on the next input; keep the old UI history.
	if err != nil {
		p.recycle(generation)
	}
	return err
}
func (p *AntigravityProvider) listSessions(ctx context.Context, cursor string, allDirectories bool) ([]map[string]any, string, error) {
	if err := p.Start(ctx); err != nil {
		return nil, "", err
	}
	p.mu.Lock()
	supported := mapValue(p.capabilities["sessionCapabilities"])["list"] != nil
	p.mu.Unlock()
	if !supported {
		return nil, "", errors.New("Antigravity ACP does not advertise session listing")
	}
	params := map[string]any{}
	if !allDirectories {
		params["cwd"] = p.session.WorkingDirectory
	}
	if cursor != "" {
		params["cursor"] = cursor
	}
	result, err := p.rpc(ctx, "session/list", params)
	if err != nil {
		return nil, "", err
	}
	items := []map[string]any{}
	for _, entry := range mapsFromAny(firstNonNil(result["sessions"], result["items"])) {
		item := cloneMap(entry)
		item["id"] = firstNonEmpty(stringValue(entry["sessionId"]), stringValue(entry["id"]))
		item["name"] = entry["title"]
		items = append(items, item)
	}
	return items, stringValue(result["nextCursor"]), nil
}
func (p *AntigravityProvider) preview(ctx context.Context, id string) ([]map[string]any, error) {
	// A separate native process isolates session/load's active-conversation side
	// effect from the live process, even while the live turn is running.
	p.mu.Lock()
	options := cloneMap(p.options)
	environment := append([]string(nil), p.session.environment...)
	p.mu.Unlock()
	delete(options, "resume")
	delete(options, "model")
	delete(options, "effort")
	delete(options, "mode")
	session := newSession(newUUID(), "Antigravity preview", "antigravity-structured", p.session.Tool, p.session.WorkingDirectory)
	session.environment = environment
	probe := NewAntigravityProvider(session, options)
	session.Provider = probe
	defer session.cancel()
	defer probe.Close(context.Background())
	if err := probe.Start(ctx); err != nil {
		return nil, err
	}
	if err := probe.Resume(ctx, id); err != nil {
		return nil, err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	preview := []map[string]any{}
	for _, message := range session.Messages {
		if message["kind"] != "user" && message["kind"] != "assistant" {
			continue
		}
		text := stringValue(message["text"])
		if len(text) > 1200 {
			runes := []rune(text)
			text = string(runes[:min(len(runes), 1200)])
		}
		preview = append(preview, map[string]any{"kind": message["kind"], "text": text, "createdAt": message["createdAt"], "completedAtMs": message["completedAtMs"], "timeSource": message["timeSource"], "replayed": true})
		if len(preview) > 6 {
			preview = preview[len(preview)-6:]
		}
	}
	return preview, nil
}
func antigravityHistoryHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:16])
}
