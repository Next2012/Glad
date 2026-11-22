package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func agyMetricsUsage(input, output, cached, thought int64) map[string]any {
	return map[string]any{"inputTokens": input, "outputTokens": output, "cachedReadTokens": cached, "cachedWriteTokens": int64(0), "thoughtTokens": thought}
}

func TestAntigravitySpeedReplacesRootSnapshotWithoutDoubleCountingSteering(t *testing.T) {
	session, store := speedFixture(t, "antigravity")
	defer session.cancel()
	tracker := session.speed
	tracker.begin("native", "root-turn", "gemini", "project", "high", false)
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-2 * time.Second)
	tracker.mu.Unlock()
	tracker.antigravityUpdate(map[string]any{"sessionUpdate": "usage_update", "used": int64(999999), "size": int64(1048576)})
	tracker.antigravityUsage(nil) // Superseded prompt acknowledgement, not missing spend.
	tracker.antigravityUsage(agyMetricsUsage(100, 80, 20, 10))
	tracker.antigravityUsage(nil)
	tracker.antigravityUsage(agyMetricsUsage(300, 110, 60, 30)) // Complete active-root snapshot.
	tracker.antigravityUsage(agyMetricsUsage(300, 110, 60, 30)) // Duplicate must not add.
	sample := tracker.finish("completed", 0)
	if sample == nil || sample.OutputTokens == nil || *sample.OutputTokens != 110 || *sample.InputTokens != 300 || *sample.CachedInputTokens != 60 || *sample.ThoughtTokens != 30 || sample.Rate == nil || sample.Quality != "estimated" {
		t.Fatalf("wrong root snapshot: %#v", sample)
	}
	if *sample.Rate < 50 || *sample.Rate > 60 {
		t.Fatalf("wrong speed: %f", *sample.Rate)
	}
	loaded, err := openSpeedStore(store.directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.last("antigravity", "native"); got == nil || *got.CachedInputTokens != 60 || *got.OutputTokens != 110 {
		t.Fatal("fields lost after reload")
	}
	tracker.begin("native", "next", "gemini", "project", "high", false)
	tracker.antigravityUsage(agyMetricsUsage(20, 3, 0, 1))
	next := tracker.finish("completed", 0)
	if *next.OutputTokens != 3 || *next.InputTokens != 20 {
		t.Fatal("previous root usage leaked into next turn")
	}
}

func TestAntigravityMissingSnapshotsRemainUnknownWithoutOldFieldSplicing(t *testing.T) {
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	tracker := session.speed
	tracker.begin("native", "missing", "model", "", "", false)
	tracker.antigravityUsage(nil)
	missing := tracker.finish("completed", 0)
	if missing.OutputTokens != nil || missing.Rate != nil || missing.Quality != "incomplete" {
		t.Fatal("missing snapshot became known zero")
	}
	tracker.begin("native", "partial", "model", "", "", false)
	tracker.antigravityUsage(agyMetricsUsage(100, 80, 20, 10))
	tracker.antigravityUsage(map[string]any{"outputTokens": int64(110)})
	partial := tracker.finish("completed", 0)
	if *partial.OutputTokens != 110 || partial.InputTokens != nil || partial.CachedInputTokens != nil || partial.ThoughtTokens != nil || antigravityUsageKnown(*partial) {
		t.Fatalf("spliced old fields: %#v", partial)
	}
	tracker.begin("native", "mismatch", "model", "", "", false)
	usage := agyMetricsUsage(100, 80, 20, 10)
	usage["totalTokens"] = int64(180)
	tracker.antigravityUsage(usage)
	mismatch := tracker.finish("completed", 0)
	if mismatch.OutputTokens == nil || *mismatch.OutputTokens != 80 || antigravityUsageKnown(*mismatch) {
		t.Fatal("conflicting total became complete accounting")
	}
}

func TestAntigravitySpeedSplitsModelActivityAtToolBoundaries(t *testing.T) {
	for _, messageID := range []string{"", "same-native-id"} {
		session, _ := speedFixture(t, "antigravity")
		defer session.cancel()
		tracker := session.speed
		tracker.begin("native", "tool", "model", "", "", false)
		at := func(ms int64) {
			tracker.mu.Lock()
			tracker.run.started = time.Now().Add(-time.Duration(ms) * time.Millisecond)
			tracker.mu.Unlock()
		}
		thought := map[string]any{"sessionUpdate": "agent_thought_chunk", "messageId": messageID, "content": map[string]any{"text": "thinking"}}
		at(0)
		tracker.antigravityUpdate(thought)
		at(1000)
		tracker.antigravityUpdate(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tool", "status": "in_progress"})
		at(9000)
		tracker.antigravityUpdate(map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tool", "status": "completed"})
		at(10000)
		tracker.antigravityUpdate(thought)
		tracker.antigravityUsage(agyMetricsUsage(100, 80, 20, 10))
		at(11000)
		sample := tracker.finish("completed", 0)
		if sample.BlockedMs < 7990 || sample.BlockedMs > 8010 || sample.ObservedMs < 2990 || sample.ObservedMs > 3010 {
			t.Fatalf("serial tool became model activity (messageID=%q): %#v", messageID, sample)
		}
	}
}

func TestAntigravityDaemonPartialUpdatesNeverBlockRootSpeed(t *testing.T) {
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	tracker := session.speed
	tracker.begin("native", "daemon", "model", "", "", false)
	tracker.antigravityUpdate(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "daemon", "status": "in_progress", "rawInput": map[string]any{"IsDaemon": true}})
	tracker.antigravityUpdate(map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "daemon", "status": "in_progress"})
	tracker.antigravityUsage(agyMetricsUsage(100, 80, 20, 10))
	tracker.mu.Lock()
	tracker.run.started = time.Now().Add(-time.Second)
	tracker.mu.Unlock()
	sample := tracker.finish("completed", 0)
	if sample.BlockedMs != 0 || sample.Quality != "estimated" || sample.Rate == nil {
		t.Fatalf("partial daemon blocked root: %#v", sample)
	}
}

func agyLedgerFixture(t *testing.T) *AntigravityUsageStore {
	t.Helper()
	store, err := openAntigravityUsageStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return store
}
func agyRecordUsage(t *testing.T, session *Session, ledger *AntigravityUsageStore, turn string, usage map[string]any) *SpeedSample {
	t.Helper()
	session.speed.begin("native", turn, "gemini", "", "high", false)
	session.speed.antigravityUsage(usage)
	sample := session.speed.finish("completed", 0)
	if err := ledger.add(*sample); err != nil {
		t.Fatal(err)
	}
	return sample
}

func TestAntigravityUsageDashboardAggregatesRecordedCountsWithoutPrices(t *testing.T) {
	t.Setenv("TZ", "Asia/Shanghai")
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	ledger := agyLedgerFixture(t)
	agyRecordUsage(t, session, ledger, "known", agyMetricsUsage(100, 80, 20, 10))
	agyRecordUsage(t, session, ledger, "partial", map[string]any{"inputTokens": int64(100), "outputTokens": int64(80)})
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = ledger
	for _, scope := range []string{"weekly", "monthly"} {
		report, err := service.antigravityDashboard(scope, "")
		if err != nil {
			t.Fatal(err)
		}
		totals := mapValue(mapValue(report["summary"])["totals"])
		if numberInt64(totals["totalTokens"]) != 200 || numberInt64(totals["outputTokens"]) != 80 || numberInt64(totals["cachedInputTokens"]) != 20 || totals["estimatedCostUSD"] != nil || numberInt64(report["excludedSamples"]) != 1 || !boolValue(report["hasData"]) {
			t.Fatalf("wrong accounting: %#v", report)
		}
		models := mapValue(report["summary"])["models"].([]map[string]any)
		if len(models) != 1 || numberInt64(models[0]["thoughtTokens"]) != 10 || len(report["days"].([]map[string]any)) != 1 {
			t.Fatal("missing model/day aggregation")
		}
		if mapValue(report["engine"])["name"] != "Antigravity ACP" {
			t.Fatal("native report attributed to ccusage")
		}
	}
	if _, err := service.antigravityDashboard("daily", ""); err == nil {
		t.Fatal("invalid scope accepted")
	}
}

func TestAntigravityUsageEmptyAndIncompleteReportsAreSettled(t *testing.T) {
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	ledger := agyLedgerFixture(t)
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = ledger
	for _, withSample := range []bool{false, true} {
		if withSample {
			agyRecordUsage(t, session, ledger, "missing", nil)
		}
		report, err := service.antigravityDashboard("weekly", "")
		if err != nil || !boolValue(report["hasData"]) || boolValue(report["usageAvailable"]) || boolValue(report["refreshing"]) {
			t.Fatalf("empty report never settled: %#v %v", report, err)
		}
		if _, present := report["offlineOnly"]; present {
			t.Fatal("native report overwrote ccusage preference")
		}
		if mapValue(mapValue(report["summary"])["totals"])["totalTokens"] != nil {
			t.Fatal("unknown spend became zero")
		}
	}
	service.mu.Lock()
	service.stopped = true
	service.loadErr = errors.New("ccusage missing")
	service.mu.Unlock()
	sources, err := service.sources(context.Background(), false)
	if err != nil || !boolValue(sources["hasData"]) || stringValue(sources["lastError"]) != "" || len(sources["sources"].([]map[string]any)) != 1 || mapValue(sources["sourceErrors"])["ccusage"] != "ccusage missing" {
		t.Fatalf("ccusage hid AGY: %#v %v", sources, err)
	}
}

func TestAntigravityUsageLedgerSurvivesSpeedTrimmingRestartAndDeduplicates(t *testing.T) {
	session := newSession("id", "usage", "antigravity-structured", ToolInfo{Key: "antigravity"}, t.TempDir())
	defer session.cancel()
	session.speed = &SpeedTracker{session: session} // No speed store.
	ledger := agyLedgerFixture(t)
	a := agyRecordUsage(t, session, ledger, "a", agyMetricsUsage(100, 80, 20, 10))
	b := *a
	b.ID = "previous-day"
	b.EndedAt = time.Now().AddDate(0, 0, -1).UnixMilli()
	if err := ledger.add(b); err != nil {
		t.Fatal(err)
	}
	if err := ledger.add(*a); err != nil {
		t.Fatal(err)
	}
	old := b
	old.ID = "expired"
	old.EndedAt = time.Now().AddDate(0, 0, -91).UnixMilli()
	if err := ledger.add(old); err != nil {
		t.Fatal(err)
	}
	reloaded, err := openAntigravityUsageStore(ledger.directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.snapshot()) != 2 {
		t.Fatal("duplicate, expiry or daily restart lost ledger")
	}
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = reloaded
	_, err = service.antigravityDashboard("monthly", "")
	if err != nil {
		t.Fatal(err)
	}
	if numberInt64(mapValue(antigravityUsageRow("all-recorded-days", reloaded.snapshot())["totals"])["totalTokens"]) != 400 {
		t.Fatal("ledger depended on speed store")
	}
	expiredPath := filepath.Join(ledger.directory, time.Now().AddDate(0, 0, -95).UTC().Format("2006-01-02")+".jsonl")
	if err := os.WriteFile(expiredPath, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openAntigravityUsageStore(ledger.directory); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expiredPath); !os.IsNotExist(err) {
		t.Fatal("expired daily ledger not cleaned")
	}
}

func TestAntigravityUsageLedgerRepairsInterruptedTailAndRejectsMiddleCorruption(t *testing.T) {
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	ledger := agyLedgerFixture(t)
	sample := agyRecordUsage(t, session, ledger, "valid", agyMetricsUsage(100, 80, 20, 10))
	path := filepath.Join(ledger.directory, time.UnixMilli(sample.EndedAt).UTC().Format("2006-01-02")+".jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.WriteString(`{"id":"unfinished`); err != nil {
		t.Fatal(err)
	}
	file.Close()
	recovered, err := openAntigravityUsageStore(ledger.directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered.snapshot()) != 1 || recovered.warningCount() != 1 {
		t.Fatal("valid prefix or visible warning lost")
	}
	next := *sample
	next.ID = "after-recovery"
	if err := recovered.add(next); err != nil {
		t.Fatal(err)
	}
	again, err := openAntigravityUsageStore(ledger.directory)
	if err != nil || len(again.snapshot()) != 2 || again.warningCount() != 1 {
		t.Fatalf("tail repair broke later records: %v", err)
	}
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = again
	report, _ := service.antigravityDashboard("weekly", "")
	if stringValue(report["lastError"]) == "" {
		t.Fatal("recovery loss hidden")
	}
	if err := os.WriteFile(path, []byte("broken-middle\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openAntigravityUsageStore(ledger.directory); err == nil {
		t.Fatal("middle corruption silently skipped")
	}
}

func TestAntigravitySpeedSplitsModelActivityAtHumanWaitBoundaries(t *testing.T) {
	session, _ := speedFixture(t, "antigravity")
	defer session.cancel()
	tracker := session.speed
	tracker.begin("native", "human", "model", "", "", false)
	at := func(ms int64) {
		tracker.mu.Lock()
		tracker.run.started = time.Now().Add(-time.Duration(ms) * time.Millisecond)
		tracker.mu.Unlock()
	}
	thought := map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"text": "thinking"}}
	at(0)
	tracker.antigravityUpdate(thought)
	at(1000)
	tracker.state("waiting_approval")
	at(2000)
	tracker.state("waiting_approval")
	at(9000)
	tracker.state("running")
	at(10000)
	tracker.antigravityUpdate(thought)
	tracker.antigravityUsage(agyMetricsUsage(100, 80, 20, 10))
	at(11000)
	sample := tracker.finish("completed", 0)
	if sample.BlockedMs < 7990 || sample.BlockedMs > 8010 {
		t.Fatalf("human wait became model activity: %#v", sample)
	}
}

func TestAntigravityTokenCountAcceptsNativeJSONNumbers(t *testing.T) {
	for _, value := range []any{json.Number("80"), int64(80), int(80), float64(80)} {
		count, valid := antigravityTokenCount(value)
		if !valid || count == nil || *count != 80 {
			t.Fatalf("native count %T(%v) not recognized", value, value)
		}
	}
	for _, value := range []any{json.Number("-1"), json.Number("1.5"), json.Number("9223372036854775808"), int64(-1), -1, math.NaN(), math.Inf(1), nil, "80"} {
		count, valid := antigravityTokenCount(value)
		if valid || count != nil {
			t.Fatalf("invalid count %T(%v) accepted", value, value)
		}
	}
}

// Exercise the real stdio transport and its decoder.UseNumber(), not synthetic
// maps. A wire-type regression must fail before a browser sees unknown totals.
func TestAntigravityMetricsProcessFixtureRecordsSpeedAndIndependentUsage(t *testing.T) {
	p := antigravityFixture(t)
	speeds, err := openSpeedStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ledger := agyLedgerFixture(t)
	p.mu.Lock()
	p.session.mu.Lock()
	p.session.speed = &SpeedTracker{session: p.session, store: speeds}
	p.session.antigravityUsage = ledger
	p.session.mu.Unlock()
	p.mu.Unlock()

	antigravitySend(t, p, "agy-metrics")
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	p.mu.Lock()
	native := p.nativeID
	p.mu.Unlock()
	first := speeds.last("antigravity", native)
	if first == nil || first.OutputTokens == nil || *first.OutputTokens != 80 || first.InputTokens == nil || *first.InputTokens != 100 || first.CachedInputTokens == nil || *first.CachedInputTokens != 20 || first.ThoughtTokens == nil || *first.ThoughtTokens != 10 || first.Rate == nil || *first.Rate <= 0 {
		t.Fatalf("production decoder lost native numeric token fields: %#v", first)
	}
	rows := ledger.snapshot()
	if len(rows) != 1 || numberInt64(mapValue(antigravityUsageRow("recorded", rows)["totals"])["totalTokens"]) != 200 {
		t.Fatalf("native completion did not reach independent usage ledger: %#v", rows)
	}

	// Native steering acknowledges the displaced prompt without usage. The
	// final response supplies the whole root's usage, exactly once.
	antigravitySend(t, p, "agy-long")
	antigravityWait(t, time.Second, func() bool {
		for _, message := range antigravityMessages(p) {
			if strings.Contains(stringValue(message["text"]), "working before steering") {
				return true
			}
		}
		return false
	})
	p.mu.Lock()
	turn := p.turnID
	p.mu.Unlock()
	if err := p.Steer(context.Background(), ProviderInput{Text: "steer metrics", AgentText: "steer metrics", ClientMessageID: newUUID()}, turn); err != nil {
		t.Fatal(err)
	}
	antigravityWait(t, 3*time.Second, func() bool { return antigravityIdle(p) })
	last := speeds.last("antigravity", native)
	if last == nil || last.TurnID != turn || last.OutputTokens == nil || *last.OutputTokens != 160 || last.InputTokens == nil || *last.InputTokens != 200 || last.CachedInputTokens == nil || *last.CachedInputTokens != 40 || last.Rate == nil {
		t.Fatalf("steering acknowledgement erased or duplicated root usage: %#v", last)
	}
	if antigravityKindCount(p, "turn-end") != 2 {
		t.Fatal("steering added a separate root completion")
	}
	reloaded, err := openAntigravityUsageStore(ledger.directory)
	if err != nil {
		t.Fatal(err)
	}
	rows = reloaded.snapshot()
	if len(rows) != 2 || numberInt64(mapValue(antigravityUsageRow("recorded", rows)["totals"])["totalTokens"]) != 600 {
		t.Fatalf("usage ledger did not persist exactly 200 + 400 native tokens: %#v", rows)
	}
}
