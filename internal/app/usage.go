package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type UsageService struct {
	mu       sync.Mutex
	cached   map[string]any
	loadedAt time.Time
	binary   string
	version  string
	loading  chan struct{}
	loadErr  error
}

func NewUsageService() *UsageService { return &UsageService{version: "20.0.20"} }

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
func (service *UsageService) load(ctx context.Context, refresh bool) (map[string]any, error) {
	service.mu.Lock()
	if !refresh && service.cached != nil && time.Since(service.loadedAt) < 5*time.Minute {
		result := service.cached
		service.mu.Unlock()
		return result, nil
	}
	if loading := service.loading; loading != nil {
		service.mu.Unlock()
		select {
		case <-loading:
			service.mu.Lock()
			result, err := service.cached, service.loadErr
			service.mu.Unlock()
			return result, err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	loading := make(chan struct{})
	service.loading = loading
	service.mu.Unlock()
	result, err := service.loadUncached(ctx)
	service.mu.Lock()
	if err == nil {
		service.cached = result
		service.loadedAt = time.Now()
	}
	service.loadErr = err
	service.loading = nil
	close(loading)
	service.mu.Unlock()
	return result, err
}

func (service *UsageService) loadUncached(ctx context.Context) (map[string]any, error) {
	binary, err := service.findBinary()
	if err != nil {
		return nil, err
	}
	timezone := systemTimezone()
	command := exec.CommandContext(
		ctx,
		binary,
		"daily",
		"--sections",
		"daily,weekly,monthly",
		"--by-agent",
		"--json",
		"--offline",
		"--timezone",
		timezone,
	)
	command.Env = append(os.Environ(), "NO_COLOR=1")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return nil, errors.New(strings.TrimSpace(stderr.String()))
	}
	if stdout.Len() > 64<<20 {
		return nil, errors.New("ccusage report exceeded the safe output limit")
	}
	var raw map[string]any
	if json.Unmarshal(stdout.Bytes(), &raw) != nil {
		return nil, errors.New("ccusage returned invalid JSON")
	}
	return raw, nil
}
func (service *UsageService) sources(ctx context.Context, refresh bool) (map[string]any, error) {
	raw, err := service.load(ctx, refresh)
	if err != nil {
		return nil, err
	}
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
	timezone := systemTimezone()
	return map[string]any{
		"sources":     sources,
		"generatedAt": time.Now().UTC().Format(time.RFC3339),
		"timezone":    timezone,
		"engine":      map[string]any{"name": "ccusage", "version": service.version, "pricingMode": "embedded"},
	}, nil
}

type usageModel struct {
	ModelName string `json:"modelName"`
	Uncached  int64  `json:"uncachedInputTokens"`
	Cached    int64  `json:"cachedInputTokens"`
	Output    int64  `json:"outputTokens"`
	Total     int64  `json:"totalTokens"`
	Cost      any    `json:"estimatedCostUSD"`
}

func normalizeUsageModels(source string, agent map[string]any) []usageModel {
	models := []usageModel{}
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
		var cost any
		if source == "codex" && regexp.MustCompile(`(?i)^gpt(?:-|$)`).MatchString(stringValue(row["modelName"])) &&
			numberFloat(row["cost"]) > 0 {
			cost = numberFloat(row["cost"])
		}
		models = append(
			models,
			usageModel{
				ModelName: firstNonEmpty(stringValue(row["modelName"]), "Unknown"),
				Uncached:  uncached,
				Cached:    cached,
				Output:    output,
				Total:     uncached + cached + output,
				Cost:      cost,
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
func usageRow(source, period string, agent map[string]any) map[string]any {
	models := normalizeUsageModels(source, agent)
	totals := map[string]any{
		"uncachedInputTokens": int64(0),
		"cachedInputTokens":   int64(0),
		"outputTokens":        int64(0),
		"totalTokens":         int64(0),
		"estimatedCostUSD":    nil,
	}
	cost := 0.0
	hasCost := false
	for _, model := range models {
		totals["uncachedInputTokens"] = numberInt64(totals["uncachedInputTokens"]) + model.Uncached
		totals["cachedInputTokens"] = numberInt64(totals["cachedInputTokens"]) + model.Cached
		totals["outputTokens"] = numberInt64(totals["outputTokens"]) + model.Output
		totals["totalTokens"] = numberInt64(totals["totalTokens"]) + model.Total
		if model.Cost != nil {
			cost += numberFloat(model.Cost)
			hasCost = true
		}
	}
	if hasCost {
		totals["estimatedCostUSD"] = cost
	}
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
	raw, err := service.load(ctx, refresh)
	if err != nil {
		return nil, err
	}
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
				summary = usageRow(source, period, agent)
			}
		}
	}
	for _, value := range sliceValue(raw["daily"]) {
		row := mapValue(value)
		date := stringValue(row["period"])
		if dateInUsageScope(date, scope, period) {
			if agent := findAgent(row, source); agent != nil {
				days = append(days, usageRow(source, date, agent))
			}
		}
	}
	timezone := systemTimezone()
	var cost any
	if source == "codex" {
		cost = map[string]any{
			"basis": "ccusage estimate for Codex GPT models",
			"note":  "Estimated from ccusage model pricing; it is not an actual provider bill.",
		}
	}
	return map[string]any{
		"source":           usageSources[source],
		"scope":            scope,
		"availablePeriods": periods,
		"selectedPeriod":   nilIfEmpty(period),
		"summary":          summary,
		"days":             days,
		"generatedAt":      time.Now().UTC().Format(time.RFC3339),
		"timezone":         timezone,
		"engine":           map[string]any{"name": "ccusage", "version": service.version, "pricingMode": "embedded"},
		"cost":             cost,
	}, nil
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
