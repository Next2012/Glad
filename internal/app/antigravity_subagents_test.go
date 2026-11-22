package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const agyGraphRoot = "11111111-1111-4111-8111-111111111111"
const agyGraphChild = "22222222-2222-4222-8222-222222222222"
const agyGraphGrandchild = "33333333-3333-4333-8333-333333333333"
const agyGraphForeign = "44444444-4444-4444-8444-444444444444"

func agyGraphIndex(t *testing.T, brain, parent, child, state string) string {
	t.Helper()
	path := filepath.Join(brain, parent, ".system_generated", "subagents", child+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"conversationId": child, "state": state, "spawnStepIndex": 7, "subagentDescriptor": map[string]any{"typeName": "research", "role": "Inspect the native graph"}})
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func agyGraphTranscript(t *testing.T, brain, child string, count int) string {
	t.Helper()
	path := filepath.Join(brain, child, ".system_generated", "logs", "transcript_full.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for i := 0; i < count; i++ {
		body, _ := json.Marshal(map[string]any{"step_index": i, "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-11-22T01:02:03Z", "content": fmt.Sprintf("Native reply %d", i)})
		if _, err := file.Write(append(body, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	return path
}
func agyGraphReader(t *testing.T) (*antigravitySubagentReader, string) {
	t.Helper()
	brain := t.TempDir()
	agyGraphIndex(t, brain, agyGraphRoot, agyGraphChild, "SUBAGENT_STATE_ALIVE")
	agyGraphTranscript(t, brain, agyGraphChild, 120)
	return newAntigravitySubagentReader(brain), brain
}
func TestAntigravitySubagentOwnedGraphAndNativeStatus(t *testing.T) {
	reader, brain := agyGraphReader(t)
	agyGraphIndex(t, brain, agyGraphChild, agyGraphGrandchild, "SUBAGENT_STATE_IDLE")
	agyGraphTranscript(t, brain, agyGraphGrandchild, 2)
	agyGraphIndex(t, brain, agyGraphGrandchild, agyGraphRoot, "SUBAGENT_STATE_ALIVE")
	agyGraphTranscript(t, brain, agyGraphForeign, 1)
	items, _, _, err := reader.graph(context.Background(), agyGraphRoot, "root:1", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Activity != "unknown" || items[0].NativeStatus != "SUBAGENT_STATE_ALIVE" || items[1].Activity != "idle" || items[1].Depth != 2 || !items[0].HasTranscript || items[0].LastActivityAt <= 0 {
		t.Fatalf("invented activity or broken graph: %#v", items)
	}
	for _, id := range []string{agyGraphForeign, agyGraphRoot, "../outside", "not-a-uuid"} {
		if _, err := reader.page(context.Background(), agyGraphRoot, "root:1", id, "", 10); !errors.Is(err, errAgySubagentNotFound) {
			t.Fatalf("read unowned identity %q: %v", id, err)
		}
	}
	if err := os.Remove(filepath.Join(brain, agyGraphRoot, ".system_generated", "subagents", agyGraphChild+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.page(context.Background(), agyGraphRoot, "root:1", agyGraphGrandchild, "", 10); !errors.Is(err, errAgySubagentNotFound) {
		t.Fatalf("cached proof authorized removed edge: %v", err)
	}
}
func TestAntigravitySubagentBoundedPagesAppendAndEpoch(t *testing.T) {
	reader, brain := agyGraphReader(t)
	ctx := context.Background()
	first, err := reader.page(ctx, agyGraphRoot, "root:1", agyGraphChild, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 10 || !first.HasMore || first.NextBefore == "" || first.Messages[0]["text"] != "Native reply 110" {
		t.Fatalf("bad tail: %#v", first)
	}
	path := filepath.Join(brain, agyGraphChild, ".system_generated", "logs", "transcript_full.jsonl")
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	file.WriteString("{\"step_index\":120,\"type\":\"PLANNER_RESPONSE\",\"content\":\"Appended\"}\n")
	file.Close()
	previous, err := reader.page(ctx, agyGraphRoot, "root:1", agyGraphChild, first.NextBefore, 10)
	if err != nil {
		t.Fatal(err)
	}
	if previous.Messages[0]["text"] != "Native reply 100" || previous.Messages[9]["text"] != "Native reply 109" {
		t.Fatalf("append invalidated/duplicated older page: %#v", previous)
	}
	if _, err := reader.page(ctx, agyGraphRoot, "root:2", agyGraphChild, first.NextBefore, 10); !errors.Is(err, errAgySubagentChanged) {
		t.Fatalf("old epoch cursor accepted: %v", err)
	}
	fresh, _ := reader.page(ctx, agyGraphRoot, "root:2", agyGraphChild, "", 10)
	replacement := path + ".replacement"
	if err := os.WriteFile(replacement, []byte("{\"step_index\":0,\"type\":\"PLANNER_RESPONSE\",\"content\":\"Replacement\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.page(ctx, agyGraphRoot, "root:2", agyGraphChild, fresh.NextBefore, 10); !errors.Is(err, errAgySubagentChanged) {
		t.Fatalf("replaced file accepted old cursor: %v", err)
	}
}
func TestAntigravitySubagentRejectsSymlinkAndMismatchedMetadata(t *testing.T) {
	for _, kind := range []string{"metadata", "transcript", "directory"} {
		t.Run(kind, func(t *testing.T) {
			reader, brain := agyGraphReader(t)
			outside := t.TempDir()
			target := filepath.Join(outside, "secret")
			os.WriteFile(target, []byte("secret"), 0600)
			var path string
			switch kind {
			case "metadata":
				path = filepath.Join(brain, agyGraphRoot, ".system_generated", "subagents", agyGraphChild+".json")
			case "transcript":
				path = filepath.Join(brain, agyGraphChild, ".system_generated", "logs", "transcript_full.jsonl")
			case "directory":
				path = filepath.Join(brain, agyGraphChild, ".system_generated", "logs")
				target = outside
			}
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if _, err := reader.page(context.Background(), agyGraphRoot, "root:1", agyGraphChild, "", 10); !errors.Is(err, errAgySubagentNotFound) {
				t.Fatalf("followed %s symlink: %v", kind, err)
			}
		})
	}
	reader, brain := agyGraphReader(t)
	path := filepath.Join(brain, agyGraphRoot, ".system_generated", "subagents", agyGraphChild+".json")
	os.WriteFile(path, []byte(`{"conversationId":"44444444-4444-4444-8444-444444444444"}`), 0600)
	items, _, _, _ := reader.graph(context.Background(), agyGraphRoot, "root:1", true)
	if len(items) != 0 {
		t.Fatal("filename/native conversation mismatch authorized child")
	}
}
func TestAntigravitySubagentPartialTailAndOversizedRecords(t *testing.T) {
	reader, brain := agyGraphReader(t)
	path := agyGraphTranscript(t, brain, agyGraphChild, 1)
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	big, _ := json.Marshal(map[string]any{"step_index": 1, "type": "PLANNER_RESPONSE", "content": strings.Repeat("x", agySubagentRecordBytes+1)})
	file.Write(append(big, '\n'))
	file.WriteString("{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"content\":\"Recorded\",\"thinking\":\"Why\",\"tool_calls\":[{\"name\":\"read_file\",\"args\":{\"path\":\"a.txt\"}}]}\n{\"step_index\":3")
	file.Close()
	page, err := reader.page(context.Background(), agyGraphRoot, "root:1", agyGraphChild, "", 80)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Warnings) == 0 || len(page.Messages) != 4 {
		t.Fatalf("partial/oversized input not bounded visibly: %#v", page)
	}
	for _, message := range page.Messages {
		if message["threadId"] != agyGraphChild || message["isRootTurn"] != false || message["completedAtMs"] != nil {
			t.Fatalf("invented identity/completion: %#v", message)
		}
	}
	if page.Messages[3]["toolStatus"] != "recorded" || page.Messages[3]["providerId"] != nil {
		t.Fatal("invented native tool result association")
	}
}
func TestAntigravitySubagentCancellationAndHTTPAuthorization(t *testing.T) {
	reader, _ := agyGraphReader(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := reader.graph(ctx, agyGraphRoot, "root:1", false); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	reader.gate <- struct{}{}
	if _, _, _, err := reader.graph(ctx, agyGraphRoot, "root:1", false); !errors.Is(err, context.Canceled) {
		t.Fatal("waiting cache lock ignored cancellation")
	}
	<-reader.gate
	session := newSession("glad-parent", "native", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	defer session.cancel()
	provider := NewAntigravityProvider(session, nil)
	provider.nativeID = agyGraphRoot
	provider.generation = 1
	provider.subagents = reader
	session.Provider = provider
	server := &Server{sessions: &SessionManager{sessions: map[string]*Session{session.ID: session}}}
	mux := http.NewServeMux()
	server.registerAntigravityRoutes(mux)
	for _, test := range []struct {
		path   string
		status int
	}{{"/api/sessions/glad-parent/antigravity-subagents", 200}, {"/api/sessions/glad-parent/antigravity-subagents/" + agyGraphChild + "?limit=3", 200}, {"/api/sessions/glad-parent/antigravity-subagents/" + agyGraphForeign, 404}, {"/api/sessions/not-owned/antigravity-subagents/" + agyGraphChild, 404}} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if response.Code != test.status {
			t.Fatalf("%s: %d %s", test.path, response.Code, response.Body.String())
		}
	}
}

func TestAntigravitySubagentRefusesBrainSymlinkAndBoundsGraph(t *testing.T) {
	reader, brain := agyGraphReader(t)
	alias := filepath.Join(t.TempDir(), "brain")
	if err := os.Symlink(brain, alias); err == nil {
		linked := newAntigravitySubagentReader(alias)
		if _, _, _, err := linked.graph(context.Background(), agyGraphRoot, "root:1", false); !errors.Is(err, errAgySubagentNotFound) {
			t.Fatalf("followed native brain alias: %v", err)
		}
	}
	for i := 0; i < agySubagentGraphLimit+10; i++ {
		id := fmt.Sprintf("99999999-9999-4999-8999-%012x", i)
		agyGraphIndex(t, brain, agyGraphRoot, id, "SUBAGENT_STATE_ALIVE")
	}
	items, warnings, _, err := reader.graph(context.Background(), agyGraphRoot, "root:1", true)
	if err != nil || len(items) > agySubagentGraphLimit || len(warnings) == 0 {
		t.Fatalf("unbounded graph: %d %v %v", len(items), warnings, err)
	}
}

func TestAntigravitySubagentShortRecordsRetainOnlyRequestedTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tiny-records.jsonl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	offsets := make([]int64, 10000)
	var offset int64
	for i := range offsets {
		offsets[i] = offset
		line, _ := json.Marshal(map[string]any{"step_index": i, "type": "PLANNER_RESPONSE", "content": fmt.Sprintf("row-%d", i)})
		n, err := file.Write(append(line, '\n'))
		if err != nil {
			t.Fatal(err)
		}
		offset += int64(n)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	file, err = os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	rows, before, warnings, err := agySubagentReadRows(context.Background(), file, offset, 7, agySubagentPageBytes)
	if err != nil || len(rows) != 7 || cap(rows) > 7 || len(warnings) != 0 || rows[0].step.Index != 9993 || rows[6].step.Index != 9999 || before != offsets[9993] {
		t.Fatalf("tail retention or cursor failed: len/cap=%d/%d before=%d warnings=%v err=%v", len(rows), cap(rows), before, warnings, err)
	}
	previous, previousBefore, _, err := agySubagentReadRows(context.Background(), file, before, 7, agySubagentPageBytes)
	if err != nil || len(previous) != 7 || previous[0].step.Index != 9986 || previous[6].step.Index != 9992 || previousBefore != offsets[9986] {
		t.Fatalf("ring boundary skipped or duplicated native rows: %#v %d %v", previous, previousBefore, err)
	}
	beginning, next, _, err := agySubagentReadRows(context.Background(), file, offsets[7], 7, agySubagentPageBytes)
	if err != nil || len(beginning) != 7 || beginning[0].step.Index != 0 || beginning[6].step.Index != 6 || next != 0 {
		t.Fatalf("beginning cursor invented earlier rows: %d %d %v", len(beginning), next, err)
	}
}

func TestAntigravitySubagentMalformedRowsHaveBoundedWarningsAndAccuratePages(t *testing.T) {
	reader, brain := agyGraphReader(t)
	path := agyGraphTranscript(t, brain, agyGraphChild, 3)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(strings.Repeat("x\n", 80000)); err != nil {
		t.Fatal(err)
	}
	large, _ := json.Marshal(map[string]any{"step_index": 3, "type": "PLANNER_RESPONSE", "content": strings.Repeat("large", agySubagentRecordBytes/5+1)})
	if _, err := file.Write(append(large, '\n')); err != nil {
		t.Fatal(err)
	}
	for i := 3; i < 6; i++ {
		line, _ := json.Marshal(map[string]any{"step_index": i, "type": "PLANNER_RESPONSE", "content": fmt.Sprintf("Native reply %d", i)})
		if _, err := file.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	file.Close()
	before := ""
	for _, want := range [][]string{{"Native reply 4", "Native reply 5"}, {"Native reply 2", "Native reply 3"}, {"Native reply 0", "Native reply 1"}} {
		page, err := reader.page(context.Background(), agyGraphRoot, "root:1", agyGraphChild, before, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Messages) != 2 || page.Messages[0]["text"] != want[0] || page.Messages[1]["text"] != want[1] {
			t.Fatalf("malformed rows broke native cursor: %#v", page)
		}
		if len(page.Warnings) > 2 {
			t.Fatalf("repeated invalid lines amplified warnings: %d", len(page.Warnings))
		}
		encoded, _ := json.Marshal(page)
		if len(encoded) > 10<<10 {
			t.Fatalf("small page amplified into %d bytes", len(encoded))
		}
		before = page.NextBefore
	}
	if before != "" {
		t.Fatal("cursor continued past the first valid native record")
	}
}
