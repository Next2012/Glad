const crypto = require('crypto');
const fs = require('fs');
const {
  getConfig,
  setConfig,
  getConfigPath
} = require('../config/manager');

function problem(message, statusCode = 400, code = 'SKILLHUB_INVALID_SETTINGS') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) throw problem('请输入有效的 SkillHub 地址');
  let url;
  try { url = new URL(raw); } catch (_) { throw problem('请输入有效的 SkillHub 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash) {
    throw problem('SkillHub 地址格式无效');
  }
  const localHosts = new Set(['skillhub', 'localhost', '127.0.0.1', '::1']);
  if (url.protocol === 'http:' && !localHosts.has(url.hostname.toLowerCase())) {
    throw problem('远程 SkillHub 必须使用 HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length < 12 || token.length > 2048 || /\s/.test(token)) {
    throw problem('请输入有效的 SkillHub API Token');
  }
  return token;
}

function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, Math.min(7, token.length))}${'•'.repeat(10)}`;
}

function decodeKey(content) {
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, 'base64');
  if (raw.length === 32) return raw;
  throw problem('SkillHub Token 加密密钥必须是 32 字节', 500, 'SKILLHUB_KEY_INVALID');
}

class SkillHubSettingsStore {
  constructor({
    readConfig = getConfig,
    writeConfig = setConfig,
    configPath = getConfigPath,
    keyFile = process.env.GLAD_SKILLHUB_KEY_FILE || '',
    readFile = fs.readFileSync,
    chmod = fs.chmodSync
  } = {}) {
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
    this.configPath = configPath;
    this.keyFile = keyFile;
    this.readFile = readFile;
    this.chmod = chmod;
  }

  key() {
    if (!this.keyFile) {
      throw problem('Glad 未配置 SkillHub Token 加密密钥', 503, 'SKILLHUB_KEY_MISSING');
    }
    try { return decodeKey(this.readFile(this.keyFile)); }
    catch (error) {
      if (error.code === 'SKILLHUB_KEY_INVALID') throw error;
      throw problem('Glad 无法读取 SkillHub Token 加密密钥', 503, 'SKILLHUB_KEY_UNREADABLE');
    }
  }

  encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };
  }

  decrypt(envelope) {
    if (!envelope?.ciphertext || !envelope?.iv || !envelope?.authTag) return '';
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch (_) {
      throw problem('SkillHub Token 解密失败，请重新配置', 503, 'SKILLHUB_TOKEN_DECRYPT_FAILED');
    }
  }

  get() {
    const stored = this.readConfig('skillHub') || {};
    const baseUrl = String(stored.baseUrl || '').trim();
    const token = this.decrypt(stored.token || {});
    return { baseUrl, token };
  }

  getPublic() {
    const settings = this.get();
    return {
      configured: Boolean(settings.baseUrl && settings.token),
      baseUrl: settings.baseUrl,
      maskedToken: maskToken(settings.token)
    };
  }

  resolve(input = {}) {
    const existing = this.get();
    return {
      baseUrl: normalizeBaseUrl(input.baseUrl ?? existing.baseUrl),
      token: input.token == null || String(input.token).trim() === ''
        ? normalizeToken(existing.token)
        : normalizeToken(input.token)
    };
  }

  save(input = {}) {
    const settings = this.resolve(input);
    this.writeConfig('skillHub', {
      baseUrl: settings.baseUrl,
      token: this.encrypt(settings.token)
    });
    this.restrictConfigFile();
    return this.getPublic();
  }

  clear() {
    this.writeConfig('skillHub', {
      baseUrl: '',
      token: { ciphertext: '', iv: '', authTag: '' }
    });
    this.restrictConfigFile();
    return { configured: false, baseUrl: '', maskedToken: '' };
  }

  restrictConfigFile() {
    try {
      const target = typeof this.configPath === 'function' ? this.configPath() : this.configPath;
      if (target && fs.existsSync(target)) this.chmod(target, 0o600);
    } catch (_) {
      // 部分文件系统不支持 chmod，配置仍可使用。
    }
  }
}

module.exports = {
  SkillHubSettingsStore,
  normalizeBaseUrl,
  normalizeToken,
  maskToken
};
