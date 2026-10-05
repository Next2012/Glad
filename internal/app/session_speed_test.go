package app

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func speedFixture(t *testing.T, provider string) (*Session, *SpeedStore) {
	t.Helper()
	store, err := openSpeedStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := newSession("speed-session", "Speed", provider+"-structured", ToolInfo{Key: provider}, t.TempDir())
	session.speed = &SpeedTracker{session: session, store: store}
	return session, store
}
func TestSpeedIntervalUnionClipsParallelAndApprovalWaits(t *testing.T) {
	intervals := []speedSpan{{-20, 100}, {50, 150}, {120, 200}, {500, 1200}}
	if got := speedUnion(intervals, 1000); got != 700 {
		t.Fatalf("double counted or unbounded intervals: %d", got)
	}
}
func TestSpeedCodexUsesRootCumulativeUsageAndPreservesResumeBaseline(t *testing.T) {
	session, store := speedFixture(t, "codex")
	tracker := session.speed
	tracker.codex("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "a"}}, "root", "model", "profile", "low", false)
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-time.Second)
	tracker.mu.Unlock()
	notify := func(thread, id string, total, last int64) {
		tracker.codex("thread/tokenUsage/updated", map[string]any{"threadId": thread, "turnId": id, "tokenUsage": map[string]any{"total": map[string]any{"outputTokens": total}, "last": map[string]any{"outputTokens": last}}}, "root", "model", "profile", "low", false)
	}
	// The first sample after resume must not count the historical 1000 tokens.
	notify("root", "a", 1010, 10)
	notify("root", "a", 1030, 20)
	notify("root", "a", 1030, 20)
	notify("child", "a", 99999, 99000)
	tracker.codex("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "a", "status": "completed"}}, "root", "model", "profile", "low", false)
	sample := store.last("codex", "root")
	if sample == nil || sample.OutputTokens == nil || *sample.OutputTokens != 30 || sample.Rate == nil || !sample.Short {
		t.Fatalf("wrong scope or count: %#v", sample)
	}
	tracker.codex("turn/started", map[string]any{"threadId": "root", "turn": map[string]any{"id": "b"}}, "root", "model", "profile", "low", false)
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-time.Second)
	tracker.mu.Unlock()
	notify("root", "b", 1080, 50)
	tracker.codex("turn/completed", map[string]any{"threadId": "root", "turn": map[string]any{"id": "b", "status": "completed"}}, "root", "model", "profile", "low", false)
	if got := *store.last("codex", "root").OutputTokens; got != 50 {
		t.Fatalf("baseline carried wrong: %d", got)
	}
}
func TestSpeedClaudeDeduplicatesStreamsAndAssistantUsageExcludingSubagents(t *testing.T) {
	session, store := speedFixture(t, "claude-code")
	tracker := session.speed
	tracker.begin("native", "turn", "haiku", "profile", "low", false)
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-time.Second)
	tracker.mu.Unlock()
	tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start", "message": map[string]any{"id": "reply", "model": "haiku-actual"}}})
	tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_delta", "usage": map[string]any{"output_tokens": int64(80)}}})
	tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_stop"}})
	tracker.claude(map[string]any{"type": "assistant", "message": map[string]any{"id": "reply", "model": "haiku-actual", "usage": map[string]any{"output_tokens": int64(80)}}})
	tracker.claude(map[string]any{"type": "assistant", "parent_tool_use_id": "child", "message": map[string]any{"id": "child-reply", "usage": map[string]any{"output_tokens": int64(9999)}}})
	tracker.finish("completed", 800)
	sample := store.last("claude-code", "native")
	if sample.OutputTokens == nil || *sample.OutputTokens != 80 || sample.Rate == nil || sample.APIMs != 800 || sample.Model != "haiku-actual" {
		t.Fatalf("double-counted/subagent use: %#v", sample)
	}
}
func TestSpeedIncompleteAndStoppedTurnsDoNotFabricateValidRates(t *testing.T) {
	session, store := speedFixture(t, "codex")
	tracker := session.speed
	tracker.begin("root", "missing", "model", "profile", "", false)
	tracker.finish("completed", 0)
	if sample := store.last("codex", "root"); sample.Rate != nil || sample.OutputTokens != nil || sample.Quality != "incomplete" {
		t.Fatal("invented a rate")
	}
	tracker.begin("root", "stopped", "model", "profile", "", false)
	tracker.finish("cancelled", 0)
	if store.last("codex", "root").TurnID != "missing" {
		t.Fatal("stopped turn replaced last completed speed")
	}
}
func TestSpeedPersistenceDedupeAndArithmeticHourlyMean(t *testing.T) {
	session, store := speedFixture(t, "codex")
	session.State["threadId"] = "root"
	now := time.Now().UnixMilli()
	a, b, tokens := 10.0, 90.0, int64(10)
	for _, sample := range []SpeedSample{
		{ID: "a", Provider: "codex", ConversationID: "root", TurnID: "a", Model: "model", Profile: "profile", Method: speedMethod, Status: "completed", EndedAt: now - 100, Rate: &a, OutputTokens: &tokens, Short: true, WallMs: 1000},
		{ID: "b", Provider: "codex", ConversationID: "root", TurnID: "b", Model: "model", Profile: "profile", Method: speedMethod, Status: "completed", EndedAt: now, Rate: &b, OutputTokens: &tokens, WallMs: 9000},
		{ID: "bad", Provider: "codex", ConversationID: "root", Method: speedMethod, Status: "failed", EndedAt: now - 50, Rate: &b},
		{ID: "other", Provider: "codex", ConversationID: "other", Model: "other-model", Profile: "profile", Method: speedMethod, Status: "completed", EndedAt: now, Rate: &b},
	} {
		if err := store.add(sample); err != nil {
			t.Fatal(err)
		}
		if err := store.add(sample); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := openSpeedStore(store.directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.samples) != 4 {
		t.Fatal("duplicated recovered stats")
	}
	manager := NewSessionManager(t.TempDir())
	manager.sessions[session.ID] = session
	manager.speeds = reopened
	server := &Server{sessions: manager}
	req := httptest.NewRequest("GET", "/api/sessions/speed-session/speed?scope=session&timezone=UTC", nil)
	req.SetPathValue("id", session.ID)
	w := httptest.NewRecorder()
	server.sessionSpeed(w, req)
	var data map[string]any
	json.Unmarshal(w.Body.Bytes(), &data)
	if data["mean"] != float64(50) || data["validCount"] != float64(2) || data["shortCount"] != float64(1) {
		t.Fatalf("not the per-turn arithmetic mean: %s", w.Body.String())
	}
	if len(sliceValue(data["hours"])) != 24 {
		t.Fatal("missing hour bins")
	}
	for _, raw := range sliceValue(data["hours"]) {
		row := mapValue(raw)
		if numberInt64(row["count"]) > 0 && row["mean"] != float64(50) {
			t.Fatal("hourly included invalid/other-model samples")
		}
	}
	// A malformed file does not take down the application.
	if err = os.WriteFile(filepath.Join(store.directory, "broken.jsonl"), []byte("{bad"), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := openSpeedStore(store.directory)
	if err != nil || recovered.warnings == 0 || len(recovered.samples) != 4 {
		t.Fatal("corrupt stats blocked startup")
	}
	if strings.Contains(w.Body.String(), "inputText") {
		t.Fatal("statistics leaked transcript content")
	}
}

func TestSpeedKnownModelOverlapIsNotSubtractedAndForkResetsCounters(t *testing.T) {
	session, store := speedFixture(t, "codex")
	tracker := session.speed
	tracker.root = "old"
	tracker.baseline = 99999
	tracker.baselineKnown = true
	tracker.begin("fork", "turn", "model", "profile", "low", false)
	tracker.mu.Lock()
	run := tracker.run
	run.started = time.Now().Add(-time.Second)
	run.known = true
	run.tokens = 100
	run.intervals = []speedSpan{{100, 500}}
	run.replies["stream"] = &speedReply{first: 400, last: 700}
	if run.totalKnown {
		t.Fatal("fork reused old cumulative baseline")
	}
	tracker.mu.Unlock()
	tracker.finish("completed", 0)
	sample := store.last("codex", "fork")
	if sample.BlockedMs != 300 {
		t.Fatalf("subtracted model activity: %d", sample.BlockedMs)
	}
}
func TestSpeedPartialAuditTailDoesNotSwallowNextRecord(t *testing.T) {
	_, store := speedFixture(t, "codex")
	path := filepath.Join(store.directory, speedHash("codex:root")+".jsonl")
	if err := os.WriteFile(path, []byte(`{"partial":`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.add(SpeedSample{ID: "new", Provider: "codex", ConversationID: "root", Method: speedMethod, Status: "completed", EndedAt: millis()}); err != nil {
		t.Fatal(err)
	}
	reopened, err := openSpeedStore(store.directory)
	if err != nil || reopened.samples["new"].ID != "new" {
		t.Fatal("new observation lost after interrupted write")
	}
}

func TestSpeedModelScopeIsolatedByServiceEffortAndTier(t *testing.T) {
	session, store := speedFixture(t, "codex")
	session.State["threadId"] = "root"
	rate := 20.0
	reference := SpeedSample{ID: "reference", Provider: "codex", ConversationID: "root", Model: "model", Profile: "service-a", Effort: "low", Method: speedMethod, Status: "completed", EndedAt: millis(), Rate: &rate}
	store.add(reference)
	other := reference
	other.ID = "matching"
	other.ConversationID = "another"
	other.EndedAt--
	store.add(other)
	for i, change := range []func(*SpeedSample){func(s *SpeedSample) { s.Profile = "other-service" }, func(s *SpeedSample) { s.Effort = "high" }, func(s *SpeedSample) { s.Fast = true }} {
		row := reference
		row.ID = string(rune('a' + i))
		row.ConversationID = row.ID
		row.EndedAt--
		change(&row)
		store.add(row)
	}
	manager := NewSessionManager(t.TempDir())
	manager.sessions[session.ID] = session
	manager.speeds = store
	server := &Server{sessions: manager}
	req := httptest.NewRequest("GET", "/speed?scope=model&timezone=UTC", nil)
	req.SetPathValue("id", session.ID)
	w := httptest.NewRecorder()
	server.sessionSpeed(w, req)
	var data map[string]any
	json.Unmarshal(w.Body.Bytes(), &data)
	if data["validCount"] != float64(2) {
		t.Fatalf("mixed incomparable modes: %s", w.Body.String())
	}
	for _, query := range []string{"scope=invalid", "limit=500", "timezone=unknown"} {
		req = httptest.NewRequest("GET", "/speed?"+query, nil)
		req.SetPathValue("id", session.ID)
		w = httptest.NewRecorder()
		server.sessionSpeed(w, req)
		if w.Code != 400 {
			t.Fatalf("accepted invalid query %s", query)
		}
	}
}

func TestSpeedCollaborationMeasuresOnlyRootInvocationAndKeepsOverlap(t *testing.T) {
	for _, tc := range []struct {
		name, tool string
		spans      []speedSpan
		model      *speedReply
		want       int64
	}{
		{"wait", "wait", []speedSpan{{100, 500}}, nil, 400},
		{"spawn then generate", "spawnAgent", []speedSpan{{100, 120}}, &speedReply{first: 120, last: 900}, 20},
		{"overlapping waits", "wait", []speedSpan{{100, 500}, {300, 700}}, nil, 600},
		{"wait while model active", "wait", []speedSpan{{100, 500}}, &speedReply{first: 400, last: 700}, 300},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session, store := speedFixture(t, "codex")
			tracker := session.speed
			tracker.begin("root", "turn", "model", "profile", "", false)
			tracker.mu.Lock()
			tracker.run.started = time.Now().Add(-time.Second)
			tracker.run.known = true
			tracker.run.tokens = 100
			tracker.mu.Unlock()
			for i, span := range tc.spans {
				id := string(rune('a' + i))
				tracker.codex("item/started", map[string]any{"threadId": "root", "turnId": "turn", "item": map[string]any{"type": "collabAgentToolCall", "id": id, "tool": tc.tool}}, "root", "model", "profile", "", false)
				tracker.mu.Lock()
				if _, ok := tracker.run.blocks["tool:"+id]; !ok {
					t.Fatal("root collaboration invocation was not tracked")
				}
				tracker.run.blocks["tool:"+id] = span.start
				tracker.mu.Unlock()
				tracker.codex("item/completed", map[string]any{"threadId": "root", "turnId": "turn", "item": map[string]any{"type": "collabAgentToolCall", "id": id, "tool": tc.tool}}, "root", "model", "profile", "", false)
				tracker.mu.Lock()
				tracker.run.intervals[len(tracker.run.intervals)-1].end = span.end
				tracker.mu.Unlock()
			}
			tracker.codex("item/started", map[string]any{"threadId": "child", "turnId": "child-turn", "item": map[string]any{"type": "commandExecution", "id": "child-work"}}, "root", "model", "profile", "", false)
			tracker.mu.Lock()
			if tc.model != nil {
				tracker.run.replies["model"] = tc.model
			}
			tracker.mu.Unlock()
			tracker.finish("completed", 0)
			sample := store.last("codex", "root")
			if sample.BlockedMs != tc.want || sample.Quality != "estimated" {
				t.Fatalf("wrong waiting scope: %#v", sample)
			}
		})
	}
}
func TestSpeedClaudeTokenMaximumAndResultMismatchIsDiagnostic(t *testing.T) {
	session, store := speedFixture(t, "claude-code")
	tracker := session.speed
	tracker.begin("native", "turn", "model", "profile", "", false)
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-time.Second)
	tracker.mu.Unlock()
	tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start", "message": map[string]any{"id": "reply"}}})
	for _, n := range []int64{20, 100, 60} {
		tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_delta", "usage": map[string]any{"output_tokens": n}}})
	}
	tracker.claude(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start", "message": map[string]any{"id": "reply"}}})
	tracker.claude(map[string]any{"type": "assistant", "message": map[string]any{"id": "reply", "usage": map[string]any{"output_tokens": int64(80)}}})
	tracker.claude(map[string]any{"type": "result", "usage": map[string]any{"output_tokens": int64(120)}})
	tracker.claude(map[string]any{"type": "system", "subtype": "compact_boundary"})
	tracker.finish("completed", 0)
	row := store.last("claude-code", "native")
	if row.OutputTokens == nil || *row.OutputTokens != 100 || row.ResultTokensMatch == nil || *row.ResultTokensMatch || row.Quality != "estimated" || !row.Compacted {
		t.Fatalf("token decrease or mismatched scope invalidated sample: %#v", row)
	}
}
func TestSpeedShortFilterAffectsBothMeansButNotLastOrRows(t *testing.T) {
	session, store := speedFixture(t, "codex")
	session.State["threadId"] = "root"
	now := millis()
	small, boundary := int64(10), int64(50)
	low, high := 3.0, 80.0
	for _, row := range []SpeedSample{
		{ID: "small", Provider: "codex", ConversationID: "root", Model: "model", Method: speedMethod, Status: "completed", EndedAt: now, OutputTokens: &small, Short: true, Rate: &low},
		{ID: "long", Provider: "codex", ConversationID: "root", Model: "model", Method: speedMethod, Status: "completed", EndedAt: now - 1, OutputTokens: &boundary, Rate: &high},
	} {
		if err := store.add(row); err != nil {
			t.Fatal(err)
		}
	}
	manager := NewSessionManager(t.TempDir())
	manager.sessions[session.ID] = session
	manager.speeds = store
	server := &Server{sessions: manager}
	for _, scope := range []string{"session", "model"} {
		for _, filter := range []string{"false", "true"} {
			req := httptest.NewRequest("GET", "/speed?scope="+scope+"&excludeShort="+filter+"&timezone=UTC", nil)
			req.SetPathValue("id", session.ID)
			w := httptest.NewRecorder()
			server.sessionSpeed(w, req)
			var data map[string]any
			json.Unmarshal(w.Body.Bytes(), &data)
			wantMean, wantCount, wantExcluded := 41.5, float64(2), float64(0)
			if filter == "true" {
				wantMean, wantCount, wantExcluded = 80, 1, 1
			}
			if data["mean"] != wantMean || data["validCount"] != wantCount || data["excludedCount"] != wantExcluded || len(sliceValue(data["items"])) != 2 || mapValue(data["last"])["id"] != "small" {
				t.Fatalf("filter changed history/latest/window: %s", w.Body.String())
			}
			found := false
			for _, raw := range sliceValue(data["hours"]) {
				hour := mapValue(raw)
				if numberInt64(hour["sampleCount"]) > 0 {
					found = true
					if hour["mean"] != wantMean || hour["count"] != wantCount || hour["excludedCount"] != wantExcluded {
						t.Fatal("hour filter differs from turn filter")
					}
				}
			}
			if !found {
				t.Fatal("no hourly samples")
			}
		}
	}
	req := httptest.NewRequest("GET", "/speed?excludeShort=maybe", nil)
	req.SetPathValue("id", session.ID)
	w := httptest.NewRecorder()
	server.sessionSpeed(w, req)
	if w.Code != 400 {
		t.Fatal("invalid filter accepted")
	}
}
