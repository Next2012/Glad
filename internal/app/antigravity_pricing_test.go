package app

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func antigravityPricingSample(model, date string, input, cached, output, write int64) SpeedSample {
	when, err := time.Parse(time.RFC3339, date)
	if err != nil {
		panic(err)
	}
	thought := int64(500000)
	return SpeedSample{ID: model + date, Provider: "antigravity", Model: model, EndedAt: when.UnixMilli(), InputTokens: &input, CachedInputTokens: &cached, OutputTokens: &output, CacheWriteTokens: &write, ThoughtTokens: &thought}
}
func assertReferenceCost(t *testing.T, value any, want float64) {
	t.Helper()
	if value == nil || math.Abs(numberFloat(value)-want) > 1e-9 {
		t.Fatalf("reference cost=%v, want %g", value, want)
	}
}
func TestAntigravityReferencePricesUseExactModelsAndCompletionDate(t *testing.T) {
	pricing := antigravityPricing{}
	for _, test := range []struct {
		model, date string
		want        float64
	}{
		{"gemini-4-neon", "2026-12-31T23:59:59Z", 18.15},
		{"gemini-3.8-flash", "2026-12-31T23:59:59.999Z", 4.575},
		{"gemini-3.8-flash", "2027-01-01T00:00:00Z", 9.15},
	} {
		sample := antigravityPricingSample(test.model, test.date, 1000000, 1000000, 1000000, 0)
		estimate := pricing.estimate(sample)
		if estimate.cost == nil || !estimate.fullyPriced || estimate.pricedTokens != 3000000 || estimate.basis != antigravityReferencePriceBasis {
			t.Fatalf("known price missing: %#v", estimate)
		}
		assertReferenceCost(t, *estimate.cost, test.want)
	}
	for _, model := range []string{"gemini-4-neon-high", "gemini-4-neon-latest", "gemini-pro-orchestrator", "gemini-3.1-pro", "unknown"} {
		estimate := pricing.estimate(antigravityPricingSample(model, "2026-11-22T01:00:00Z", 100, 20, 80, 0))
		if estimate.cost != nil || estimate.reason != "unknown-exact-model" {
			t.Fatalf("guessed alias/tier/orchestrator price for %s", model)
		}
	}
	// Root-turn totals over 200K must not invent a long-context surcharge.
	huge := pricing.estimate(antigravityPricingSample("gemini-4-neon", "2026-11-22T01:00:00Z", 5000000, 2000000, 1000000, 0))
	assertReferenceCost(t, *huge.cost, 30.3)
}

func TestAntigravityReferenceAggregationKeepsUnknownTokensAndPartialComponents(t *testing.T) {
	known := antigravityPricingSample("gemini-4-neon", "2026-11-22T01:00:00Z", 1000000, 1000000, 1000000, 0)
	writeUnknown := antigravityPricingSample("gemini-4-neon", "2026-11-22T01:01:00Z", 1000000, 1000000, 1000000, 1000000)
	unmapped := antigravityPricingSample("unmapped", "2026-11-22T01:02:00Z", 1000000, 1000000, 1000000, 0)
	before, _ := json.Marshal([]SpeedSample{known, writeUnknown, unmapped})
	row := antigravityUsageRow("period", []SpeedSample{known, writeUnknown, unmapped})
	totals := mapValue(row["totals"])
	coverage := mapValue(totals["pricingCoverage"])
	assertReferenceCost(t, totals["estimatedCostUSD"], 36.3)
	if totals["pricingStatus"] != "partial" || numberInt64(totals["totalTokens"]) != 10000000 || numberInt64(coverage["pricedTokens"]) != 6000000 || numberInt64(coverage["totalTokens"]) != 10000000 {
		t.Fatalf("partial reference lost usage counts: %#v", totals)
	}
	models := row["models"].([]map[string]any)
	for _, model := range models {
		if model["modelName"] == "unmapped" && model["estimatedCostUSD"] != nil {
			t.Fatal("unknown model became free")
		}
		if model["modelName"] == "gemini-4-neon" && model["pricingStatus"] != "partial" {
			t.Fatal("unknown write price was charged as input")
		}
	}
	after, _ := json.Marshal([]SpeedSample{known, writeUnknown, unmapped})
	if string(before) != string(after) {
		t.Fatal("reference calculation mutated stored token samples")
	}
}

func TestAntigravityPricingOverridesAreStrictAndZeroIsARealPrice(t *testing.T) {
	valid := `{"version":1,"models":{"custom":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0,"cacheWriteUSDPerMillion":0,"effectiveFrom":"2026-12-01","effectiveUntil":"2027-01-01"}}}`
	config, err := decodeAntigravityPricingConfig(strings.NewReader(valid))
	if err != nil {
		t.Fatal(err)
	}
	pricing := antigravityPricing{models: config.Models}
	estimate := pricing.estimate(antigravityPricingSample("custom", "2026-12-31T23:59:59Z", 100, 20, 80, 10))
	if estimate.cost == nil || *estimate.cost != 0 || !estimate.fullyPriced || estimate.basis != "user-override" {
		t.Fatalf("explicit zero was not a real override: %#v", estimate)
	}
	for _, date := range []string{"2026-11-30T23:59:59Z", "2027-01-01T00:00:00Z"} {
		if pricing.estimate(antigravityPricingSample("custom", date, 100, 20, 80, 0)).cost != nil {
			t.Fatal("override escaped its UTC date range")
		}
	}
	for _, invalid := range []string{
		`null`, `{}`, `{"version":2,"models":{}}`, `{"version":1,"models":null}`, `{"version":1,"models":{},"extra":true}`, valid + ` {}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0}}}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":-1,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0}}}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":"0","cachedInputUSDPerMillion":0,"outputUSDPerMillion":0}}}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0,"threshold":200000}}}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0,"effectiveFrom":"2027-01-01","effectiveUntil":"2027-01-01"}}}`,
		`{"version":1,"models":{"x":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0,"effectiveFrom":"2026-99-01"}}}`,
	} {
		if _, err := decodeAntigravityPricingConfig(strings.NewReader(invalid)); err == nil {
			t.Fatalf("invalid override accepted: %s", invalid)
		}
	}
}

func TestAntigravityPricingReloadNeverUsesStaleOrInvalidConfiguration(t *testing.T) {
	service := NewUsageService()
	defer service.Stop()
	service.antigravityPricingPath = filepath.Join(t.TempDir(), "antigravity-pricing.json")
	sample := antigravityPricingSample("gemini-4-neon", "2026-11-22T01:00:00Z", 1000000, 1000000, 1000000, 0)
	baseline := service.loadAntigravityPricing().estimate(sample)
	assertReferenceCost(t, *baseline.cost, 18.15)
	if err := os.WriteFile(service.antigravityPricingPath, []byte(`{"version":1,"models":{"gemini-4-neon":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	free := service.loadAntigravityPricing().estimate(sample)
	if free.cost == nil || *free.cost != 0 || free.basis != "user-override" {
		t.Fatal("new override was not loaded")
	}
	if err := os.WriteFile(service.antigravityPricingPath, []byte(`{"version":1,"models":{"bad":{}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	invalid := service.loadAntigravityPricing()
	if invalid.err == nil || invalid.estimate(sample).cost != nil {
		t.Fatal("invalid edit reused an old override or silently fell back")
	}
	if err := os.Remove(service.antigravityPricingPath); err != nil {
		t.Fatal(err)
	}
	restored := service.loadAntigravityPricing().estimate(sample)
	assertReferenceCost(t, *restored.cost, 18.15)
}

func TestAntigravityPricingDashboardAggregatesDatesAndPreservesLedgerBytes(t *testing.T) {
	t.Setenv("TZ", "Asia/Shanghai")
	ledger := agyLedgerFixture(t)
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = ledger
	service.antigravityPricingPath = filepath.Join(t.TempDir(), "no-overrides.json")
	a := antigravityPricingSample("gemini-3.8-flash", "2026-12-31T23:59:59Z", 1000000, 1000000, 1000000, 0)
	b := antigravityPricingSample("gemini-3.8-flash", "2027-01-01T00:00:00Z", 1000000, 1000000, 1000000, 0)
	// Keep test records inside retention regardless of the host clock; only this
	// test's in-memory accounting snapshot is seeded, without writing old dates.
	ledger.samples[a.ID] = a
	ledger.samples[b.ID] = b
	row := antigravityUsageRow("cross-year", []SpeedSample{a, b})
	assertReferenceCost(t, mapValue(row["totals"])["estimatedCostUSD"], 13.725)
	// Real persisted current-date data is priced without rewriting the ledger.
	current := antigravityPricingSample("gemini-4-neon", time.Now().UTC().Format(time.RFC3339), 1000000, 1000000, 1000000, 0)
	if err := ledger.add(current); err != nil {
		t.Fatal(err)
	}
	paths, _ := filepath.Glob(filepath.Join(ledger.directory, "*.jsonl"))
	before, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	report, err := service.antigravityDashboard("monthly", time.Now().In(time.FixedZone("report", 8*3600)).Format("2006-01"))
	if err != nil {
		t.Fatal(err)
	}
	if report["pricingBasis"] != antigravityReferencePriceBasis {
		t.Fatalf("wrong basis: %#v", report)
	}
	after, err := os.ReadFile(paths[0])
	if err != nil || string(before) != string(after) {
		t.Fatal("pricing modified original usage ledger")
	}
	if strings.Contains(string(before), "estimatedCost") {
		t.Fatal("cost was persisted as immutable token accounting")
	}
}

func TestAntigravityReferenceAggregationDistinguishesFreeOverridesAndMixedBasis(t *testing.T) {
	config, err := decodeAntigravityPricingConfig(strings.NewReader(`{"version":1,"models":{"gemini-4-neon":{"inputUSDPerMillion":0,"cachedInputUSDPerMillion":0,"outputUSDPerMillion":0,"cacheWriteUSDPerMillion":0,"effectiveFrom":"2026-12-01","effectiveUntil":"2027-01-01"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	pricing := antigravityPricing{models: config.Models}
	free := antigravityPricingSample("gemini-4-neon", "2026-12-22T01:00:00Z", 1000000, 1000000, 1000000, 1000000)
	zero := mapValue(antigravityPricedUsageRow("zero", []SpeedSample{free}, pricing)["totals"])
	assertReferenceCost(t, zero["estimatedCostUSD"], 0)
	if zero["pricingStatus"] != "complete" || zero["pricingBasis"] != "user-override" || numberInt64(mapValue(zero["pricingCoverage"])["pricedTokens"]) != 4000000 {
		t.Fatalf("explicit free override was unknown or incorrectly attributed: %#v", zero)
	}
	paid := antigravityPricingSample("gemini-3.8-flash", "2026-12-22T01:00:00Z", 1000000, 1000000, 1000000, 0)
	mixed := mapValue(antigravityPricedUsageRow("mixed", []SpeedSample{free, paid}, pricing)["totals"])
	assertReferenceCost(t, mixed["estimatedCostUSD"], 4.575)
	if mixed["pricingBasis"] != "mixed-reference" || mixed["pricingStatus"] != "complete" {
		t.Fatalf("mixed rates were described as official Google prices: %#v", mixed)
	}
	outside := pricing.estimate(antigravityPricingSample("gemini-4-neon", "2027-01-01T00:00:00Z", 1000000, 1000000, 1000000, 0))
	assertReferenceCost(t, *outside.cost, 18.15)
	if outside.basis != antigravityReferencePriceBasis {
		t.Fatal("expired manual override hid applicable built-in reference")
	}
}

func TestAntigravityPricingUsesUTCDateInsideOneLocalReportingDay(t *testing.T) {
	t.Setenv("TZ", "Asia/Shanghai")
	now := time.Now().UTC()
	boundary := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	before := antigravityPricingSample("gemini-4-neon", boundary.Add(-time.Millisecond).Format(time.RFC3339Nano), 1000000, 1000000, 1000000, 0)
	after := antigravityPricingSample("gemini-4-neon", boundary.Format(time.RFC3339Nano), 1000000, 1000000, 1000000, 0)
	ledger := agyLedgerFixture(t)
	if err := ledger.add(before); err != nil {
		t.Fatal(err)
	}
	if err := ledger.add(after); err != nil {
		t.Fatal(err)
	}
	service := NewUsageService()
	defer service.Stop()
	service.antigravityUsage = ledger
	service.antigravityPricingPath = filepath.Join(t.TempDir(), "override.json")
	config := `{"version":1,"models":{"gemini-4-neon":{"inputUSDPerMillion":10,"cachedInputUSDPerMillion":1,"outputUSDPerMillion":20,"effectiveFrom":"` + boundary.Format("2006-01-02") + `"}}}`
	if err := os.WriteFile(service.antigravityPricingPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	report, err := service.antigravityDashboard("monthly", "")
	if err != nil {
		t.Fatal(err)
	}
	assertReferenceCost(t, mapValue(mapValue(report["summary"])["totals"])["estimatedCostUSD"], 49.15)
	days := report["days"].([]map[string]any)
	if len(days) != 1 {
		t.Fatalf("two UTC price dates did not land in one reporting day: %#v", days)
	}
	assertReferenceCost(t, mapValue(days[0]["totals"])["estimatedCostUSD"], 49.15)
	if report["pricingBasis"] != "mixed-reference" || numberInt64(mapValue(mapValue(report["summary"])["totals"])["totalTokens"]) != 6000000 {
		t.Fatal("price dates or model coverage changed usage totals")
	}
}
