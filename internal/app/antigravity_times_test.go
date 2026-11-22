package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAntigravityNativeTranscriptRestoresCreatedTimeWithoutInventingCompletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "transcript_full.jsonl")
	steps := []map[string]any{
		{"type": "USER_INPUT", "created_at": "2026-11-20T01:02:03Z", "content": "<USER_REQUEST>\ninspect\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2031-01-01T00:00:00Z\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>example</USER_SETTINGS_CHANGE>"},
		{"type": "PLANNER_RESPONSE", "created_at": "2026-11-20T01:02:05Z", "content": "First ", "thinking": "Check "},
		{"type": "PLANNER_RESPONSE", "created_at": "2026-11-20T01:02:08Z", "content": "second.", "thinking": "again."},
		{"type": "USER_INPUT", "created_at": "2026-11-20T01:03:00Z", "content": "repeat"},
		{"type": "PLANNER_RESPONSE", "created_at": "2026-11-20T01:03:05Z", "content": "OK"},
		{"type": "USER_INPUT", "created_at": "2026-11-20T01:04:00Z", "content": "repeat"},
		{"type": "PLANNER_RESPONSE", "created_at": "2026-11-20T01:04:05Z", "content": "OK"},
		{"type": "USER_INPUT", "created_at": "invalid", "content": "invalid-time"},
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		data, _ := json.Marshal(step)
		if _, err := file.Write(append(data, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	file.Close()
	fakeModified := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, fakeModified, fakeModified); err != nil {
		t.Fatal(err)
	}
	replay := newAntigravityReplay("native")
	messages := []map[string]any{}
	for _, item := range []struct{ kind, text string }{{"user", "inspect"}, {"assistant", "First second."}, {"reasoning", "Check again."}, {"user", "repeat"}, {"assistant", "OK"}, {"user", "repeat"}, {"assistant", "OK"}, {"user", "invalid-time"}} {
		messages = append(messages, antigravityReplayMessage(replay, map[string]any{"kind": item.kind, "text": item.text}))
	}
	antigravityRestoreMessageTimes(messages, antigravityReadTranscriptTimes(path))
	for index, want := range map[int]string{0: "2026-11-20T01:02:03Z", 1: "2026-11-20T01:02:05Z", 2: "2026-11-20T01:02:05Z"} {
		parsed, _ := time.Parse(time.RFC3339, want)
		if numberInt64(messages[index]["createdAt"]) != parsed.UnixMilli() || messages[index]["timeSource"] != "native" {
			t.Fatalf("wrong native timestamp: %#v", messages[index])
		}
		if numberInt64(messages[index]["completedAtMs"]) != 0 {
			t.Fatal("native creation time became completion time")
		}
	}
	for _, message := range messages[3:] {
		if message["createdAt"] != nil || message["timeSource"] != "unknown" {
			t.Fatalf("ambiguous or invalid time guessed: %#v", message)
		}
	}
}

func TestAntigravityHistoryWithoutNativeTranscriptKeepsUnknownTime(t *testing.T) {
	replay := newAntigravityReplay("no-native-record")
	message := antigravityReplayMessage(replay, map[string]any{"kind": "assistant", "text": "history"})
	antigravityRestoreMessageTimes([]map[string]any{message}, antigravityReadTranscriptTimes(filepath.Join(t.TempDir(), "missing")))
	if message["createdAt"] != nil || message["completedAtMs"] != nil || message["timeSource"] != "unknown" {
		t.Fatalf("replay invented resume time: %#v", message)
	}
	for _, id := range []string{"", ".", "..", "../outside", "nested/session", `nested\session`} {
		if antigravityNativeTranscriptPath(id) != "" {
			t.Fatalf("unsafe native identity accepted: %q", id)
		}
	}
	large := filepath.Join(t.TempDir(), "too-large")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(antigravityTranscriptTimeLimit + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if len(antigravityReadTranscriptTimes(large)) != 0 {
		t.Fatal("oversized native transcript was read")
	}
}

func TestAntigravityLiveCompletionTimeAndContextSurviveReconnectAndSameProcessResume(t *testing.T) {
	p := antigravityFixture(t)
	antigravitySend(t, p, "agy-long")
	antigravityWait(t, time.Second, func() bool {
		for _, message := range antigravityMessages(p) {
			if message["kind"] == "assistant" && strings.Contains(stringValue(message["text"]), "working before steering") {
				return true
			}
		}
		return false
	})
	var firstUserTime int64
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "user" {
			firstUserTime = numberInt64(message["createdAt"])
		}
		if message["kind"] == "assistant" && numberInt64(message["completedAtMs"]) != 0 {
			t.Fatal("running reply already had completion time")
		}
	}
	if firstUserTime <= 0 {
		t.Fatal("live user has no creation time")
	}
	p.mu.Lock()
	turn, native := p.turnID, p.nativeID
	p.mu.Unlock()
	if err := p.Steer(context.Background(), ProviderInput{Text: "add timing instruction", AgentText: "add timing instruction", ClientMessageID: newUUID()}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	before := map[string]int64{}
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "assistant" {
			value := numberInt64(message["completedAtMs"])
			if value <= 0 || value < numberInt64(message["createdAt"]) {
				t.Fatalf("missing final reply time: %#v", message)
			}
			before[stringValue(message["text"])] = value
		}
		if message["kind"] == "turn-end" {
			ctx := mapValue(message["context"])
			if numberFloat(ctx["contextWindow"]) != 100000 || numberFloat(ctx["usedTokens"]) != 1200 {
				t.Fatalf("missing turn context snapshot: %#v", ctx)
			}
		}
	}
	p.mu.Lock()
	p.completeStreamsLocked()
	p.mu.Unlock()
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "assistant" && before[stringValue(message["text"])] != numberInt64(message["completedAtMs"]) {
			t.Fatal("repeated close moved completion timestamp")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := p.Resume(ctx, native); err != nil {
		t.Fatal(err)
	}
	for _, message := range antigravityMessages(p) {
		if message["kind"] == "assistant" && before[stringValue(message["text"])] != numberInt64(message["completedAtMs"]) {
			t.Fatalf("same-process resume lost observed completion: %#v", message)
		}
	}
}

func TestAntigravityTranscriptUserEnvelopeRequiresVerifiedBoundaries(t *testing.T) {
	for _, text := range []string{"plain", "<USER_REQUEST>\nplain\n</USER_REQUEST>", "<USER_REQUEST>\nplain\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nincomplete"} {
		if antigravityTranscriptUserText(text) != text {
			t.Fatalf("unverified wrapper stripped: %q", text)
		}
	}
}
