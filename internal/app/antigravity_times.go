package app

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const antigravityTranscriptTimeLimit = 32 << 20

// Native ACP v1 omits message timestamps. The CLI's human-readable transcript
// records created_at, but no completion timestamp. Read that field only; file
// modification times and resume time never stand in for message time.
func antigravityNativeTranscriptPath(nativeID string) string {
	if nativeID == "" || nativeID == "." || nativeID == ".." || strings.ContainsAny(nativeID, "/\\\x00") || len(nativeID) > 256 {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini", "antigravity-cli", "brain", nativeID, ".system_generated", "logs", "transcript_full.jsonl")
}

type antigravityTranscriptStep struct {
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
	Content   string `json:"content"`
	Thinking  string `json:"thinking"`
}

func antigravityMessageTimeKey(message map[string]any) string {
	kind, text := stringValue(message["kind"]), stringValue(message["text"])
	if text == "" || (kind != "user" && kind != "assistant" && kind != "reasoning") {
		return ""
	}
	return antigravityHistoryHash(kind + "\x00" + text)
}

// Native transcripts wrap some user requests with CLI metadata. Only unwrap the
// observed complete envelope; its metadata clock is never used as a timestamp.
func antigravityTranscriptUserText(content string) string {
	const start = "<USER_REQUEST>\n"
	const end = "\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n"
	if strings.HasPrefix(content, start) {
		if index := strings.LastIndex(content, end); index >= len(start) && strings.Contains(content[index+len(end):], "\n</ADDITIONAL_METADATA>") {
			return content[len(start):index]
		}
	}
	return content
}

func antigravityReadTranscriptTimes(path string) []map[string]any {
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > antigravityTranscriptTimeLimit {
		return nil
	}
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 4096), 16<<20)
	messages := []map[string]any{}
	var assistant, reasoning strings.Builder
	var assistantTime, reasoningTime int64
	flush := func() {
		for _, item := range []struct {
			kind, text string
			timestamp  int64
		}{
			{"assistant", assistant.String(), assistantTime}, {"reasoning", reasoning.String(), reasoningTime},
		} {
			if item.text != "" {
				messages = append(messages, map[string]any{"kind": item.kind, "text": item.text, "createdAt": item.timestamp, "timeSource": "native"})
			}
		}
		assistant.Reset()
		reasoning.Reset()
		assistantTime = 0
		reasoningTime = 0
	}
	for scan.Scan() {
		var step antigravityTranscriptStep
		if json.Unmarshal(scan.Bytes(), &step) != nil {
			return nil
		}
		createdAt := int64(0)
		if parsed, err := time.Parse(time.RFC3339Nano, step.CreatedAt); err == nil && parsed.UnixMilli() > 0 {
			createdAt = parsed.UnixMilli()
		}
		switch step.Type {
		case "USER_INPUT":
			flush()
			if step.Content != "" {
				messages = append(messages, map[string]any{"kind": "user", "text": antigravityTranscriptUserText(step.Content), "createdAt": createdAt, "timeSource": "native"})
			}
		case "PLANNER_RESPONSE":
			if step.Content != "" {
				if assistant.Len() == 0 {
					assistantTime = createdAt
				}
				assistant.WriteString(step.Content)
			}
			if step.Thinking != "" {
				if reasoning.Len() == 0 {
					reasoningTime = createdAt
				}
				reasoning.WriteString(step.Thinking)
			}
		}
	}
	if scan.Err() != nil {
		return nil
	}
	flush()
	return messages
}

// Repeated identical text is ambiguous without native message IDs. Restore only
// unique exact content matches; an unknown timestamp is preferable to a wrong
// date on a different occurrence. Text bodies are never persisted by Glad.
func antigravityRestoreMessageTimes(messages, candidates []map[string]any) {
	indexed := map[string][]map[string]any{}
	counts := map[string]int{}
	for _, message := range candidates {
		if key := antigravityMessageTimeKey(message); key != "" {
			indexed[key] = append(indexed[key], message)
		}
	}
	for _, message := range messages {
		if key := antigravityMessageTimeKey(message); key != "" {
			counts[key]++
		}
	}
	for _, message := range messages {
		key := antigravityMessageTimeKey(message)
		if key == "" || counts[key] != 1 || len(indexed[key]) != 1 {
			continue
		}
		candidate := indexed[key][0]
		if createdAt := numberInt64(candidate["createdAt"]); createdAt > 0 {
			message["createdAt"] = createdAt
			message["timeSource"] = candidate["timeSource"]
		}
		if completed := numberInt64(candidate["completedAtMs"]); completed > 0 {
			message["completedAtMs"] = completed
		}
	}
}

func (p *AntigravityProvider) finishReplayWithTimesLocked(replay *antigravityReplay) []map[string]any {
	messages := antigravityFinishReplay(replay)
	antigravityRestoreMessageTimes(messages, antigravityReadTranscriptTimes(antigravityNativeTranscriptPath(replay.sessionID)))
	// A same-process resume can additionally retain Glad's accurately observed
	// completion time. After daemon restart, native created_at remains available.
	p.session.mu.RLock()
	observed := []map[string]any{}
	for _, message := range p.session.Messages {
		if stringValue(message["threadId"]) == replay.sessionID && stringValue(message["timeSource"]) == "observed" {
			observed = append(observed, cloneMap(message))
		}
	}
	p.session.mu.RUnlock()
	antigravityRestoreMessageTimes(messages, observed)
	return messages
}
