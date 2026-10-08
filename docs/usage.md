# Usage and model-price estimates

Glad uses ccusage 20.0.26 to read local Codex and Claude usage history. Costs are model-price estimates, not provider invoices or subscription charges. A model without pricing is shown as **Unknown**. If only some models have prices, the total is a **Known-price estimate** and lists the excluded models. If no model has a price, Glad shows **Cannot estimate**. A known zero cost remains $0.

## Price downloads

The default is online-preferred pricing. ccusage downloads public price catalogs from LiteLLM and, when needed, models.dev. It does not upload usage history. If downloading fails, ccusage can continue with its built-in prices. Glad describes the selected policy rather than claiming that a download succeeded; missing prices are reported separately.

Enable **Only offline** in the usage source picker or dashboard to skip price downloads. Glad persists this preference in its own configuration. Changing it recomputes the report. The previous report remains visible with a notice until the new setting has been applied; an older in-flight result cannot overwrite the new setting.

## Background refresh

Glad warms the report in the background after startup and refreshes it every 30 minutes. Opening usage returns the last successful report immediately; if it is older than one minute, a background refresh starts. Before the first report is ready, the interface shows that it is reading usage for the first time.

The refresh button starts a refresh immediately when idle. Concurrent requests share one refresh. Each engine run has a two-minute timeout and belongs to the daemon, so closing the panel or disconnecting the browser does not cancel it. A refresh failure preserves the previous report and its original timestamp while displaying the error. Polling stops when the update completes or the panel closes. Installations without a ccusage binary skip periodic refresh work.

Report caches are held only in memory and are lost when Glad stops. No report-cache file is written.

## Optional price overrides

If `~/.glad/ccusage.json` exists, Glad passes it to ccusage using `--config`. This replaces ccusage's automatic configuration discovery: existing ccusage configuration in other locations is not loaded. When this file does not exist, Glad leaves automatic discovery unchanged. Glad validates this explicit file against the pinned ccusage 20.0.26 configuration rules before refreshing: some ccusage JSON-mode releases silently ignore malformed settings. Syntax and type errors are shown, while errors returned by the engine are preserved. Neither kind of configuration failure is treated as a failed price download.

For example, this JSON uses placeholder per-token prices for a private model:

```json
{
  "defaults": {
    "pricingOverrides": {
      "my-private-model": {
        "inputCostPerToken": 0.000002,
        "outputCostPerToken": 0.00001,
        "cacheReadInputTokenCost": 0.0000001
      }
    }
  }
}
```

Use the exact model label from your report and replace the example values with the applicable rates. Keep user-managed overrides up to date when prices change. Overrides apply in both pricing policies. See [ccusage's configuration documentation](https://ccusage.com/guide/config-files#pricing-overrides) for the supported fields, including tiered and fast-mode pricing.

## Maintaining the pinned engine and schema

When upgrading ccusage, update `package.json`, `package-lock.json`, the platform package dependencies, and `usageVersion` in `internal/app/usage.go`. Regenerate `internal/app/ccusage_config_schema.json` from the official package for that same version:

```sh
node scripts/update-ccusage-schema.js
go test ./...
```

The generator reads `node_modules/ccusage` by default. To avoid replacing dependencies used by a running instance, pass an isolated official package directory instead:

```sh
node scripts/update-ccusage-schema.js /path/to/isolated/ccusage/package
```

The schema records `ccusageVersion`. A Go test requires it to match both `usageVersion` and the pinned package dependency, and fails with “升级 ccusage 时请同步 ccusage_config_schema.json” if they diverge. The generator rejects a mismatched source package or newly introduced validation keywords; update the generator and Go validator together when upstream adds unsupported rules.
