package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const antigravityReferencePriceSource = "https://aistudio.google.com/docs/pricing"
const antigravityReferencePriceBasis = "google-developer-api-standard-reference"
const maxAntigravityPricingConfigBytes = 1 << 20

// Flat, exact-model prices only. Root-turn counters cannot determine the input
// size of individual requests, so this adapter does not infer context tiers.
type antigravityPriceOverride struct {
	Input          *float64 `json:"inputUSDPerMillion"`
	Cached         *float64 `json:"cachedInputUSDPerMillion"`
	Output         *float64 `json:"outputUSDPerMillion"`
	Write          *float64 `json:"cacheWriteUSDPerMillion,omitempty"`
	EffectiveFrom  string   `json:"effectiveFrom,omitempty"`
	EffectiveUntil string   `json:"effectiveUntil,omitempty"`
	from, until    time.Time
}
type antigravityPricingConfig struct {
	Version int                                 `json:"version"`
	Models  map[string]antigravityPriceOverride `json:"models"`
}
type antigravityPricing struct {
	models map[string]antigravityPriceOverride
	err    error
}
type antigravityPrice struct {
	input, cached, output float64
	write                 *float64
	basis                 string
}
type antigravityPriceEstimate struct {
	cost         *float64
	pricedTokens int64
	fullyPriced  bool
	basis        string
	reason       string
}

func (service *UsageService) loadAntigravityPricing() antigravityPricing {
	filename := service.antigravityPricingPath
	if filename == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return antigravityPricing{err: err}
		}
		filename = filepath.Join(home, ".glad", "antigravity-pricing.json")
	}
	info, err := os.Stat(filename)
	if errors.Is(err, os.ErrNotExist) {
		return antigravityPricing{}
	}
	if err != nil {
		return antigravityPricing{err: fmt.Errorf("cannot read Antigravity pricing configuration: %w", err)}
	}
	if !info.Mode().IsRegular() || info.Size() > maxAntigravityPricingConfigBytes {
		return antigravityPricing{err: errors.New("Antigravity pricing configuration must be a regular file no larger than 1 MiB")}
	}
	file, err := os.Open(filename)
	if errors.Is(err, os.ErrNotExist) {
		return antigravityPricing{}
	}
	if err != nil {
		return antigravityPricing{err: fmt.Errorf("cannot read Antigravity pricing configuration: %w", err)}
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxAntigravityPricingConfigBytes+1))
	if err != nil {
		return antigravityPricing{err: err}
	}
	if len(data) > maxAntigravityPricingConfigBytes {
		return antigravityPricing{err: errors.New("Antigravity pricing configuration exceeds 1 MiB")}
	}
	config, err := decodeAntigravityPricingConfig(strings.NewReader(string(data)))
	if err != nil {
		return antigravityPricing{err: fmt.Errorf("invalid Antigravity pricing configuration: %w", err)}
	}
	return antigravityPricing{models: config.Models}
}

func decodeAntigravityPricingConfig(reader io.Reader) (antigravityPricingConfig, error) {
	var config antigravityPricingConfig
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return config, errors.New("expected exactly one JSON object")
	}
	if config.Version != 1 || config.Models == nil || len(config.Models) > 256 {
		return config, errors.New("version must be 1 and models must be an object with at most 256 entries")
	}
	for model, price := range config.Models {
		if model == "" || len(model) > 256 || strings.TrimSpace(model) != model || strings.ContainsAny(model, "\x00\r\n\t") {
			return config, errors.New("invalid exact model ID")
		}
		if price.Input == nil || price.Cached == nil || price.Output == nil {
			return config, fmt.Errorf("%s requires input, cached-input and output USD-per-million rates", model)
		}
		for _, value := range []*float64{price.Input, price.Cached, price.Output, price.Write} {
			if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0) {
				return config, fmt.Errorf("%s rates must be finite, nonnegative numbers", model)
			}
		}
		for _, field := range []struct {
			text   string
			target *time.Time
		}{{price.EffectiveFrom, &price.from}, {price.EffectiveUntil, &price.until}} {
			if field.text != "" {
				date, err := time.Parse("2006-01-02", field.text)
				if err != nil {
					return config, fmt.Errorf("%s effective dates must use YYYY-MM-DD", model)
				}
				*field.target = date
			}
		}
		if !price.from.IsZero() && !price.until.IsZero() && !price.from.Before(price.until) {
			return config, fmt.Errorf("%s effectiveUntil must be later than effectiveFrom", model)
		}
		config.Models[model] = price
	}
	return config, nil
}

func (pricing antigravityPricing) price(model string, endedAt int64) (antigravityPrice, bool) {
	if pricing.err != nil || endedAt <= 0 {
		return antigravityPrice{}, false
	}
	at := time.UnixMilli(endedAt).UTC()
	if override, exists := pricing.models[model]; exists && (override.from.IsZero() || !at.Before(override.from)) && (override.until.IsZero() || at.Before(override.until)) {
		return antigravityPrice{input: *override.Input, cached: *override.Cached, output: *override.Output, write: override.Write, basis: "user-override"}, true
	}
	// Official Gemini Developer API Standard prices, verified 2026-11-22.
	// These are reference prices, not Cloud credits or subscription charges.
	switch model {
	case "gemini-4-neon":
		return antigravityPrice{input: 3, cached: 0.15, output: 15, basis: antigravityReferencePriceBasis}, true
	case "gemini-3.8-flash":
		price := antigravityPrice{input: 0.75, cached: 0.075, output: 3.75, basis: antigravityReferencePriceBasis}
		if !at.Before(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)) {
			price.input = 1.5
			price.cached = 0.15
			price.output = 7.5
		}
		return price, true
	default:
		return antigravityPrice{}, false
	}
}

func (pricing antigravityPricing) estimate(sample SpeedSample) antigravityPriceEstimate {
	if !antigravityUsageKnown(sample) {
		return antigravityPriceEstimate{reason: "missing-token-counts"}
	}
	price, known := pricing.price(sample.Model, sample.EndedAt)
	if !known {
		reason := "unknown-exact-model"
		if pricing.err != nil {
			reason = "invalid-pricing-configuration"
		}
		return antigravityPriceEstimate{reason: reason}
	}
	cost := (float64(*sample.InputTokens)*price.input + float64(*sample.CachedInputTokens)*price.cached + float64(*sample.OutputTokens)*price.output) / 1e6
	pricedTokens := *sample.InputTokens + *sample.CachedInputTokens + *sample.OutputTokens
	fullyPriced := true
	reason := ""
	if *sample.CacheWriteTokens > 0 {
		if price.write == nil {
			fullyPriced = false
			reason = "unknown-cache-write-price"
		} else {
			cost += float64(*sample.CacheWriteTokens) * *price.write / 1e6
			pricedTokens += *sample.CacheWriteTokens
		}
	}
	if math.IsInf(cost, 0) || math.IsNaN(cost) {
		return antigravityPriceEstimate{reason: "invalid-price-calculation"}
	}
	return antigravityPriceEstimate{cost: &cost, pricedTokens: pricedTokens, fullyPriced: fullyPriced, basis: price.basis, reason: reason}
}

// Coverage is calculated from the complete selected-period ledger, independently
// of model-table or chart presentation. Unknown components never become free.
type antigravityPriceCoverage struct {
	cost                      float64
	hasCost                   bool
	pricedTokens, totalTokens int64
	complete, samples         int
	reasons                   map[string]int
	bases                     map[string]bool
}

func (coverage *antigravityPriceCoverage) add(sample SpeedSample, estimate antigravityPriceEstimate) {
	if coverage.reasons == nil {
		coverage.reasons = map[string]int{}
		coverage.bases = map[string]bool{}
	}
	coverage.samples++
	coverage.totalTokens += *sample.InputTokens + *sample.CachedInputTokens + *sample.CacheWriteTokens + *sample.OutputTokens
	coverage.pricedTokens += estimate.pricedTokens
	if estimate.cost != nil {
		coverage.cost += *estimate.cost
		coverage.hasCost = true
		coverage.bases[estimate.basis] = true
	}
	if estimate.fullyPriced {
		coverage.complete++
	}
	if estimate.reason != "" {
		coverage.reasons[estimate.reason]++
	}
}
func (coverage *antigravityPriceCoverage) decorate(row map[string]any) {
	status := "unavailable"
	var cost any
	if coverage.hasCost {
		cost = coverage.cost
		status = "complete"
		if coverage.complete != coverage.samples {
			status = "partial"
		}
	}
	basis := "unavailable"
	for value := range coverage.bases {
		if basis == "unavailable" {
			basis = value
		} else {
			basis = "mixed-reference"
			break
		}
	}
	row["estimatedCostUSD"] = cost
	row["pricingStatus"] = status
	row["missingPricing"] = status != "complete"
	row["pricingBasis"] = basis
	row["pricingCoverage"] = map[string]any{"pricedTokens": coverage.pricedTokens, "totalTokens": coverage.totalTokens, "fullyPricedSamples": coverage.complete, "tokenKnownSamples": coverage.samples, "unpricedReasons": coverage.reasons}
	if basis == antigravityReferencePriceBasis {
		row["priceSource"] = antigravityReferencePriceSource
	} else if basis == "user-override" {
		row["priceSource"] = "User-configured flat reference rates"
	} else if basis == "mixed-reference" {
		row["priceSource"] = "Google Developer API Standard and user-configured flat reference rates"
	}
}
