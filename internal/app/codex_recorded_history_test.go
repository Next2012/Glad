package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexRecordedHistoryRestoresCommentaryAndToolsWithoutDuplicatingSummaries(t *testing.T) {
	item := func(turn string, value map[string]any) map[string]any {
		return planRecord("event_msg", map[string]any{"type": "item_completed", "thread_id": "root", "turn_id": turn, "item": value})
	}
	text := func(value string) []any { return []any{map[string]any{"type": "text", "text": value}} }
	path := writePlanRollout(t, "root",
		item("turn", map[string]any{"id": "user", "type": "UserMessage", "content": text("question")}),
		item("turn", map[string]any{"id": "commentary", "type": "AgentMessage", "content": text("Checking the workspace"), "phase": "commentary"}),
		item("turn", map[string]any{"id": "command", "type": "CommandExecution", "command": []any{"pwd"}, "cwd": "/workspace", "status": "completed", "aggregated_output": "/workspace", "exit_code": 0}),
		item("turn", map[string]any{"id": "answer", "type": "AgentMessage", "content": text("old answer"), "phase": "final_answer"}),
		item("rolled-back", map[string]any{"id": "removed", "type": "AgentMessage", "content": text("must not return")}),
	)
	turns := []any{map[string]any{"id": "turn", "status": "completed", "createdAt": 1700000000, "itemsView": "summary", "items": []any{
		map[string]any{"id": "user", "type": "userMessage", "content": text("question")},
		map[string]any{"id": "answer", "type": "agentMessage", "text": "latest answer"},
	}}}
	restored, err := supplementCodexRecordedHistory(context.Background(), path, "root", turns)
	if err != nil {
		t.Fatal(err)
	}
	items := sliceValue(mapValue(restored[0])["items"])
	if len(items) != 4 || mapValue(items[1])["id"] != "commentary" || mapValue(items[2])["id"] != "command" || mapValue(items[3])["text"] != "latest answer" {
		t.Fatalf("history lost its order or authoritative answer: %#v", items)
	}
	messages, err := buildCodexHistoryMessages(context.Background(), "root", restored)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 6 || messages[2]["text"] != "Checking the workspace" || messages[3]["name"] != "CodexBash" || messages[3]["command"] != "pwd" || messages[3]["result"] != "/workspace" {
		t.Fatalf("missing normalized history: %#v", messages)
	}
	// Already complete API histories keep their items exactly once.
	again, err := supplementCodexRecordedHistory(context.Background(), path, "root", restored)
	if err != nil || len(sliceValue(mapValue(again[0])["items"])) != 4 {
		t.Fatal("completed items duplicated", err)
	}
	if _, err := supplementCodexRecordedHistory(context.Background(), path, "foreign", turns); err == nil {
		t.Fatal("foreign transcript was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := supplementCodexRecordedHistory(ctx, path, "root", turns); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was ignored", err)
	}
}

func TestCodexRecordedHistorySkipsOversizedRecordsAndPreservesFollowingItems(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	input := `{"type":"session_meta","payload":{"id":"root"}}` + "\n" + strings.Repeat("x", (8<<20)+100) + "\n" +
		`{"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"AgentMessage","id":"commentary","content":[{"type":"text","text":"Still readable"}]}}}` + "\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	turns := []any{map[string]any{"id": "turn", "status": "completed", "items": []any{}}}
	restored, err := supplementCodexRecordedHistory(context.Background(), path, "root", turns)
	if err != nil || len(sliceValue(mapValue(restored[0])["items"])) != 1 {
		t.Fatal("oversized record poisoned history", err)
	}
}

func TestCodexRecordedHistoryKeepsAPIOrderWhenParallelItemsCompleteInReverse(t *testing.T) {
	item := func(id string) map[string]any {
		return planRecord("event_msg", map[string]any{"type": "item_completed", "turn_id": "turn", "item": map[string]any{"id": id, "type": "CommandExecution", "command": []any{id}, "aggregated_output": "recorded " + id}})
	}
	path := writePlanRollout(t, "root", item("B"), item("A"))
	turns := []any{map[string]any{"id": "turn", "status": "completed", "items": []any{
		map[string]any{"id": "A", "type": "commandExecution", "command": "API A"},
		map[string]any{"id": "B", "type": "commandExecution", "command": "API B"},
	}}}
	restored, err := supplementCodexRecordedHistory(context.Background(), path, "root", turns)
	if err != nil {
		t.Fatal(err)
	}
	items := sliceValue(mapValue(restored[0])["items"])
	if len(items) != 2 || mapValue(items[0])["id"] != "A" || mapValue(items[1])["id"] != "B" || mapValue(items[0])["aggregatedOutput"] != "recorded A" || mapValue(items[1])["aggregatedOutput"] != "recorded B" {
		t.Fatalf("parallel completions duplicated or reordered API items: %#v", items)
	}
}
