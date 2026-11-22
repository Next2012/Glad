package app

import (
	"errors"
	"sort"
	"time"
)

// Accounting has a separate 90-day ledger; speed sample trimming and rotation
// cannot erase token totals. Both views use the same verified native snapshot.
func (service *UsageService) antigravitySamples() []SpeedSample {
	if service.antigravityUsage == nil {
		return nil
	}
	return service.antigravityUsage.snapshot()
}

func antigravityUsageKnown(sample SpeedSample) bool {
	return sample.InputTokens != nil && sample.CachedInputTokens != nil && sample.CacheWriteTokens != nil && sample.OutputTokens != nil
}

func antigravityUsageRow(period string, samples []SpeedSample) map[string]any {
	byModel := map[string]map[string]any{}
	for _, sample := range samples {
		name := firstNonEmpty(sample.Model, "Unknown")
		row := byModel[name]
		if row == nil {
			row = map[string]any{"modelName": name, "uncachedInputTokens": int64(0), "cachedInputTokens": int64(0), "outputTokens": int64(0), "totalTokens": int64(0), "thoughtTokens": int64(0), "thoughtTokensKnown": true, "cachedInputTokensKnown": true, "estimatedCostUSD": nil, "missingPricing": true}
			byModel[name] = row
		}
		input, cached, output := *sample.InputTokens+*sample.CacheWriteTokens, *sample.CachedInputTokens, *sample.OutputTokens
		row["uncachedInputTokens"] = numberInt64(row["uncachedInputTokens"]) + input
		row["cachedInputTokens"] = numberInt64(row["cachedInputTokens"]) + cached
		row["outputTokens"] = numberInt64(row["outputTokens"]) + output
		row["totalTokens"] = numberInt64(row["totalTokens"]) + input + cached + output
		if sample.ThoughtTokens == nil {
			row["thoughtTokensKnown"] = false
		} else {
			row["thoughtTokens"] = numberInt64(row["thoughtTokens"]) + *sample.ThoughtTokens
		}
	}
	models := []map[string]any{}
	unpriced := []string{}
	totals := map[string]any{"uncachedInputTokens": int64(0), "cachedInputTokens": int64(0), "outputTokens": int64(0), "totalTokens": int64(0), "cachedInputTokensKnown": true, "estimatedCostUSD": nil, "pricingStatus": "unavailable"}
	for name, row := range byModel {
		if !boolValue(row["thoughtTokensKnown"]) {
			row["thoughtTokens"] = nil
		}
		models = append(models, row)
		unpriced = append(unpriced, name)
		for _, key := range []string{"uncachedInputTokens", "cachedInputTokens", "outputTokens", "totalTokens"} {
			totals[key] = numberInt64(totals[key]) + numberInt64(row[key])
		}
	}
	sort.Slice(models, func(i, j int) bool {
		a, b := numberInt64(models[i]["totalTokens"]), numberInt64(models[j]["totalTokens"])
		if a == b {
			return stringValue(models[i]["modelName"]) < stringValue(models[j]["modelName"])
		}
		return a > b
	})
	sort.Strings(unpriced)
	if len(samples) == 0 {
		for _, key := range []string{"uncachedInputTokens", "cachedInputTokens", "outputTokens", "totalTokens"} {
			totals[key] = nil
		}
		totals["cachedInputTokensKnown"] = false
	}
	totals["unpricedModels"] = unpriced
	return map[string]any{"period": period, "models": models, "totals": totals}
}

func (service *UsageService) antigravityDashboard(scope, period string) (map[string]any, error) {
	if scope != "weekly" && scope != "monthly" {
		return nil, errors.New("Scope must be weekly or monthly")
	}
	location, err := time.LoadLocation(systemTimezone())
	if err != nil {
		location = time.Local
	}
	samples := service.antigravitySamples()
	grouped := map[string][]SpeedSample{}
	byDay := map[string][]SpeedSample{}
	var latest int64
	excluded := 0
	periodCandidates := map[string]bool{}
	excludedByPeriod := map[string]int{}
	for _, sample := range samples {
		if sample.EndedAt > latest {
			latest = sample.EndedAt
		}
		date := time.UnixMilli(sample.EndedAt).In(location)
		day := date.Format("2006-01-02")
		key := date.Format("2006-01")
		if scope == "weekly" {
			key = date.AddDate(0, 0, -(int(date.Weekday())+6)%7).Format("2006-01-02")
		}
		periodCandidates[key] = true
		if !antigravityUsageKnown(sample) {
			excluded++
			excludedByPeriod[key]++
			continue
		}
		grouped[key] = append(grouped[key], sample)
		byDay[day] = append(byDay[day], sample)
	}
	periods := []string{}
	for key := range periodCandidates {
		periods = append(periods, key)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(periods)))
	if !contains(periods, period) {
		period = ""
		if len(periods) > 0 {
			period = periods[0]
		}
	}
	days := []map[string]any{}
	for day, rows := range byDay {
		if dateInUsageScope(day, scope, period) {
			days = append(days, antigravityUsageRow(day, rows))
		}
	}
	sort.Slice(days, func(i, j int) bool { return stringValue(days[i]["period"]) > stringValue(days[j]["period"]) })
	var generatedAt any
	if latest > 0 {
		generatedAt = time.UnixMilli(latest).UTC().Format(time.RFC3339Nano)
	}
	lastError := ""
	if service.antigravityUsage.warningCount() > 0 {
		lastError = "Antigravity token ledger recovered an interrupted trailing record; token totals may be incomplete."
	}
	return map[string]any{
		"hasData": true, "usageAvailable": len(grouped) > 0, "generatedAt": generatedAt, "refreshing": false, "lastError": lastError, "settingsPending": false,
		"revision": len(samples), "timezone": systemTimezone(), "source": usageSources["antigravity"], "scope": scope, "availablePeriods": periods, "selectedPeriod": nilIfEmpty(period),
		"summary": antigravityUsageRow(period, grouped[period]), "days": days, "cost": nil, "excludedSamples": excludedByPeriod[period], "globalExcludedSamples": excluded,
		"engine":     map[string]any{"name": "Antigravity ACP", "pricingMode": "unavailable"},
		"engineNote": "Antigravity reported token usage recorded by Glad since this update; native history is not backfilled. Recorded usage is retained for 90 days. Samples with missing token counts are excluded; reasoning tokens are included in output.",
	}, nil
}
