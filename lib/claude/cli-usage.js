function stripTerminalFormatting(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function parseTokenCount(value) {
  const text = String(value || '').trim().replace(/,/g, '');
  const match = text.match(/^([\d.]+)\s*([kmb])?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[String(match[2] || '').toLowerCase()] || 1;
  return Math.round(amount * multiplier);
}

function parseClaudeUsageOutput(output) {
  const text = stripTerminalFormatting(output);
  const cost = text.match(/Total cost:\s*\$([\d,.]+)/i);
  const apiDuration = text.match(/Total duration \(API\):\s*([^\n]+)/i);
  const wallDuration = text.match(/Total duration \(wall\):\s*([^\n]+)/i);
  const codeChanges = text.match(/Total code changes:\s*([\d,]+) lines added,\s*([\d,]+) lines removed/i);
  const tokens = text.match(/Usage:\s*([\d,.kmb]+) input,\s*([\d,.kmb]+) output,\s*([\d,.kmb]+) cache read,\s*([\d,.kmb]+) cache write/i);
  const models = [];
  const modelPattern = /^\s*(.+?):\s*([\d,.kmb]+) input,\s*([\d,.kmb]+) output,\s*([\d,.kmb]+) cache read,\s*([\d,.kmb]+) cache write(?:\s*\(\$([\d,.]+)\))?\s*$/gim;
  for (const match of text.matchAll(modelPattern)) {
    if (/^Usage$/i.test(match[1].trim())) continue;
    models.push({
      model: match[1].trim(),
      inputTokens: parseTokenCount(match[2]),
      outputTokens: parseTokenCount(match[3]),
      cacheReadTokens: parseTokenCount(match[4]),
      cacheWriteTokens: parseTokenCount(match[5]),
      costUsd: match[6] ? Number(match[6].replace(/,/g, '')) : null
    });
  }

  if (!cost && !apiDuration && !wallDuration && !codeChanges && !tokens && models.length === 0) {
    throw new Error('Claude CLI returned an unrecognized /usage response');
  }

  const totalModelValue = key => models.length > 0
    ? models.reduce((sum, model) => sum + Number(model[key] || 0), 0)
    : null;

  return {
    totalCostUsd: cost ? Number(cost[1].replace(/,/g, '')) : null,
    apiDuration: apiDuration ? apiDuration[1].trim() : null,
    wallDuration: wallDuration ? wallDuration[1].trim() : null,
    linesAdded: codeChanges ? Number(codeChanges[1].replace(/,/g, '')) : null,
    linesRemoved: codeChanges ? Number(codeChanges[2].replace(/,/g, '')) : null,
    inputTokens: tokens ? parseTokenCount(tokens[1]) : totalModelValue('inputTokens'),
    outputTokens: tokens ? parseTokenCount(tokens[2]) : totalModelValue('outputTokens'),
    cacheReadTokens: tokens ? parseTokenCount(tokens[3]) : totalModelValue('cacheReadTokens'),
    cacheWriteTokens: tokens ? parseTokenCount(tokens[4]) : totalModelValue('cacheWriteTokens'),
    models
  };
}

function parseClaudeContextOutput(output) {
  const text = stripTerminalFormatting(output);
  const model = text.match(/^\*\*Model:\*\*\s*(.+?)\s*$/mi);
  const tokens = text.match(/^\*\*Tokens:\*\*\s*([\d,.]+\s*[kmb]?)\s*\/\s*([\d,.]+\s*[kmb]?)\s*\(([\d.]+)%\)/mi);
  if (!tokens) throw new Error('Claude CLI returned an unrecognized /context response');

  const usedTokens = parseTokenCount(tokens[1]);
  const maxTokens = parseTokenCount(tokens[2]);
  const categories = [];
  for (const line of text.split('\n')) {
    const columns = line.split('|').slice(1, -1).map(value => value.trim());
    if (columns.length < 3 || !columns[0] || /^category$/i.test(columns[0]) || /^-+$/.test(columns[0])) continue;
    const categoryTokens = parseTokenCount(columns[1]);
    if (categoryTokens == null || !/^<?[\d.]+%$/.test(columns[2])) continue;
    categories.push({
      label: columns[0].replace(/\*\*/g, ''),
      tokens: categoryTokens,
      percent: columns[2]
    });
  }

  return {
    model: model ? model[1].trim() : null,
    usedTokens,
    maxTokens,
    usedPercent: Number(tokens[3]),
    remainingTokens: usedTokens == null || maxTokens == null ? null : Math.max(0, maxTokens - usedTokens),
    categories
  };
}

module.exports = {
  parseClaudeContextOutput,
  parseClaudeUsageOutput,
  parseTokenCount
};
