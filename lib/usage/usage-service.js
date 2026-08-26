const { CcusageRunner } = require('./ccusage-runner');
const { SOURCES, getUsageSource } = require('./source-catalog');

const SCOPES = new Set(['weekly', 'monthly']);
const CACHE_TTL_MS = 5 * 60 * 1000;

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_error) {
    return 'UTC';
  }
}

function ccusageVersion() {
  try {
    return require('ccusage/package.json').version;
  } catch (_error) {
    return 'unknown';
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isGptModel(modelName) {
  return /^gpt(?:-|$)/i.test(String(modelName || ''));
}

function modelCost(sourceId, modelName, cost) {
  if (sourceId !== 'codex' || !isGptModel(modelName)) return null;
  const value = positiveNumber(cost);
  return value > 0 ? value : null;
}

function normalizeModel(sourceId, breakdown) {
  const uncachedInputTokens = positiveNumber(breakdown.inputTokens)
    + positiveNumber(breakdown.cacheCreationTokens);
  const cachedInputTokens = positiveNumber(breakdown.cacheReadTokens);
  const outputTokens = positiveNumber(breakdown.outputTokens);
  return {
    modelName: String(breakdown.modelName || 'Unknown'),
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: uncachedInputTokens + cachedInputTokens + outputTokens,
    estimatedCostUSD: modelCost(sourceId, breakdown.modelName, breakdown.cost)
  };
}

function sumModels(models) {
  return models.reduce((totals, model) => {
    totals.uncachedInputTokens += model.uncachedInputTokens;
    totals.cachedInputTokens += model.cachedInputTokens;
    totals.outputTokens += model.outputTokens;
    totals.totalTokens += model.totalTokens;
    if (model.estimatedCostUSD !== null) {
      totals.estimatedCostUSD = (totals.estimatedCostUSD || 0) + model.estimatedCostUSD;
    }
    return totals;
  }, {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: null
  });
}

function fallbackModel(sourceId, agentRow) {
  const names = Array.isArray(agentRow.modelsUsed) ? agentRow.modelsUsed : [];
  const modelName = names.length === 1 ? names[0] : names.length > 1 ? 'Multiple models' : 'Unknown';
  return normalizeModel(sourceId, {
    modelName,
    inputTokens: agentRow.inputTokens,
    cacheCreationTokens: agentRow.cacheCreationTokens,
    cacheReadTokens: agentRow.cacheReadTokens,
    outputTokens: agentRow.outputTokens,
    cost: names.length === 1 ? agentRow.totalCost : null
  });
}

function normalizeAgentRow(sourceId, period, agentRow) {
  const breakdowns = Array.isArray(agentRow.modelBreakdowns) ? agentRow.modelBreakdowns : [];
  const models = breakdowns.length
    ? breakdowns.map(item => normalizeModel(sourceId, item))
    : [fallbackModel(sourceId, agentRow)];
  models.sort((a, b) => b.totalTokens - a.totalTokens || a.modelName.localeCompare(b.modelName));
  return { period, models, totals: sumModels(models) };
}

function findAgentRow(row, sourceId) {
  return Array.isArray(row && row.agents)
    ? row.agents.find(agent => agent && agent.agent === sourceId) || null
    : null;
}

function availablePeriods(raw, scope, sourceId) {
  return (raw[scope] || [])
    .filter(row => findAgentRow(row, sourceId))
    .map(row => String(row.period || ''))
    .filter(Boolean)
    .sort()
    .reverse();
}

function dateInsideScope(date, scope, selectedPeriod) {
  if (scope === 'monthly') return date.startsWith(`${selectedPeriod}-`);
  const start = new Date(`${selectedPeriod}T00:00:00Z`);
  const candidate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(candidate.getTime())) return false;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return candidate >= start && candidate < end;
}

function buildDashboard(raw, sourceId, scope, requestedPeriod) {
  const periods = availablePeriods(raw, scope, sourceId);
  const selectedPeriod = periods.includes(requestedPeriod) ? requestedPeriod : periods[0] || null;
  if (!selectedPeriod) {
    return { availablePeriods: [], selectedPeriod: null, summary: { models: [], totals: sumModels([]) }, days: [] };
  }

  const scopeRow = (raw[scope] || []).find(row => row.period === selectedPeriod);
  const summaryAgent = findAgentRow(scopeRow, sourceId);
  const summary = summaryAgent
    ? normalizeAgentRow(sourceId, selectedPeriod, summaryAgent)
    : { models: [], totals: sumModels([]) };
  const days = (raw.daily || [])
    .filter(row => dateInsideScope(String(row.period || ''), scope, selectedPeriod))
    .flatMap(row => {
      const agent = findAgentRow(row, sourceId);
      return agent ? [normalizeAgentRow(sourceId, String(row.period), agent)] : [];
    });
  return { availablePeriods: periods, selectedPeriod, summary, days };
}

class UsageService {
  constructor(options = {}) {
    this.runner = options.runner || null;
    this.timezone = options.timezone || defaultTimezone();
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.logger = options.logger || { debug() {} };
    this.cached = null;
    this.loading = null;
  }

  async getSnapshot(refresh = false) {
    const fresh = this.cached && Date.now() - this.cached.loadedAt < this.cacheTtlMs;
    if (!refresh && fresh) return this.cached;
    if (!refresh && this.cached) {
      this.loadSnapshot().catch(error => this.logger.debug(`Background usage refresh failed: ${error.message}`));
      return this.cached;
    }
    return this.loadSnapshot();
  }

  async loadSnapshot() {
    if (this.loading) return this.loading;
    if (!this.runner) this.runner = new CcusageRunner();
    this.loading = this.runner.loadAllPeriods(this.timezone)
      .then(raw => {
        this.cached = { raw, loadedAt: Date.now(), generatedAt: new Date().toISOString() };
        return this.cached;
      })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  async listSources(refresh = false) {
    const snapshot = await this.getSnapshot(refresh);
    const present = new Set();
    for (const scope of ['daily', 'weekly', 'monthly']) {
      for (const row of snapshot.raw[scope] || []) {
        for (const agent of row.agents || []) present.add(agent.agent);
      }
    }
    return {
      sources: SOURCES.filter(source => present.has(source.id)),
      generatedAt: snapshot.generatedAt,
      timezone: this.timezone,
      engine: { name: 'ccusage', version: ccusageVersion(), pricingMode: 'embedded' }
    };
  }

  async getDashboard(sourceId, scope, selectedPeriod, refresh = false) {
    const source = getUsageSource(sourceId);
    if (!source) {
      const error = new Error('Unsupported usage source');
      error.statusCode = 400;
      throw error;
    }
    if (!SCOPES.has(scope)) {
      const error = new Error('Scope must be weekly or monthly');
      error.statusCode = 400;
      throw error;
    }
    const snapshot = await this.getSnapshot(refresh);
    return {
      source,
      scope,
      ...buildDashboard(snapshot.raw, source.id, scope, selectedPeriod),
      generatedAt: snapshot.generatedAt,
      timezone: this.timezone,
      engine: { name: 'ccusage', version: ccusageVersion(), pricingMode: 'embedded' },
      cost: source.id === 'codex' ? {
        basis: 'ccusage estimate for Codex GPT models',
        note: 'Estimated from ccusage model pricing; it is not an actual provider bill.'
      } : null
    };
  }
}

module.exports = {
  UsageService,
  availablePeriods,
  buildDashboard,
  dateInsideScope,
  isGptModel,
  modelCost,
  normalizeAgentRow,
  normalizeModel,
  sumModels
};
