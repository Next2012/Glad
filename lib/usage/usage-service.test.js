const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { reportArgs, resolveCcusageBinary } = require('./ccusage-runner');
const {
  UsageService,
  buildDashboard,
  dateInsideScope,
  modelCost,
  normalizeAgentRow,
  normalizeModel
} = require('./usage-service');

function model(modelName, input, cached, output, cost, cacheCreation = 0) {
  return {
    modelName,
    inputTokens: input,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cached,
    outputTokens: output,
    cost
  };
}

function agent(name, models) {
  return {
    agent: name,
    modelsUsed: models.map(item => item.modelName),
    modelBreakdowns: models
  };
}

function fixtureReport() {
  const aprilCodex = agent('codex', [
    model('gpt-5.6-sol', 100, 200, 30, 0.5, 4),
    model('deepseek-v4-pro', 10, 0, 2, 0.7)
  ]);
  const mayCodex = agent('codex', [model('gpt-5.5', 70, 80, 9, 0.2)]);
  const claude = agent('claude', [model('claude-test', 10, 40, 5, 2, 20)]);
  return {
    daily: [
      { period: '2026-04-27', agents: [aprilCodex] },
      { period: '2026-04-30', agents: [aprilCodex, claude] },
      { period: '2026-05-01', agents: [mayCodex] },
      { period: '2026-05-04', agents: [mayCodex] }
    ],
    weekly: [
      { period: '2026-04-27', agents: [aprilCodex, claude] },
      { period: '2026-05-04', agents: [mayCodex] }
    ],
    monthly: [
      { period: '2026-04', agents: [aprilCodex, claude] },
      { period: '2026-05', agents: [mayCodex] }
    ]
  };
}

test('normalizes ccusage model token buckets without recalculating its cost', () => {
  const row = normalizeModel('codex', model('gpt-5.6-sol', 10, 40, 5, 1.2345, 20));
  assert.deepEqual(row, {
    modelName: 'gpt-5.6-sol',
    uncachedInputTokens: 30,
    cachedInputTokens: 40,
    outputTokens: 5,
    totalTokens: 75,
    estimatedCostUSD: 1.2345
  });
});

test('exposes ccusage cost only for GPT models used by Codex', () => {
  assert.equal(modelCost('codex', 'gpt-5.6-sol', 1.25), 1.25);
  assert.equal(modelCost('codex', 'deepseek-v4-pro', 2), null);
  assert.equal(modelCost('opencode', 'gpt-5.6-sol', 3), null);
  assert.equal(modelCost('codex', 'gpt-unknown', 0), null);
});

test('builds a selected month with per-model totals and daily details', () => {
  const dashboard = buildDashboard(fixtureReport(), 'codex', 'monthly', '2026-04');
  assert.equal(dashboard.selectedPeriod, '2026-04');
  assert.deepEqual(dashboard.availablePeriods, ['2026-05', '2026-04']);
  assert.equal(dashboard.summary.models.length, 2);
  assert.equal(dashboard.summary.totals.totalTokens, 346);
  assert.equal(dashboard.summary.totals.estimatedCostUSD, 0.5);
  assert.deepEqual(dashboard.days.map(day => day.period), ['2026-04-27', '2026-04-30']);
  assert.equal(dashboard.days[0].totals.estimatedCostUSD, 0.5);
});

test('uses a seven-day boundary for selected week details', () => {
  assert.equal(dateInsideScope('2026-04-27', 'weekly', '2026-04-27'), true);
  assert.equal(dateInsideScope('2026-05-03', 'weekly', '2026-04-27'), true);
  assert.equal(dateInsideScope('2026-05-04', 'weekly', '2026-04-27'), false);
  const dashboard = buildDashboard(fixtureReport(), 'codex', 'weekly', '2026-04-27');
  assert.deepEqual(dashboard.days.map(day => day.period), ['2026-04-27', '2026-04-30', '2026-05-01']);
});

test('sorts normalized models by total token usage', () => {
  const row = normalizeAgentRow('codex', '2026-04', agent('codex', [
    model('gpt-small', 1, 2, 3, 0.1),
    model('gpt-large', 100, 200, 30, 0.5)
  ]));
  assert.deepEqual(row.models.map(item => item.modelName), ['gpt-large', 'gpt-small']);
  assert.equal(row.totals.totalTokens, 336);
  assert.equal(row.totals.estimatedCostUSD, 0.6);
});

test('does not assign a mixed fallback cost to a GPT model', () => {
  const row = normalizeAgentRow('codex', '2026-04', {
    agent: 'codex',
    modelsUsed: ['gpt-5.6-sol', 'deepseek-v4-pro'],
    inputTokens: 10,
    cacheReadTokens: 20,
    outputTokens: 5,
    totalCost: 4.5
  });

  assert.equal(row.models[0].modelName, 'Multiple models');
  assert.equal(row.models[0].estimatedCostUSD, null);
  assert.equal(row.totals.estimatedCostUSD, null);
});

test('caches one ccusage load across source and dashboard requests', async () => {
  let calls = 0;
  const runner = {
    async loadAllPeriods(timezone) {
      calls += 1;
      assert.equal(timezone, 'Asia/Shanghai');
      return fixtureReport();
    }
  };
  const service = new UsageService({ runner, timezone: 'Asia/Shanghai', cacheTtlMs: 60000 });

  const sources = await service.listSources();
  const dashboard = await service.getDashboard('codex', 'monthly', '2026-04');

  assert.equal(calls, 1);
  assert.deepEqual(sources.sources.map(source => source.id), ['codex', 'claude']);
  assert.equal(dashboard.selectedPeriod, '2026-04');
  assert.match(dashboard.cost.basis, /ccusage/);

  await service.getDashboard('codex', 'weekly', '2026-04-27', true);
  assert.equal(calls, 2);
});

test('serves a stale snapshot immediately while refreshing it in the background', async () => {
  let calls = 0;
  let releaseRefresh;
  const runner = {
    async loadAllPeriods() {
      calls += 1;
      if (calls === 1) return fixtureReport();
      return new Promise(resolve => { releaseRefresh = resolve; });
    }
  };
  const service = new UsageService({ runner, cacheTtlMs: 1 });
  await service.listSources();
  service.cached.loadedAt = 0;

  const dashboard = await service.getDashboard('codex', 'monthly', '2026-04');

  assert.equal(dashboard.selectedPeriod, '2026-04');
  assert.equal(calls, 2);
  releaseRefresh(fixtureReport());
  await service.loading;
});

test('rejects unsupported sources and scopes', async () => {
  const service = new UsageService({ runner: { loadAllPeriods: async () => fixtureReport() } });
  await assert.rejects(service.getDashboard('unknown', 'weekly'), /Unsupported usage source/);
  await assert.rejects(service.getDashboard('codex', 'daily'), /Scope must be/);
});

test('resolves the installed native ccusage engine without a shell wrapper', () => {
  const binary = resolveCcusageBinary();
  assert.equal(fs.existsSync(binary), true);
  assert.match(binary, /ccusage/);
});

test('uses ccusage embedded pricing for fast local report loads', () => {
  const args = reportArgs('Asia/Shanghai');
  assert.equal(args.includes('--offline'), true);
  assert.deepEqual(args.slice(-2), ['--timezone', 'Asia/Shanghai']);
});
