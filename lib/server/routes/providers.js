function registerProviderRoutes(app, { sessionManager }) {
  app.get('/api/sessions/:id/claude-resume-sessions', (req, res) => {
    const items = sessionManager.listClaudeResumeSessions(req.params.id);
    if (!items) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true, items });
  });

  app.patch('/api/sessions/:id/claude-settings', (req, res) => {
    const state = sessionManager.updateClaudeSettings(req.params.id, req.body || {});
    if (!state) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true, state });
  });

  app.post('/api/sessions/:id/claude-abort', (req, res) => {
    const success = sessionManager.abortClaude(req.params.id);
    if (!success) return res.status(404).json({ error: 'Claude session not found or idle' });
    res.json({ success: true });
  });

  app.post('/api/sessions/:id/claude-resume', (req, res) => {
    const resumeSessionId = req.body?.resumeSessionId;
    if (!resumeSessionId) return res.status(400).json({ error: 'Missing resumeSessionId' });
    const success = sessionManager.resumeClaude(req.params.id, resumeSessionId);
    if (!success) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true });
  });

  app.post('/api/sessions/:id/claude-fork', async (req, res) => {
    try {
      const result = await sessionManager.forkClaude(req.params.id, req.body?.claudeSessionId);
      if (!result) return res.status(404).json({ error: 'Claude session not found' });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.patch('/api/sessions/:id/codex-settings', async (req, res) => {
    try {
      const state = await sessionManager.updateCodexSettings(req.params.id, req.body || {});
      if (!state) return res.status(404).json({ error: 'Codex session not found' });
      res.json({ success: true, state });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/sessions/:id/codex-resume-threads', async (req, res) => {
    try {
      const items = await sessionManager.listCodexResumeThreads(req.params.id);
      if (!items) return res.status(404).json({ error: 'Codex session not found' });
      res.json({ success: true, items });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/sessions/:id/codex-abort', (req, res) => {
    const success = sessionManager.abortCodex(req.params.id);
    if (!success) return res.status(409).json({ error: 'Codex session is idle or unavailable' });
    res.json({ success: true });
  });

  app.post('/api/sessions/:id/codex-resume', async (req, res) => {
    try {
      const success = await sessionManager.resumeCodex(req.params.id, req.body?.threadId);
      if (!success) return res.status(409).json({ error: 'Codex session is busy or no thread is available' });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/sessions/:id/codex-fork', async (req, res) => {
    try {
      const session = await sessionManager.forkCodex(req.params.id, req.body?.threadId);
      if (!session) return res.status(404).json({ error: 'Codex session not found' });
      res.json({ success: true, id: session.id, name: session.name, threadId: session.threadId });
    } catch (error) {
      res.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post('/api/sessions/:id/codex-presentation', async (req, res) => {
    const presentation = req.body?.presentation;
    if (!['terminal', 'structured'].includes(presentation)) return res.status(400).json({ error: 'Invalid presentation' });
    try {
      const success = await sessionManager.switchCodexPresentation(req.params.id, presentation);
      if (!success) return res.status(409).json({ error: 'Codex session cannot switch presentation now' });
      res.json({ success: true });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });

  app.post('/api/debug/client-log', (req, res) => {
    const { sessionId, event, payload } = req.body || {};
    sessionManager.logClientDebug(sessionId, event, payload);
    res.json({ success: true });
  });
}

module.exports = registerProviderRoutes;
