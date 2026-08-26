const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CcusageRunner } = require('./ccusage-runner');

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
