const MODEL_ALIASES = new Set(['default', 'env', 'sonnet', 'opus', 'haiku']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function cleanEnvValue(value) {
  const text = String(value || '').trim();
  return text || null;
}

function readClaudeEnv(env = process.env) {
  return {
    anthropicModel: cleanEnvValue(env.ANTHROPIC_MODEL),
    sonnetModel: cleanEnvValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    opusModel: cleanEnvValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    haikuModel: cleanEnvValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    subagentModel: cleanEnvValue(env.CLAUDE_CODE_SUBAGENT_MODEL),
    effort: normalizeEffort(env.CLAUDE_CODE_EFFORT_LEVEL)
  };
}

function normalizeModel(value, env = process.env) {
  const model = String(value || '').trim();
  if (model) return model;
  return readClaudeEnv(env).anthropicModel ? 'env' : 'sonnet';
}

function normalizeEffort(value, env = process.env) {
  const effort = String(value || '').trim().toLowerCase();
  if (EFFORT_LEVELS.has(effort)) return effort;
  const envEffort = String(env.CLAUDE_CODE_EFFORT_LEVEL || '').trim().toLowerCase();
  return EFFORT_LEVELS.has(envEffort) ? envEffort : 'medium';
}

function resolveClaudeModel(value, env = process.env) {
  const selected = normalizeModel(value, env);
  const config = readClaudeEnv(env);
  if (selected === 'default') return undefined;
  if (selected === 'env') return config.anthropicModel || undefined;
  if (selected === 'sonnet') return config.sonnetModel || 'sonnet';
  if (selected === 'opus') return config.opusModel || 'opus';
  if (selected === 'haiku') return config.haikuModel || 'haiku';
  return selected;
}

function modelOption(value, label, resolved, source) {
  return {
    value,
    label,
    resolved: resolved || null,
    source
  };
}

function getClaudeRuntimeConfig(env = process.env) {
  const config = readClaudeEnv(env);
  const options = [
    modelOption('default', 'Default', null, 'Claude default')
  ];
  if (config.anthropicModel) {
    options.push(modelOption('env', 'Env', config.anthropicModel, 'ANTHROPIC_MODEL'));
  }
  options.push(
    modelOption('sonnet', 'Sonnet', config.sonnetModel || 'sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'),
    modelOption('opus', 'Opus', config.opusModel || 'opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'),
    modelOption('haiku', 'Haiku', config.haikuModel || 'haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
  );

  return {
    defaultModel: config.anthropicModel ? 'env' : 'sonnet',
    defaultEffort: config.effort,
    models: options,
    env: config
  };
}

module.exports = {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  getClaudeRuntimeConfig,
  normalizeEffort,
  normalizeModel,
  resolveClaudeModel
};
