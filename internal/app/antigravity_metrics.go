package app

import (
	"encoding/json"
	"math"
	"strconv"
)

// Native agy 1.5.14 returns a usage snapshot for the active root turn. Steering
// acknowledges earlier prompts without usage; the final response covers all model
// calls in that root turn. Replace snapshots, never sum overlapping responses.
// outputTokens includes thoughtTokens; usage_update.used is context occupancy.
// Verified with sequential turns and concurrent steering against the native CLI.
func (p *AntigravityProvider) metricSettingLocked(id string) string {
	for _, option := range p.configOptions {
		if stringValue(option["id"]) == id {
			return stringValue(option["currentValue"])
		}
	}
	if id == "thought_level" {
		id = "effort"
	}
	return stringValue(p.options[id])
}

func antigravityTokenCount(value any) (*int64, bool) {
	var n float64
	switch value := value.(type) {
	case float64:
		n = value
	case json.Number:
		count, err := value.Int64()
		if err != nil || count < 0 {
			return nil, false
		}
		return &count, true
	case int64:
		if value < 0 {
			return nil, false
		}
		return &value, true
	case int:
		count := int64(value)
		if count < 0 {
			return nil, false
		}
		return &count, true
	default:
		return nil, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n >= math.MaxInt64 || math.Trunc(n) != n {
		return nil, false
	}
	count := int64(n)
	return &count, true
}

func (tracker *SpeedTracker) antigravityUsage(usage map[string]any) {
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	run := tracker.run
	if run == nil || len(usage) == 0 {
		return
	}
	// Reject accounting whose explicitly reported total disagrees with its
	// components (for example a future provider changes cache token semantics).
	// Output remains useful for speed; partial spend is never shown as complete.
	if total, haveTotal := antigravityTokenCount(usage["totalTokens"]); haveTotal {
		input, haveInput := antigravityTokenCount(usage["inputTokens"])
		output, haveOutput := antigravityTokenCount(usage["outputTokens"])
		read, haveRead := antigravityTokenCount(usage["cachedReadTokens"])
		write, haveWrite := antigravityTokenCount(usage["cachedWriteTokens"])
		if haveInput && haveOutput && haveRead && haveWrite && *input+*output+*read+*write != *total {
			usage = cloneMap(usage)
			delete(usage, "inputTokens")
			delete(usage, "cachedReadTokens")
			delete(usage, "cachedWriteTokens")
		}
	}
	for key, field := range map[string]**int64{
		"inputTokens": &run.sample.InputTokens, "cachedReadTokens": &run.sample.CachedInputTokens,
		"cachedWriteTokens": &run.sample.CacheWriteTokens, "thoughtTokens": &run.sample.ThoughtTokens,
	} {
		count, _ := antigravityTokenCount(usage[key])
		*field = count
	}
	count, valid := antigravityTokenCount(usage["outputTokens"])
	run.known = valid
	if valid {
		run.tokens = *count
	} else {
		run.tokens = 0
	}
}

func (tracker *SpeedTracker) antigravityUpdate(update map[string]any) {
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	run := tracker.run
	if run == nil {
		return
	}
	switch stringValue(update["sessionUpdate"]) {
	case "agent_message_chunk", "agent_thought_chunk":
		if antigravityContentText(update["content"]) == "" {
			return
		}
		key := stringValue(update["sessionUpdate"]) + ":" + stringValue(update["messageId"]) + ":" + strconv.Itoa(run.antigravitySegment)
		reply := run.replies[key]
		if reply == nil {
			reply = &speedReply{first: run.elapsed()}
			run.replies[key] = reply
		}
		reply.last = run.elapsed()
	case "tool_call", "tool_call_update":
		id := stringValue(update["toolCallId"])
		if id == "" {
			return
		}
		if run.antigravityDaemons == nil {
			run.antigravityDaemons = map[string]bool{}
		}
		if boolValue(mapValue(update["rawInput"])["IsDaemon"]) {
			run.antigravityDaemons[id] = true
		}
		if run.antigravityDaemons[id] {
			return
		}
		switch stringValue(update["status"]) {
		case "pending", "in_progress":
			if _, blocked := run.blocks["tool:"+id]; !blocked {
				run.antigravitySegment++
			}
			run.block("tool:"+id, true)
		case "completed", "failed":
			if _, blocked := run.blocks["tool:"+id]; blocked {
				run.antigravitySegment++
			}
			run.block("tool:"+id, false)
		}
	case "compaction_update":
		run.sample.Compacted = true
	}
}
