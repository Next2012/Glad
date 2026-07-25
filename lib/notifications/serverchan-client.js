const API_BASE = 'https://sctapi.ftqq.com';

function sanitizeServerChanError(payload, fallback) {
  const message = payload && typeof payload === 'object'
    ? payload.message || payload.error || payload.data?.error
    : '';
  const text = String(message || fallback || 'Server酱发送失败').trim();
  return text.slice(0, 300);
}

class ServerChanClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send({ sendKey, title, description = '' }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${API_BASE}/${encodeURIComponent(sendKey)}.send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          title: String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 64),
          desp: String(description || '')
        }),
        signal: controller.signal
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (_) {
        payload = null;
      }
      if (!response.ok || (payload && Number(payload.code) !== 0)) {
        const error = new Error(sanitizeServerChanError(payload, `HTTP ${response.status}`));
        error.statusCode = 502;
        throw error;
      }
      return payload || { code: 0 };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const timeoutError = new Error('Server酱请求超时');
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = ServerChanClient;
