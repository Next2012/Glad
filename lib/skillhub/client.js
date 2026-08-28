const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

function clientProblem(message, statusCode = 502, code = 'SKILLHUB_REQUEST_FAILED') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

class SkillHubClient {
  constructor({ settingsStore, fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.settingsStore = settingsStore;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, { method = 'GET', settings = null, body = null, accept = 'application/json' } = {}) {
    const current = settings || this.settingsStore.resolve();
    const base = `${current.baseUrl.replace(/\/$/, '')}/`;
    const path = String(pathname || '').replace(/^\//, '');
    const url = new URL(path, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${current.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) {
        let detail = '';
        try {
          const payload = await response.json();
          detail = payload?.error?.message || payload?.error || payload?.message || '';
        } catch (_) { /* response body is not JSON */ }
        const statusCode = response.status === 401 || response.status === 403 ? response.status : 502;
        const code = response.status === 401 ? 'SKILLHUB_UNAUTHORIZED'
          : response.status === 403 ? 'SKILLHUB_FORBIDDEN' : 'SKILLHUB_BAD_RESPONSE';
        throw clientProblem(detail || `SkillHub 返回 HTTP ${response.status}`, statusCode, code);
      }
      return response;
    } catch (error) {
      if (error.statusCode) throw error;
      if (error.name === 'AbortError') throw clientProblem('SkillHub 请求超时', 504, 'SKILLHUB_TIMEOUT');
      throw clientProblem(`无法连接 SkillHub：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async test(settings) {
    const response = await this.request('/api/v1/whoami', { settings });
    return response.json();
  }

  async listSkills() {
    const items = [];
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100', order: 'updated_at_desc' });
      if (cursor) query.set('cursor', cursor);
      const response = await this.request(`/api/runtime/skills?${query}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw clientProblem('SkillHub Skill 列表格式无效');
      items.push(...payload.data);
      cursor = String(payload.nextCursor || '');
      if (!cursor) return items;
    }
    throw clientProblem('SkillHub Skill 列表分页过多');
  }

  async getSkill({ id, version, digest }) {
    const query = new URLSearchParams({ include: 'manifest,skillMd' });
    if (version) query.set('version', version);
    if (digest) query.set('digest', digest);
    const response = await this.request(`/api/runtime/skills/by-id/${encodeURIComponent(id)}?${query}`);
    return response.json();
  }

  async downloadBundle({ id, version, digest }) {
    const query = new URLSearchParams({ id, format: 'zip' });
    if (version) query.set('version', version);
    if (digest) query.set('digest', digest);
    const response = await this.request(`/api/runtime/skills/bundle?${query}`, {
      accept: 'application/zip'
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BUNDLE_BYTES) {
      throw clientProblem('Skill bundle 超过 20 MB', 413, 'SKILLHUB_BUNDLE_TOO_LARGE');
    }
    if (!response.body) throw clientProblem('SkillHub 返回了空 bundle');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BUNDLE_BYTES) {
        await reader.cancel();
        throw clientProblem('Skill bundle 超过 20 MB', 413, 'SKILLHUB_BUNDLE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks, total);
    return {
      buffer,
      digest: response.headers.get('x-saker-skill-digest') || '',
      sha256: response.headers.get('x-saker-bundle-sha256') || ''
    };
  }
}

module.exports = { SkillHubClient, MAX_BUNDLE_BYTES };
