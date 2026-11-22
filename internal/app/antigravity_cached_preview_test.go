package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAntigravityCachedPreviewRequiresNativeDiscoveryAndLeavesLiveStateAlone(t *testing.T) {
	brain := t.TempDir()
	active := "11111111-1111-4111-8111-111111111111"
	other := "22222222-2222-4222-8222-222222222222"
	for _, id := range []string{active, other} {
		folder := filepath.Join(brain, id, ".system_generated", "logs")
		if err := os.MkdirAll(folder, 0700); err != nil {
			t.Fatal(err)
		}
		rows := []map[string]any{
			{"type": "USER_INPUT", "step_index": 1, "content": "<USER_REQUEST>\nCached user question\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nclock\n</ADDITIONAL_METADATA>"},
			{"type": "PLANNER_RESPONSE", "step_index": 2, "content": "Cached assistant answer", "thinking": "Cached thought"},
		}
		var data []byte
		for _, row := range rows {
			encoded, _ := json.Marshal(row)
			data = append(data, append(encoded, '\n')...)
		}
		if err := os.WriteFile(filepath.Join(folder, "transcript_full.jsonl"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	session := newSession("cached-preview", "Live conversation", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	defer session.cancel()
	p := NewAntigravityProvider(session, nil)
	p.ready, p.nativeID, p.generation = true, active, 7
	p.subagents = newAntigravitySubagentReader(brain)
	session.State["nativeConversationId"] = active
	session.Messages = []map[string]any{{"id": "untouched", "kind": "assistant", "text": "Live content"}}
	before, _ := json.Marshal(session.snapshot())
	if _, found, err := p.cachedPreview(context.Background(), other); err != nil || found {
		t.Fatalf("unlisted native ID was read: found=%v err=%v", found, err)
	}
	preview, found, err := p.cachedPreview(context.Background(), active)
	if err != nil || !found || preview["historySource"] != "native-log-tail" || !boolValue(preview["historyOnly"]) {
		t.Fatalf("active native cache unavailable: %#v %v", preview, err)
	}
	messages := preview["messages"].([]map[string]any)
	if len(messages) != 3 || messages[0]["text"] != "Cached user question" || messages[2]["text"] != "Cached assistant answer" {
		t.Fatalf("wrong cached messages: %#v", messages)
	}
	p.previewIDs = map[string]uint64{other: 7}
	if _, found, err := p.cachedPreview(context.Background(), other); err != nil || !found {
		t.Fatalf("authenticated listed ID unavailable: found=%v err=%v", found, err)
	}
	p.generation++
	if _, found, err := p.cachedPreview(context.Background(), other); err != nil || found {
		t.Fatalf("old process discovery still authorized cache: found=%v err=%v", found, err)
	}
	after, _ := json.Marshal(session.snapshot())
	if string(before) != string(after) {
		t.Fatal("read-only preview changed the live conversation")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := p.cachedPreview(cancelled, active); err == nil {
		t.Fatal("cancelled cache read did not stop")
	}
}

func TestAntigravityReplayIDsStayUniqueAfterHistoryWindowTrims(t *testing.T) {
	p := &AntigravityProvider{replay: newAntigravityReplay("large-native-history")}
	for i := 0; i < 3000; i++ {
		p.reduceReplayLocked(map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "Repeated question"}})
		p.reduceReplayLocked(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "First "}})
		p.reduceReplayLocked(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "and final fragment"}})
	}
	seen := map[string]bool{}
	for _, message := range antigravityFinishReplay(p.replay) {
		id := stringValue(message["id"])
		if id == "" || seen[id] {
			t.Fatalf("history cursor identity repeated after trimming: %q", id)
		}
		seen[id] = true
		if message["kind"] == "assistant" && message["text"] != "First and final fragment" {
			t.Fatal("replay fragments were attached to the wrong message")
		}
	}
	one, two := antigravityFinishReplay(p.replay), antigravityFinishReplay(p.replay)
	if one[len(one)-1]["id"] != two[len(two)-1]["id"] {
		t.Fatal("reading finished history changed its identity")
	}
}
