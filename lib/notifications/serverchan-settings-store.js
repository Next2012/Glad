const fs = require('fs');
const {
  getConfig,
  setConfig,
  getConfigPath
} = require('../config/manager');

const CLIENT_TYPES = new Set(['wechat', 'pushdeer']);

function normalizeClientType(value) {
  const clientType = String(value || 'wechat').trim().toLowerCase();
  if (!CLIENT_TYPES.has(clientType)) {
    const error = new Error('接收客户端必须是微信或 PushDeer');
    error.statusCode = 400;
    throw error;
  }
  return clientType;
}

function normalizeSendKey(value) {
  const sendKey = String(value || '').trim();
  if (!sendKey || sendKey.length < 8 || sendKey.length > 512 || /\s/.test(sendKey)) {
    const error = new Error('请输入有效的 Server酱 SendKey');
    error.statusCode = 400;
    throw error;
  }
  return sendKey;
}

function maskSendKey(sendKey) {
  if (!sendKey) return '';
  return `${sendKey.slice(0, Math.min(3, sendKey.length))}${'•'.repeat(10)}`;
}

class ServerChanSettingsStore {
  constructor({
    readConfig = getConfig,
    writeConfig = setConfig,
    configPath = getConfigPath,
    chmod = fs.chmodSync
  } = {}) {
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
    this.configPath = configPath;
    this.chmod = chmod;
  }

  get() {
    const stored = this.readConfig('serverChan') || {};
    return {
      sendKey: String(stored.sendKey || '').trim(),
      clientType: CLIENT_TYPES.has(stored.clientType) ? stored.clientType : 'wechat'
    };
  }

  getPublic() {
    const settings = this.get();
    return {
      configured: Boolean(settings.sendKey),
      maskedKey: maskSendKey(settings.sendKey),
      clientType: settings.clientType
    };
  }

  save(input = {}) {
    const existing = this.get();
    const sendKey = input.sendKey == null || String(input.sendKey).trim() === ''
      ? existing.sendKey
      : normalizeSendKey(input.sendKey);
    if (!sendKey) {
      const error = new Error('请先填写 Server酱 SendKey');
      error.statusCode = 400;
      throw error;
    }
    const settings = {
      sendKey,
      clientType: normalizeClientType(input.clientType ?? existing.clientType)
    };
    this.writeConfig('serverChan', settings);
    this.restrictConfigFile();
    return this.getPublic();
  }

  resolve(input = {}) {
    const existing = this.get();
    return {
      sendKey: input.sendKey == null || String(input.sendKey).trim() === ''
        ? normalizeSendKey(existing.sendKey)
        : normalizeSendKey(input.sendKey),
      clientType: normalizeClientType(input.clientType ?? existing.clientType)
    };
  }

  clear() {
    this.writeConfig('serverChan', { sendKey: '', clientType: 'wechat' });
    this.restrictConfigFile();
    return this.getPublic();
  }

  restrictConfigFile() {
    try {
      const configPath = typeof this.configPath === 'function' ? this.configPath() : this.configPath;
      if (configPath && fs.existsSync(configPath)) this.chmod(configPath, 0o600);
    } catch (_) {
      // Best effort: configuration remains usable on filesystems without chmod support.
    }
  }
}

module.exports = {
  ServerChanSettingsStore,
  normalizeClientType,
  normalizeSendKey,
  maskSendKey
};
