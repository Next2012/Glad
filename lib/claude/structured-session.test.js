const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeStructuredSession = require('./structured-session');
const ClaudeTranscriptRepository = require('./transcript-repository');

function createSession(overrides = {}) {
  return new ClaudeStructuredSession({
    id: 'test-claude-session',
    tool: { key: 'claude-code', displayName: 'Claude Code', command: 'claude' },
    workingDir: '/tmp',
    name: 'Test Claude',
    logger: {},
    ...overrides
  });
}

test('exposes the tool use id so a Claude approval can render inline', async () => {
  const session = createSession();
  const events = [];
  session.on('event', event => events.push(event));

  const response = session.requestPermission('Bash', { command: 'npm test' }, { toolUseID: 'tool-use-1' });
  const request = events.find(event => event.type === 'permission-request').request;

  assert.equal(request.toolUseId, 'tool-use-1');
  assert.equal(request.status, 'pending');
  assert.equal(session.respondPermission(request.id, false, 'deny'), true);
  assert.equal((await response).behavior, 'deny');
});

test('tracks Claude turn and tool completion without leaving tools running', () => {
  const session = createSession();
  session.startRunner = () => {};

  assert.equal(session.sendUserMessage('run the tests'), true);
  const turn = session.currentTurn();
  assert.ok(turn?.id);
  assert.equal(session.status, 'thinking');

  session.handleSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] }
  });
  session.handleSdkMessage({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'passed', is_error: false }] }
  });
  session.handleSdkMessage({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1250 });

  const tool = session.messages.find(item => item.kind === 'tool');
  const result = session.messages.find(item => item.kind === 'tool-result');
  const turnEnd = session.messages.find(item => item.kind === 'turn-end');
  assert.equal(tool.turnId, turn.id);
  assert.equal(result.turnId, turn.id);
  assert.equal(turnEnd.turnId, turn.id);
  assert.equal(turnEnd.turnStatus, 'completed');
  assert.equal(turnEnd.durationMs, 1250);
  assert.equal(session.status, 'idle');
  assert.equal(session.currentTurn(), null);
});

test('sends Claude image blocks without exposing base64 in display history', () => {
  const session = createSession();
  let sdkMessage = null;
  session.startRunner = message => { sdkMessage = message; };

  assert.equal(session.sendUserMessage('describe this', [{
    name: 'diagram.png', size: 128, mediaType: 'image/png', data: 'aGVsbG8='
  }]), true);

  assert.deepEqual(sdkMessage.message.content, [
    { type: 'text', text: 'describe this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  ]);
  const user = session.messages.find(item => item.kind === 'user');
  assert.deepEqual(user.attachments, [{ name: 'diagram.png', size: 128 }]);
  assert.equal(JSON.stringify(user).includes('aGVsbG8='), false);
});

test('parses manual /usage and /context output without the experimental SDK usage API', async () => {
  const requests = [];
  const session = createSession({
    options: { resume: 'claude-session-123' },
    localCommandRunner: async command => {
      requests.push(command);
      if (command === '/usage') return `Total cost: $0.5000
Total duration (API): 1s
Total duration (wall): 2s
Total code changes: 0 lines added, 0 lines removed
Usage: 100 input, 20 output, 30 cache read, 0 cache write`;
      return `## Context Usage
**Model:** claude-sonnet
**Tokens:** 36.1k / 200k (18%)`;
    }
  });

  assert.equal(await session.showUsage(), true);
  assert.equal(await session.showContext(), true);
  assert.equal(session.runnerStarted, false);
  assert.deepEqual(requests, ['/usage', '/context']);
  const usageMessage = session.messages.find(item => item.kind === 'usage');
  const contextMessage = session.messages.find(item => item.kind === 'context');
  assert.equal(usageMessage.usage.session.totalCostUsd, 0.5);
  assert.equal(contextMessage.context.usedTokens, 36100);
  assert.equal(contextMessage.context.maxTokens, 200000);
  assert.equal('latestUsage' in session.getControlState(), false);
});

test('sends a local slash command through the current Claude CLI stream', async () => {
  const session = createSession();
  let sent = null;
  session.startRunner = async () => {
    session.inputQueue = {
      push(message) {
        sent = message;
        queueMicrotask(() => session.handleSdkMessage({
          type: 'system',
          subtype: 'local_command_output',
          content: `Total cost: $0.0000
Total duration (API): 0s
Total duration (wall): 0s
Total code changes: 0 lines added, 0 lines removed
Usage: 0 input, 0 output, 0 cache read, 0 cache write`
        }));
      }
    };
    return {};
  };

  assert.equal(await session.showUsage(), true);
  assert.equal(sent.message.content, '/usage');
  assert.equal(session.messages.find(item => item.kind === 'usage').usage.source, 'claude-cli-command');
});

test('takes manual slash command text from the CLI result without ending the runner', async () => {
  const session = createSession();
  session.pendingLocalCommand = {
    command: '/context',
    resolve: output => { session.localOutput = output; },
    reject: () => assert.fail('command should not fail')
  };
  session.runnerStarted = true;
  session.activeOptionSignature = 'old-options';

  session.handleSdkMessage({ type: 'assistant', message: { content: [] } });
  session.handleSdkMessage({ type: 'result', subtype: 'success', result: '## Context Usage' });

  assert.equal(session.localOutput, '## Context Usage');
  assert.equal(session.runnerStarted, true);
  assert.equal(session.status, 'idle');
});

test('keeps the live runner when Claude resolves the default model at initialization', () => {
  const session = createSession();
  session.runnerStarted = true;
  session.activeOptionSignature = session.getOptionSignature();

  session.handleSdkMessage({
    type: 'system',
    subtype: 'init',
    session_id: 'claude-session-123',
    model: 'deepseek-v4-pro[1m]'
  });
  session.handleSdkMessage({ type: 'result', subtype: 'success', is_error: false });

  assert.equal(session.model, 'deepseek-v4-pro[1m]');
  assert.equal(session.activeOptionSignature, session.getOptionSignature());
  assert.equal(session.runnerStarted, true);
});

test('describes Claude resume sessions by their two latest user questions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-claude-transcript-'));
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const records = [
    { type: 'user', message: { content: 'First question' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] } },
    { type: 'user', message: { content: '<command-name>/context</command-name>' } },
    { type: 'user', message: { content: '<local-command-caveat>Local command output</local-command-caveat>' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'Second question' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
    { type: 'user', message: { content: 'Latest question' } }
  ];
  fs.writeFileSync(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const repository = new ClaudeTranscriptRepository({ logger: {} });

  try {
    const item = repository.describe({ id: 'session', path: transcriptPath, mtimeMs: 100, size: 200 });
    assert.deepEqual(item.questions, ['Latest question', 'Second question']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
