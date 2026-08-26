const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CcusageRunner, ensureCcusageBinaryExecutable } = require('./ccusage-runner');

function fakeChild({ code = 0, stderr = '', stdout = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code);
  });
  return child;
}

test('makes the packaged native binary executable on Unix', () => {
  let chmodCall;
  const binaryPath = ensureCcusageBinaryExecutable('/test/ccusage', {
    platform: 'linux',
    statPath: () => ({ mode: 0o100644 }),
    chmodPath(path, mode) { chmodCall = { path, mode }; }
  });

  assert.equal(binaryPath, '/test/ccusage');
  assert.deepEqual(chmodCall, { path: '/test/ccusage', mode: 0o755 });
});

test('leaves an executable native binary unchanged', () => {
  ensureCcusageBinaryExecutable('/test/ccusage', {
    platform: 'linux',
    statPath: () => ({ mode: 0o100755 }),
    chmodPath: () => { assert.fail('must not chmod an executable binary'); }
  });
});

test('skips executable permission checks on Windows', () => {
  ensureCcusageBinaryExecutable('C:\\test\\ccusage.exe', {
    platform: 'win32',
    statPath: () => { throw new Error('must not stat Windows binaries'); },
    chmodPath: () => { throw new Error('must not chmod Windows binaries'); }
  });
});

test('reports a clear error when native binary permissions cannot be repaired', () => {
  assert.throws(() => ensureCcusageBinaryExecutable('/test/ccusage', {
    platform: 'linux',
    statPath: () => ({ mode: 0o100644 }),
    chmodPath: () => { throw new Error('read-only file system'); }
  }), /ccusage native binary is not executable: read-only file system/);
});

test('parses JSON from the ccusage native process without a shell', async () => {
  let invocation;
  const runner = new CcusageRunner({
    binaryPath: '/test/ccusage',
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return fakeChild({ stdout: '{"daily":[]}' });
    }
  });

  const report = await runner.loadAllPeriods('Asia/Shanghai');

  assert.deepEqual(report, { daily: [] });
  assert.equal(invocation.command, '/test/ccusage');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('--offline'), true);
});

test('surfaces ccusage process and malformed output errors', async () => {
  const failed = new CcusageRunner({
    binaryPath: '/test/ccusage',
    spawnProcess: () => fakeChild({ code: 2, stderr: 'invalid report option' })
  });
  await assert.rejects(failed.runJson([]), /invalid report option/);

  const malformed = new CcusageRunner({
    binaryPath: '/test/ccusage',
    spawnProcess: () => fakeChild({ stdout: 'not json' })
  });
  await assert.rejects(malformed.runJson([]), /invalid JSON/);
});

test('terminates a ccusage process that exceeds the read timeout', async () => {
  let killed = false;
  const runner = new CcusageRunner({
    binaryPath: '/test/ccusage',
    timeoutMs: 5,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { killed = true; };
      return child;
    }
  });

  await assert.rejects(runner.runJson([]), /timed out/);
  assert.equal(killed, true);
});
