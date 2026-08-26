const SOURCES = [
  { id: 'codex', label: 'Codex', badge: 'CX' },
  { id: 'claude', label: 'Claude', badge: 'CL' },
  { id: 'gemini', label: 'Gemini', badge: 'GE' },
  { id: 'opencode', label: 'OpenCode', badge: 'OC' },
  { id: 'copilot', label: 'Copilot', badge: 'CP' },
  { id: 'amp', label: 'Amp', badge: 'AM' },
  { id: 'droid', label: 'Droid', badge: 'DR' },
  { id: 'codebuff', label: 'Codebuff', badge: 'CB' },
  { id: 'hermes', label: 'Hermes', badge: 'HE' },
  { id: 'pi', label: 'Pi', badge: 'PI' },
  { id: 'goose', label: 'Goose', badge: 'GO' },
  { id: 'kilo', label: 'Kilo', badge: 'KI' },
  { id: 'kimi', label: 'Kimi', badge: 'KM' },
  { id: 'qwen', label: 'Qwen', badge: 'QW' },
  { id: 'openclaw', label: 'OpenClaw', badge: 'OA' },
  { id: 'grok', label: 'Grok', badge: 'GR' }
];

const SOURCE_BY_ID = new Map(SOURCES.map(source => [source.id, source]));

function getUsageSource(id) {
  return SOURCE_BY_ID.get(String(id || '').toLowerCase()) || null;
}

module.exports = { SOURCES, getUsageSource };
