package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const usageVersion = "20.0.26"

type UsageService struct {
	mu                sync.Mutex
	cached            map[string]any
	loadedAt          time.Time
	lastAttempt       time.Time
	failedAt          time.Time
	binary            string
	version           string
	loading           chan struct{}
	loadErr           error
	config            *ConfigStore
	offlineOnly       bool
	cachedOfflineOnly bool
	generation        uint64
	cachedGeneration  uint64
	revision          uint64
	ctx               context.Context
	cancel            context.CancelFunc
	jobCancel         context.CancelFunc
	started           bool
	stopped           bool
	wg                sync.WaitGroup
	staleAfter        time.Duration
	interval          time.Duration
	timeout           time.Duration
}

func NewUsageService(configs ...*ConfigStore) *UsageService {
	ctx, cancel := context.WithCancel(context.Background())
	service := &UsageService{version: usageVersion, ctx: ctx, cancel: cancel, staleAfter: time.Minute, interval: 30 * time.Minute, timeout: 2 * time.Minute}
	if len(configs) > 0 && configs[0] != nil {
		service.config = configs[0]
		service.offlineOnly = boolValue(service.config.Get("usageOfflineOnly"))
	}
	return service
}

func (service *UsageService) Start(parent context.Context) {
	service.mu.Lock()
	if service.started || service.stopped {
		service.mu.Unlock()
		return
	}
	service.cancel()
	service.ctx, service.cancel = context.WithCancel(parent)
	service.started = true
	ctx, interval := service.ctx, service.interval
	service.wg.Add(1)
	service.mu.Unlock()
	service.refresh(true)
	go func() {
		defer service.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// An installation without the native engine does not spawn a job on every tick.
				if _, err := service.findBinary(); err == nil {
					service.refresh(true)
				}
			}
		}
	}()
}

func (service *UsageService) Stop() {
	service.mu.Lock()
	service.stopped = true
	service.cancel()
	if service.jobCancel != nil {
		service.jobCancel()
	}
	service.mu.Unlock()
	service.wg.Wait()
}

func (service *UsageService) SetOfflineOnly(value bool) error {
	service.mu.Lock()
	if service.offlineOnly == value {
		service.mu.Unlock()
		return nil
	}
	if service.config != nil {
		if err := service.config.Set("usageOfflineOnly", value); err != nil {
			service.mu.Unlock()
			return err
		}
	}
	service.offlineOnly = value
	service.generation++
	service.loadErr = nil
	service.lastAttempt = time.Time{}
	if service.jobCancel != nil {
		service.jobCancel()
	}
	service.mu.Unlock()
	service.refresh(true)
	return nil
}

var usageSources = map[string]map[string]any{
	"codex":  {"id": "codex", "label": "Codex", "badge": "CX"},
	"claude": {"id": "claude", "label": "Claude", "badge": "CL"},
}

func (service *UsageService) findBinary() (string, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.binary != "" {
		return service.binary, nil
	}
	if configured := os.Getenv("GLAD_CCUSAGE_BIN"); configured != "" {
		if info, err := os.Stat(configured); err != nil || info.IsDir() {
			return "", errors.New("configured ccusage binary is missing")
		}
		service.binary = configured
		return configured, nil
	}
	executable, _ := os.Executable()
	name := "ccusage"
	if filepath.Ext(executable) == ".exe" {
		name = "ccusage.exe"
	}
	candidates := []string{
		filepath.Join(filepath.Dir(executable), name),
		filepath.Join("node_modules", "@ccusage", "ccusage-linux-x64", "bin", name),
	}
	packageName := map[string]string{
		"linux/amd64": "ccusage-linux-x64", "linux/arm64": "ccusage-linux-arm64",
		"darwin/amd64": "ccusage-darwin-x64", "darwin/arm64": "ccusage-darwin-arm64",
		"windows/amd64": "ccusage-win32-x64", "windows/arm64": "ccusage-win32-arm64",
	}[runtime.GOOS+"/"+runtime.GOARCH]
	for current, depth := filepath.Dir(executable), 0; current != filepath.Dir(current) && depth < 6; current, depth = filepath.Dir(current), depth+1 {
		if packageName != "" {
			candidates = append(
				candidates,
				filepath.Join(current, "node_modules", "@ccusage", packageName, "bin", name),
				filepath.Join(current, "@ccusage", packageName, "bin", name),
			)
		}
	}
	if path, err := exec.LookPath("ccusage"); err == nil {
		candidates = append(candidates, path)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			_ = os.Chmod(candidate, 0o755)
			service.binary = candidate
			return candidate, nil
		}
	}
	return "", errors.New("ccusage native binary is missing for this platform")
}

// refresh is single-flight. A request only schedules work; the daemon owns its context.
func (service *UsageService) refresh(force bool) {
	service.mu.Lock()
	if service.stopped || service.loading != nil {
		service.mu.Unlock()
		return
	}
	if !force {
		if service.cached != nil && service.cachedGeneration == service.generation && time.Since(service.loadedAt) < service.staleAfter {
			service.mu.Unlock()
			return
		}
		if service.loadErr != nil && time.Since(service.failedAt) < service.staleAfter {
			service.mu.Unlock()
			return
		}
	}
	ctx, cancel := context.WithTimeout(service.ctx, service.timeout)
	service.jobCancel = cancel
	finished := make(chan struct{})
	service.loading = finished
	service.lastAttempt = time.Now()
	generation, offline := service.generation, service.offlineOnly
	service.wg.Add(1)
	service.mu.Unlock()
	go func() {
		defer service.wg.Done()
		result, err := service.loadUncached(ctx, offline)
		cancel()
		service.mu.Lock()
		obsolete := generation != service.generation
		if !service.stopped && !obsolete {
			service.loadErr = err
			if err != nil {
				service.failedAt = time.Now()
			}
			if err == nil {
				service.cached = result
				service.loadedAt = time.Now()
				service.cachedGeneration = generation
				service.cachedOfflineOnly = offline
				service.revision++
			}
		}
		service.loading = nil
		service.jobCancel = nil
		close(finished)
		restart := obsolete && !service.stopped
		service.mu.Unlock()
		if restart {
			service.refresh(true)
		}
	}()
}

func (service *UsageService) snapshot(refresh bool) (map[string]any, map[string]any) {
	service.refresh(refresh)
	service.mu.Lock()
	defer service.mu.Unlock()
	var generatedAt any
	if !service.loadedAt.IsZero() {
		generatedAt = service.loadedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	}
	lastError := ""
	if service.loadErr != nil {
		lastError = service.loadErr.Error()
	}
	offline := service.offlineOnly
	if service.cached != nil {
		offline = service.cachedOfflineOnly
	}
	mode := "online-preferred"
	if offline {
		mode = "offline"
	}
	return service.cached, map[string]any{
		"hasData": service.cached != nil, "generatedAt": generatedAt, "refreshing": service.loading != nil,
		"lastError": lastError, "offlineOnly": service.offlineOnly, "revision": service.revision,
		"settingsPending": service.cached != nil && service.cachedGeneration != service.generation,
		"timezone":        systemTimezone(), "engine": map[string]any{"name": "ccusage", "version": service.version, "pricingMode": mode},
	}
}

func (service *UsageService) loadUncached(ctx context.Context, offline bool) (map[string]any, error) {
	binary, err := service.findBinary()
	if err != nil {
		return nil, err
	}
	args := []string{"daily", "--sections", "daily,weekly,monthly", "--by-agent", "--json", "--timezone", systemTimezone()}
	if offline {
		args = append(args, "--offline")
	} else {
		args = append(args, "--no-offline")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	configPath := filepath.Join(home, ".glad", "ccusage.json")
	if _, err := os.Stat(configPath); err == nil {
		if err := validateUsageConfig(configPath); err != nil {
			return nil, err
		}
		args = append(args, "--config", configPath)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = append(os.Environ(), "NO_COLOR=1")
	command.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ccusage refresh: %w", ctx.Err())
		}
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return nil, errors.New(message)
		}
		return nil, fmt.Errorf("ccusage: %w", err)
	}
	if stdout.Len() > 64<<20 {
		return nil, errors.New("ccusage report exceeded the safe output limit")
	}
	var raw map[string]any
	if json.Unmarshal(stdout.Bytes(), &raw) != nil || raw == nil {
		return nil, errors.New("ccusage returned invalid JSON")
	}
	return raw, nil
}
func (service *UsageService) sources(ctx context.Context, refresh bool) (map[string]any, error) {
	raw, metadata := service.snapshot(refresh)
	present := map[string]bool{}
	for _, scope := range []string{"daily", "weekly", "monthly"} {
		for _, rowValue := range sliceValue(raw[scope]) {
			for _, agentValue := range sliceValue(mapValue(rowValue)["agents"]) {
				present[stringValue(mapValue(agentValue)["agent"])] = true
			}
		}
	}
	sources := []map[string]any{}
	for _, id := range []string{"codex", "claude"} {
		if present[id] {
			sources = append(sources, usageSources[id])
		}
	}
	metadata["sources"] = sources
	return metadata, nil
}

type usageModel struct {
	ModelName      string `json:"modelName"`
	Uncached       int64  `json:"uncachedInputTokens"`
	Cached         int64  `json:"cachedInputTokens"`
	Output         int64  `json:"outputTokens"`
	Total          int64  `json:"totalTokens"`
	Cost           any    `json:"estimatedCostUSD"`
	MissingPricing bool   `json:"missingPricing"`
}

func normalizeUsageModels(source string, agent map[string]any, missingNames ...string) []usageModel {
	models := []usageModel{}
	if len(agent) == 0 {
		return models
	}
	unpriced := stringSet(stringsFromAny(agent["unpricedModels"]))
	for _, name := range missingNames {
		unpriced[name] = true
	}
	breakdowns := sliceValue(agent["modelBreakdowns"])
	if len(breakdowns) == 0 {
		breakdowns = []any{
			map[string]any{
				"modelName":           singleModel(agent["modelsUsed"]),
				"inputTokens":         agent["inputTokens"],
				"cacheCreationTokens": agent["cacheCreationTokens"],
				"cacheReadTokens":     agent["cacheReadTokens"],
				"outputTokens":        agent["outputTokens"],
				"cost":                agent["totalCost"],
			},
		}
	}
	for _, value := range breakdowns {
		row := mapValue(value)
		uncached := numberInt64(row["inputTokens"]) + numberInt64(row["cacheCreationTokens"])
		cached := numberInt64(row["cacheReadTokens"])
		output := numberInt64(row["outputTokens"])
		name := firstNonEmpty(stringValue(row["modelName"]), "Unknown")
		missing := boolValue(row["missingPricing"]) || unpriced[name] || row["cost"] == nil
		var cost any
		if row["cost"] != nil && !missing {
			cost = numberFloat(row["cost"])
		}
		models = append(
			models,
			usageModel{
				ModelName:      name,
				MissingPricing: missing,
				Uncached:       uncached,
				Cached:         cached,
				Output:         output,
				Total:          uncached + cached + output,
				Cost:           cost,
			},
		)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Total > models[j].Total })
	return models
}
func singleModel(value any) string {
	items := stringsFromAny(value)
	if len(items) == 1 {
		return items[0]
	}
	if len(items) > 1 {
		return "Multiple models"
	}
	return "Unknown"
}
func findAgent(row map[string]any, source string) map[string]any {
	for _, value := range sliceValue(row["agents"]) {
		agent := mapValue(value)
		if stringValue(agent["agent"]) == source {
			return agent
		}
	}
	return nil
}
func usageRow(source, period string, agent map[string]any, missingNames ...string) map[string]any {
	models := normalizeUsageModels(source, agent, missingNames...)
	totals := map[string]any{
		"uncachedInputTokens": int64(0),
		"cachedInputTokens":   int64(0),
		"outputTokens":        int64(0),
		"totalTokens":         int64(0),
		"estimatedCostUSD":    nil,
	}
	cost := 0.0
	hasCost := false
	unpriced := []string{}
	for _, model := range models {
		totals["uncachedInputTokens"] = numberInt64(totals["uncachedInputTokens"]) + model.Uncached
		totals["cachedInputTokens"] = numberInt64(totals["cachedInputTokens"]) + model.Cached
		totals["outputTokens"] = numberInt64(totals["outputTokens"]) + model.Output
		totals["totalTokens"] = numberInt64(totals["totalTokens"]) + model.Total
		if model.MissingPricing {
			unpriced = append(unpriced, model.ModelName)
		}
		if model.Cost != nil {
			cost += numberFloat(model.Cost)
			hasCost = true
		}
	}
	if hasCost {
		totals["estimatedCostUSD"] = cost
	}
	status := "unavailable"
	if hasCost {
		status = "complete"
		if len(unpriced) > 0 {
			status = "partial"
		}
	}
	totals["pricingStatus"] = status
	totals["unpricedModels"] = unpriced
	return map[string]any{"period": period, "models": models, "totals": totals}
}

func (service *UsageService) dashboard(
	ctx context.Context,
	source, scope, period string,
	refresh bool,
) (map[string]any, error) {
	if usageSources[source] == nil {
		return nil, errors.New("Unsupported usage source")
	}
	if scope != "weekly" && scope != "monthly" {
		return nil, errors.New("Scope must be weekly or monthly")
	}
	raw, metadata := service.snapshot(refresh)
	unpriced := stringsFromAny(mapValue(raw["totals"])["unpricedModels"])
	periods := []string{}
	for _, value := range sliceValue(raw[scope]) {
		row := mapValue(value)
		if findAgent(row, source) != nil {
			periods = append(periods, stringValue(row["period"]))
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(periods)))
	if period == "" || !contains(periods, period) {
		if len(periods) > 0 {
			period = periods[0]
		}
	}
	empty := usageRow(source, period, map[string]any{})
	summary := empty
	days := []map[string]any{}
	for _, value := range sliceValue(raw[scope]) {
		row := mapValue(value)
		if stringValue(row["period"]) == period {
			if agent := findAgent(row, source); agent != nil {
				summary = usageRow(source, period, agent, unpriced...)
			}
		}
	}
	for _, value := range sliceValue(raw["daily"]) {
		row := mapValue(value)
		date := stringValue(row["period"])
		if dateInUsageScope(date, scope, period) {
			if agent := findAgent(row, source); agent != nil {
				days = append(days, usageRow(source, date, agent, unpriced...))
			}
		}
	}
	var cost any
	if mapValue(summary["totals"])["estimatedCostUSD"] != nil {
		cost = map[string]any{
			"basis": "ccusage model-price estimate",
			"note":  "Estimated from ccusage model pricing; it is not an actual provider bill or subscription charge.",
		}
	}
	metadata["source"] = usageSources[source]
	metadata["scope"] = scope
	metadata["availablePeriods"] = periods
	metadata["selectedPeriod"] = nilIfEmpty(period)
	metadata["summary"] = summary
	metadata["days"] = days
	metadata["cost"] = cost
	return metadata, nil
}
func dateInUsageScope(date, scope, period string) bool {
	if scope == "monthly" {
		return strings.HasPrefix(date, period+"-")
	}
	start, err := time.Parse("2006-01-02", period)
	if err != nil {
		return false
	}
	candidate, err := time.Parse("2006-01-02", date)
	return err == nil && !candidate.Before(start) && candidate.Before(start.AddDate(0, 0, 7))
}
func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
func numberFloat(value any) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case int64:
		return float64(number)
	case int:
		return float64(number)
	}
	return 0
}

func systemTimezone() string {
	if value := strings.TrimSpace(os.Getenv("TZ")); value != "" {
		return value
	}
	if content, err := os.ReadFile("/etc/timezone"); err == nil && strings.TrimSpace(string(content)) != "" {
		return strings.TrimSpace(string(content))
	}
	if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if index := strings.Index(target, "/zoneinfo/"); index >= 0 {
			return target[index+len("/zoneinfo/"):]
		}
	}
	return "UTC"
}
func (server *Server) registerUsageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/usage/sources", func(w http.ResponseWriter, r *http.Request) {
		result, err := server.usage.sources(r.Context(), r.URL.Query().Get("refresh") == "1")
		if err != nil {
			respondError(w, 500, err)
			return
		}
		respondJSON(w, 200, result)
	})
	mux.HandleFunc("PATCH /api/usage/settings", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			OfflineOnly *bool `json:"offlineOnly"`
		}
		if err := decodeJSON(r, &input); err != nil || input.OfflineOnly == nil {
			respondError(w, 400, errors.New("offlineOnly must be a boolean"))
			return
		}
		if err := server.usage.SetOfflineOnly(*input.OfflineOnly); err != nil {
			respondError(w, 500, err)
			return
		}
		_, metadata := server.usage.snapshot(false)
		respondJSON(w, 200, metadata)
	})
	mux.HandleFunc("GET /api/usage/report", func(w http.ResponseWriter, r *http.Request) {
		result, err := server.usage.dashboard(
			r.Context(),
			r.URL.Query().Get("source"),
			firstNonEmpty(r.URL.Query().Get("scope"), "weekly"),
			r.URL.Query().Get("period"),
			r.URL.Query().Get("refresh") == "1",
		)
		if err != nil {
			respondError(w, 400, err)
			return
		}
		respondJSON(w, 200, result)
	})
}
