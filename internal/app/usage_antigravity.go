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
	return antigravityPricedUsageRow(period, samples, antigravityPricing{})
}

func antigravityPricedUsageRow(period string, samples []SpeedSample, pricing antigravityPricing) map[string]any {
	byModel := map[string]map[string]any{}
	coverageByModel := map[string]*antigravityPriceCoverage{}
	coverage := &antigravityPriceCoverage{}
	for _, sample := range samples {
		name := firstNonEmpty(sample.Model, "Unknown")
		row := byModel[name]
		if row == nil {
			row = map[string]any{"modelName": name, "uncachedInputTokens": int64(0), "cachedInputTokens": int64(0), "outputTokens": int64(0), "totalTokens": int64(0), "thoughtTokens": int64(0), "thoughtTokensKnown": true, "cachedInputTokensKnown": true, "estimatedCostUSD": nil, "missingPricing": true}
			byModel[name] = row
			coverageByModel[name] = &antigravityPriceCoverage{}
		}
		estimate := pricing.estimate(sample)
		coverage.add(sample, estimate)
		coverageByModel[name].add(sample, estimate)
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
		coverageByModel[name].decorate(row)
		models = append(models, row)
		if boolValue(row["missingPricing"]) {
			unpriced = append(unpriced, name)
		}
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
	coverage.decorate(totals)
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
	pricing := service.loadAntigravityPricing()
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
			days = append(days, antigravityPricedUsageRow(day, rows, pricing))
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
	if pricing.err != nil {
		if lastError != "" {
			lastError += " "
		}
		lastError += pricing.err.Error()
	}
	summary := antigravityPricedUsageRow(period, grouped[period], pricing)
	basis := mapValue(summary["totals"])["pricingBasis"]
	assumptions := []string{"Token value assumes all recorded counts use the selected model; per-request and subagent model attribution is unavailable.", "Prices use the recorded root-turn completion date in UTC, independently of the report timezone; no long-context tier is inferred from cumulative turn tokens.", "Output already includes thinking tokens. Unknown cache-write pricing is excluded, not charged at the input rate.", "This reference is not subscription spend, AI-credit consumption, a provider bill, or a complete estimate of tool, grounding, cache-storage or other charges."}
	return map[string]any{
		"hasData": true, "usageAvailable": len(grouped) > 0, "generatedAt": generatedAt, "refreshing": false, "lastError": lastError, "settingsPending": false,
		"revision": len(samples), "timezone": systemTimezone(), "source": usageSources["antigravity"], "scope": scope, "availablePeriods": periods, "selectedPeriod": nilIfEmpty(period),
		"summary": summary, "days": days, "pricingBasis": basis, "pricingCoverage": mapValue(summary["totals"])["pricingCoverage"], "assumptions": assumptions, "cost": map[string]any{"basis": basis, "note": "API price reference under a selected-model assumption; not actual spending or AI-credit consumption."}, "excludedSamples": excludedByPeriod[period], "globalExcludedSamples": excluded,
		"engine":     map[string]any{"name": "Antigravity ACP", "pricingMode": "reference"},
		"engineNote": "Antigravity token usage recorded by Glad for 90 days; native history is not backfilled. Cost is a selected-model API price reference, not actual spending or AI credits. Built-in Google Developer API Standard rates or explicit user overrides apply by completion date in UTC; no long-context tier is inferred. Output includes thinking tokens. Other charges and unknown components are excluded.",
	}, nil
}
