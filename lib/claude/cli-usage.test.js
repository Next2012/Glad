const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseClaudeContextOutput,
  parseClaudeUsageOutput
} = require('./cli-usage');

const USAGE_OUTPUT = `Total cost:            $1.2500
Total duration (API):  1m 2s
Total duration (wall): 3m 4s
Total code changes:    8 lines added, 3 lines removed
Usage:                 1,200 input, 240 output, 30.5k cache read, 40 cache write
`;

const CONTEXT_OUTPUT = `## Context Usage
**Model:** claude-sonnet-4-5-20250929
**Tokens:** 36.1k / 200k (18%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.5k | 1.3% |
| Messages | 33.6k | 16.8% |
`;

test('parses Claude CLI /usage session values', () => {
  assert.deepEqual(parseClaudeUsageOutput(USAGE_OUTPUT), {
    totalCostUsd: 1.25,
    apiDuration: '1m 2s',
    wallDuration: '3m 4s',
    linesAdded: 8,
    linesRemoved: 3,
    inputTokens: 1200,
    outputTokens: 240,
    cacheReadTokens: 30500,
    cacheWriteTokens: 40,
    models: []
  });
});

test('parses current Claude CLI usage grouped by model', () => {
  const usage = parseClaudeUsageOutput(`Total cost:            $0.1273 (costs may be inaccurate due to usage of unknown models)
Total duration (API):  6s
Total duration (wall): 4s
Total code changes:    0 lines added, 0 lines removed
Usage by model:
 deepseek-v4-pro[1m]:  25.1k input, 77 output, 0 cache read, 0 cache write ($0.1273)`);

  assert.equal(usage.inputTokens, 25100);
  assert.equal(usage.outputTokens, 77);
  assert.deepEqual(usage.models, [{
    model: 'deepseek-v4-pro[1m]',
    inputTokens: 25100,
    outputTokens: 77,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.1273
  }]);
});

test('parses Claude CLI /context totals and category breakdown', () => {
  assert.deepEqual(parseClaudeContextOutput(CONTEXT_OUTPUT), {
    model: 'claude-sonnet-4-5-20250929',
    usedTokens: 36100,
    maxTokens: 200000,
    usedPercent: 18,
    remainingTokens: 163900,
    categories: [
      { label: 'System prompt', tokens: 2500, percent: '1.3%' },
      { label: 'Messages', tokens: 33600, percent: '16.8%' }
    ]
  });
});
