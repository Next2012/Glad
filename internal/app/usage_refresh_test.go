package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const usageFakeScript = `#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['HOME']) / 'usage-fixture'
control = root / 'control.json'
data = json.loads(control.read_text())
offline = '--offline' in sys.argv
config = sys.argv[sys.argv.index('--config')+1] if '--config' in sys.argv else None
active = root / 'active'
if active.exists():
    try:
        os.kill(int(active.read_text()), 0)
        print('overlapping ccusage processes', file=sys.stderr); sys.exit(9)
    except (ProcessLookupError, ValueError): pass
active.write_text(str(os.getpid()))
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps({'offline':offline,'config':config,'pid':os.getpid()})+'\n')
try:
    if config:
        try: json.loads(pathlib.Path(config).read_text())
        except Exception:
            print('fake ccusage config error: invalid JSON',file=sys.stderr); sys.exit(2)
    while json.loads(control.read_text()).get('hold',False): time.sleep(.01)
    time.sleep(data.get('delay',0))
    if data.get('fail'):
        print(data['fail'],file=sys.stderr); sys.exit(2)
    row={'modelName':'gpt-test','inputTokens':100,'cacheReadTokens':10,'cacheCreationTokens':0,'outputTokens':20,'cost':data.get('cost',1 if offline else 2)}
    if data.get('missing'): row['missingPricing']=True
    agent={'agent':'codex','modelBreakdowns':[row],'modelsUsed':['gpt-test'],'inputTokens':100,'cacheReadTokens':10,'outputTokens':20,'totalCost':row['cost']}
    report={name:[{'period':period,'agents':[agent]}] for name,period in [('daily','2026-10-08'),('weekly','2026-10-05'),('monthly','2026-10')]}
    report['totals']={'unpricedModels':['gpt-test'] if data.get('globalMissing') else []}
    print(json.dumps(report))
finally:
    active.unlink(missing_ok=True)
`

func usageFixture(t *testing.T) (*UsageService, string, *ConfigStore) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake executable uses a Unix shebang")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is needed for the fake ccusage executable")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	root := filepath.Join(home, "usage-fixture")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	setUsageControl(t, root, map[string]any{})
	binary := filepath.Join(root, "ccusage")
	if err := os.WriteFile(binary, []byte(usageFakeScript), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GLAD_CCUSAGE_BIN", binary)
	config, err := OpenConfigStore()
	if err != nil {
		t.Fatal(err)
	}
	service := NewUsageService(config)
	t.Cleanup(service.Stop)
	return service, root, config
}

func setUsageControl(t *testing.T, root string, data map[string]any) {
	t.Helper()
	bytes, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "control.json")
	if err := os.WriteFile(path+".tmp", bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		t.Fatal(err)
	}
}

func usageCalls(root string) []map[string]any {
	data, _ := os.ReadFile(filepath.Join(root, "calls.jsonl"))
	rows := []map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) == nil {
			rows = append(rows, row)
		}
	}
	return rows
}

func awaitUsage(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for the fake usage engine")
}

func usageFinished(service *UsageService) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.cached != nil && service.loading == nil
}

func TestUsageColdPrewarmIsNonblockingAndSingleFlight(t *testing.T) {
	service, root, _ := usageFixture(t)
	setUsageControl(t, root, map[string]any{"hold": true})
	service.Start(context.Background())
	awaitUsage(t, func() bool { return len(usageCalls(root)) == 1 })
	ctx, cancel := context.WithCancel(context.Background())
	start := time.Now()
	snapshot, err := service.dashboard(ctx, "codex", "weekly", "", false)
	if err != nil || snapshot["hasData"] != false || snapshot["refreshing"] != true || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("cold report waited for prewarm: %v %v", snapshot, err)
	}
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() { defer group.Done(); service.snapshot(true) }()
	}
	group.Wait()
	cancel() // Closing the requesting panel cannot cancel the background process.
	if len(usageCalls(root)) != 1 {
		t.Fatal("concurrent requests started multiple engine processes")
	}
	setUsageControl(t, root, map[string]any{})
	awaitUsage(t, func() bool { return usageFinished(service) })
	_, metadata := service.snapshot(false)
	if metadata["hasData"] != true || metadata["refreshing"] != false || metadata["generatedAt"] == nil {
		t.Fatal("prewarm did not finish after the requesting context was cancelled")
	}
}

func TestUsageStaleRefreshKeepsPreviousReportAndFailure(t *testing.T) {
	service, root, _ := usageFixture(t)
	service.Start(context.Background())
	awaitUsage(t, func() bool { return usageFinished(service) })
	_, initial := service.snapshot(false)
	service.mu.Lock()
	service.loadedAt = time.Now().Add(-2 * time.Minute)
	service.mu.Unlock()
	_, old := service.snapshot(false)
	// Wait for the staleness-triggered refresh before testing a failed manual refresh.
	awaitUsage(t, func() bool { return usageFinished(service) })
	_, initial = service.snapshot(false)
	setUsageControl(t, root, map[string]any{"hold": true, "fail": "fake scan failed without discarding the last report"})
	start := time.Now()
	result, err := service.dashboard(context.Background(), "codex", "weekly", "", true)
	if err != nil || result["hasData"] != true || result["refreshing"] != true || time.Since(start) > 200*time.Millisecond {
		t.Fatal("manual refresh blocked returning the previous report")
	}
	if old["refreshing"] != true || result["generatedAt"] != initial["generatedAt"] {
		t.Fatal("stale refresh or original cache timestamp was lost")
	}
	awaitUsage(t, func() bool { return len(usageCalls(root)) >= 3 })
	setUsageControl(t, root, map[string]any{})
	awaitUsage(t, func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		return service.loading == nil && service.loadErr != nil
	})
	report, _ := service.dashboard(context.Background(), "codex", "weekly", "", false)
	if report["generatedAt"] != initial["generatedAt"] || report["lastError"] != "fake scan failed without discarding the last report" || report["refreshing"] != false || report["hasData"] != true {
		t.Fatalf("failed refresh erased or relabelled cached data: %#v", report)
	}
}

func TestUsageModeChangeDiscardsInFlightResultAndPersists(t *testing.T) {
	service, root, config := usageFixture(t)
	setUsageControl(t, root, map[string]any{"hold": true})
	service.Start(context.Background())
	awaitUsage(t, func() bool { return len(usageCalls(root)) == 1 })
	if err := service.SetOfflineOnly(true); err != nil {
		t.Fatal(err)
	}
	awaitUsage(t, func() bool { return len(usageCalls(root)) == 2 })
	setUsageControl(t, root, map[string]any{})
	awaitUsage(t, func() bool { return usageFinished(service) })
	report, _ := service.dashboard(context.Background(), "codex", "weekly", "", false)
	if report["offlineOnly"] != true || mapValue(report["engine"])["pricingMode"] != "offline" || report["lastError"] != "" || report["settingsPending"] != false {
		t.Fatalf("obsolete refresh overwrote the requested mode: %#v", report)
	}
	if numberFloat(mapValue(mapValue(report["summary"])["totals"])["estimatedCostUSD"]) != 1 {
		t.Fatal("received the online result after switching to offline")
	}
	calls := usageCalls(root)
	if calls[0]["offline"] != false || calls[1]["offline"] != true || len(calls) != 2 {
		t.Fatal("mode change started the wrong or overlapping processes")
	}
	reloaded, err := OpenConfigStore()
	if err != nil || reloaded.Get("usageOfflineOnly") != true || config.Get("usageOfflineOnly") != true {
		t.Fatal("offline preference did not survive config reload")
	}
	entries, _ := os.ReadDir(filepath.Dir(config.path))
	for _, entry := range entries {
		if entry.Name() != "config.json" {
			t.Fatalf("report was persisted to disk: %s", entry.Name())
		}
	}
}

func TestUsageConfigErrorsRemainVisibleAndKeepCache(t *testing.T) {
	service, root, _ := usageFixture(t)
	service.Start(context.Background())
	awaitUsage(t, func() bool { return usageFinished(service) })
	if usageCalls(root)[0]["config"] != nil {
		t.Fatal("passed a nonexistent override file")
	}
	path := filepath.Join(os.Getenv("HOME"), ".glad", "ccusage.json")
	if err := os.WriteFile(path, []byte(`{"defaults":{"pricingOverrides":{}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	service.snapshot(true)
	awaitUsage(t, func() bool { return len(usageCalls(root)) == 2 && usageFinished(service) })
	if usageCalls(root)[1]["config"] != path {
		t.Fatal("override file was not passed to the engine")
	}
	if err := os.WriteFile(path, []byte(`broken JSON`), 0600); err != nil {
		t.Fatal(err)
	}
	service.snapshot(true)
	awaitUsage(t, func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		return service.loading == nil && service.loadErr != nil
	})
	_, state := service.snapshot(false)
	if !strings.Contains(stringValue(state["lastError"]), "Invalid ccusage configuration") || state["hasData"] != true || len(usageCalls(root)) != 2 {
		t.Fatalf("config error was hidden or treated as a network retry: %v", state)
	}
}

func TestUsageConfigPinnedRules(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ccusage.json")
	for _, value := range []string{
		`{"defaults":{"pricingOverrides":{"gpt-new":{"inputCostPerToken":0,"outputCostPerToken":0}}}}`,
		`{"codex":{"defaults":{"speed":"standard"},"commands":{"daily":{"timezone":"UTC"}}}}`,
		`{"defaults":{"offline":true},"pi":{"stores":[{"name":"extra","path":"/tmp/store"}]}}`,
	} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateUsageConfig(path); err != nil {
			t.Fatalf("valid ccusage settings rejected: %v", err)
		}
	}
	for _, value := range []string{
		`broken JSON`, `[]`, `{"defaults":"wrong"}`,
		`{"defaults":{"pricingOverrides":{"gpt-new":{"inputCostPerToken":"wrong"}}}}`,
		`{"codex":{"defaults":{"speed":"unknown"}}}`, `{"defaults":{"debugSamples":-1}}`,
		`{"defaults":{"typo":true}}`,
	} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateUsageConfig(path); err == nil {
			t.Fatalf("invalid configuration silently accepted: %s", value)
		}
	}
}

func TestUsageTimeoutAndShutdownEndTheBackgroundJob(t *testing.T) {
	service, root, _ := usageFixture(t)
	service.timeout = 100 * time.Millisecond
	setUsageControl(t, root, map[string]any{"hold": true})
	service.Start(context.Background())
	awaitUsage(t, func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		return service.loading == nil && service.loadErr != nil
	})
	_, state := service.snapshot(false)
	if !strings.Contains(stringValue(state["lastError"]), "deadline exceeded") {
		t.Fatalf("timeout lost its cause: %v", state)
	}
	service.timeout = time.Minute
	service.snapshot(true)
	awaitUsage(t, func() bool { return len(usageCalls(root)) == 2 })
	start := time.Now()
	service.Stop()
	if time.Since(start) > time.Second {
		t.Fatal("shutdown waited for the refresh timeout")
	}
}

func TestUsageLongFailureDoesNotImmediatelyRestartWhilePolling(t *testing.T) {
	service, root, _ := usageFixture(t)
	service.staleAfter = 80 * time.Millisecond
	service.timeout = 200 * time.Millisecond
	setUsageControl(t, root, map[string]any{"hold": true})
	service.Start(context.Background())
	awaitUsage(t, func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		return service.loading == nil && service.loadErr != nil
	})
	_, state := service.snapshot(false)
	if state["refreshing"] != false || state["lastError"] == "" {
		t.Fatal("polling restarted a long failed refresh before its error could be shown")
	}
}

func TestUsagePeriodicRefreshAndMissingEngineSkip(t *testing.T) {
	service, root, _ := usageFixture(t)
	service.interval = 30 * time.Millisecond
	service.Start(context.Background())
	awaitUsage(t, func() bool { return len(usageCalls(root)) >= 2 })
	service.Stop()
	missing := NewUsageService()
	missing.interval = 20 * time.Millisecond
	t.Setenv("GLAD_CCUSAGE_BIN", filepath.Join(root, "missing"))
	missing.Start(context.Background())
	defer missing.Stop()
	awaitUsage(t, func() bool {
		missing.mu.Lock()
		defer missing.mu.Unlock()
		return missing.loadErr != nil && missing.loading == nil
	})
	missing.mu.Lock()
	initial := missing.lastAttempt
	missing.mu.Unlock()
	time.Sleep(70 * time.Millisecond)
	missing.mu.Lock()
	defer missing.mu.Unlock()
	if missing.lastAttempt != initial {
		t.Fatal("periodic timer repeatedly spawned jobs without an engine")
	}
}

func TestUsageUnknownPartialAndRealZeroCosts(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		rows   []any
		status string
		cost   any
	}{
		{"unknown", []any{map[string]any{"modelName": "gpt-new", "cost": 0, "missingPricing": true}}, "unavailable", nil},
		{"partial", []any{map[string]any{"modelName": "gpt-new", "cost": 0, "missingPricing": true}, map[string]any{"modelName": "known", "cost": 2}}, "partial", float64(2)},
		{"free", []any{map[string]any{"modelName": "known-free", "cost": 0}}, "complete", float64(0)},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			row := usageRow("codex", "2026-10", map[string]any{"modelBreakdowns": scenario.rows})
			totals := mapValue(row["totals"])
			if totals["pricingStatus"] != scenario.status || totals["estimatedCostUSD"] != scenario.cost {
				t.Fatalf("unknown pricing was conflated with zero: %v", totals)
			}
		})
	}
	service, root, _ := usageFixture(t)
	setUsageControl(t, root, map[string]any{"cost": 0, "globalMissing": true})
	service.Start(context.Background())
	awaitUsage(t, func() bool { return usageFinished(service) })
	for _, scope := range []string{"weekly", "monthly"} {
		report, _ := service.dashboard(context.Background(), "codex", scope, "", false)
		totals := mapValue(mapValue(report["summary"])["totals"])
		if totals["pricingStatus"] != "unavailable" || totals["estimatedCostUSD"] != nil || len(stringsFromAny(totals["unpricedModels"])) != 1 {
			t.Fatal("global unpricedModels metadata was discarded")
		}
	}
}
