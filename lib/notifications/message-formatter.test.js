const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatNotification,
  formatDuration
} = require('./message-formatter');

const session = {
  name: '修复登录问题',
  startTime: new Date(2026, 6, 25, 14, 20, 0).getTime(),
  workingDir: '/root/data/Test/glad',
  tool: { displayName: 'Claude Code' }
};

test('formats compact WeChat notifications without approval details', () => {
  const message = formatNotification({
    kind: 'approval',
    provider: 'claude',
    session
  }, 'wechat');

  assert.equal(message.title, '待审批｜修复登录问题');
  assert.match(message.description, /类型：Claude/);
  assert.match(message.description, /会话：修复登录问题/);
  assert.match(message.description, /创建：2026-07-25 14:20:00/);
  assert.match(message.description, /目录：\/root\/data\/Test\/glad/);
  assert.doesNotMatch(message.description, /工具|命令|审批原因/);
});

test('formats PushDeer bodies as Markdown with the same session identity', () => {
  const message = formatNotification({
    kind: 'completed',
    provider: 'codex',
    session,
    durationMs: 138_000
  }, 'pushdeer');

  assert.equal(message.title, '已完成｜修复登录问题');
  assert.match(message.description, /\*\*类型：\*\* Codex/);
  assert.match(message.description, /`\/root\/data\/Test\/glad`/);
  assert.match(message.description, /2分18秒/);
});

test('formats short and minute-scale durations', () => {
  assert.equal(formatDuration(10_000), '10秒');
  assert.equal(formatDuration(120_000), '2分');
  assert.equal(formatDuration(null), '');
});
