const { formatNotification, createTestSession } = require('./message-formatter');

class NotificationService {
  constructor({ sessionManager, settingsStore, channel, logger = console }) {
    this.sessionManager = sessionManager;
    this.settingsStore = settingsStore;
    this.channel = channel;
    this.logger = logger;
    this.seenEvents = new Map();
    this.handlers = {
      claude: payload => this.handleProviderEvent('claude', payload),
      codex: payload => this.handleProviderEvent('codex', payload),
      exit: payload => this.clearSession(payload.sessionId)
    };
    sessionManager.on('claude-event', this.handlers.claude);
    sessionManager.on('codex-event', this.handlers.codex);
    sessionManager.on('exit', this.handlers.exit);
  }

  stop() {
    this.sessionManager.off('claude-event', this.handlers.claude);
    this.sessionManager.off('codex-event', this.handlers.codex);
    this.sessionManager.off('exit', this.handlers.exit);
    this.seenEvents.clear();
  }

  getSessionState(sessionId) {
    const session = this.sessionManager.get(sessionId);
    if (!session) return null;
    return {
      enabled: Boolean(session.serverChanNotificationEnabled),
      configured: this.settingsStore.getPublic().configured
    };
  }

  async setSessionEnabled(sessionId, enabled) {
    const session = this.sessionManager.get(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    if (enabled && !this.settingsStore.getPublic().configured) {
      const error = new Error('请先配置 Server酱');
      error.statusCode = 409;
      error.code = 'SERVERCHAN_NOT_CONFIGURED';
      throw error;
    }
    session.serverChanNotificationEnabled = Boolean(enabled);
    if (enabled && session.pendingPermissions?.size > 0) {
      await this.sendEvent({
        kind: 'approval',
        provider: session.kind === 'claude-structured' ? 'claude' : 'codex',
        session
      });
    }
    return this.getSessionState(sessionId);
  }

  disableAllSessions() {
    for (const session of this.sessionManager.sessions.values()) {
      session.serverChanNotificationEnabled = false;
    }
  }

  async sendTest(input = {}) {
    const settings = this.settingsStore.resolve(input);
    const session = createTestSession(
      input.sessionId ? this.sessionManager.get(input.sessionId) : null
    );
    const provider = session?.kind === 'claude-structured'
      ? 'claude'
      : session?.kind === 'codex-structured' ? 'codex' : null;
    const message = formatNotification({ kind: 'test', provider, session }, settings.clientType);
    await this.channel.send({ ...settings, ...message });
    return { success: true };
  }

  handleProviderEvent(provider, payload = {}) {
    const { session, event, sessionId } = payload;
    if (!session || !event || !session.serverChanNotificationEnabled) return;

    if (event.type === 'permission-request') {
      const requestId = event.request?.id || event.request?.toolUseId || 'pending';
      if (!this.markSeen(sessionId, `approval:${requestId}`)) return;
      this.sendEvent({ kind: 'approval', provider, session });
      return;
    }

    if (event.type === 'runtime-disconnected') {
      if (!event.activeTurn || !this.markSeen(sessionId, `disconnected:${event.turnId || 'active'}`)) return;
      this.sendEvent({ kind: 'disconnected', provider, session });
      return;
    }

    if (event.type === 'turn-failed') {
      if (!this.markSeen(sessionId, `failed:${event.turnId || event.createdAt || 'start'}`)) return;
      this.sendEvent({ kind: 'failed', provider, session, durationMs: event.durationMs });
      return;
    }

    const message = event.type === 'message' ? event.message : null;
    if (!message || message.kind !== 'turn-end') return;
    if (provider === 'codex' && message.threadId && session.threadId && message.threadId !== session.threadId) return;

    const status = String(message.turnStatus || message.status || 'completed');
    if (status === 'cancelled' || status === 'interrupted') return;
    const turnId = message.turnId || message.id;
    if (!this.markSeen(sessionId, `turn:${turnId}`)) return;
    this.sendEvent({
      kind: status === 'failed' ? 'failed' : 'completed',
      provider,
      session,
      durationMs: message.durationMs
    });
  }

  markSeen(sessionId, key) {
    const seen = this.seenEvents.get(sessionId) || new Set();
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    this.seenEvents.set(sessionId, seen);
    return true;
  }

  clearSession(sessionId) {
    this.seenEvents.delete(sessionId);
  }

  async sendEvent(event) {
    try {
      const settings = this.settingsStore.get();
      if (!settings.sendKey) return;
      const message = formatNotification(event, settings.clientType);
      await this.channel.send({ ...settings, ...message });
    } catch (error) {
      this.logger.error?.(`[serverchan] notification failed: ${error.message}`);
    }
  }
}

module.exports = NotificationService;
