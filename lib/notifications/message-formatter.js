const path = require('path');

const TITLE_LABELS = {
  approval: '待审批',
  completed: '已完成',
  failed: '执行失败',
  disconnected: '连接中断',
  test: '通知测试'
};

function compactText(value, maxLength = 20) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatLocalDateTime(value) {
  const date = new Date(Number(value) || Date.now());
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

function escapeMarkdown(value) {
  return String(value || '').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function providerName(provider, session) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return session?.tool?.displayName || 'AI';
}

function sessionDirectory(session) {
  return session?.workingDir || session?.workingDirectory || session?.ptyManager?.workingDir || process.cwd();
}

function formatNotification({ kind, provider, session, durationMs = null }, clientType = 'wechat') {
  const name = String(session?.name || providerName(provider, session));
  const directory = sessionDirectory(session);
  const type = providerName(provider, session);
  const title = `${TITLE_LABELS[kind] || '通知'}｜${compactText(name)}`;
  const details = [
    ['类型', type],
    ['会话', name],
    ['创建', formatLocalDateTime(session?.startTime)],
    ['目录', directory]
  ];
  const duration = formatDuration(durationMs);
  if (duration) details.push(['本轮耗时', duration]);

  if (clientType === 'pushdeer') {
    return {
      title,
      description: details
        .map(([label, value]) => label === '目录'
          ? `**${label}：** \`${escapeMarkdown(value)}\``
          : `**${label}：** ${escapeMarkdown(value)}`)
        .join('\n\n')
    };
  }

  return {
    title,
    description: details.map(([label, value]) => `${label}：${value}`).join('\n\n')
  };
}

function createTestSession(session = null) {
  if (session) return session;
  return {
    name: 'Glad 测试会话',
    startTime: Date.now(),
    workingDir: path.resolve(process.cwd()),
    tool: { displayName: 'Glad' }
  };
}

module.exports = {
  formatNotification,
  createTestSession,
  compactText,
  formatLocalDateTime,
  formatDuration
};
