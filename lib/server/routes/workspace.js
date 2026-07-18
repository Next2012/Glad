function registerWorkspaceRoutes(app, { sessionManager, gitService, workspaceService, getWorkingDirectory }) {
  function getSession(req, res) {
    const session = sessionManager.get(req.params.id);
    if (!session) res.status(404).json({ error: 'Session not found' });
    return session;
  }

  app.get('/api/sessions/:id/git-show/:hash', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const result = await gitService.show(getWorkingDirectory(session), req.params.hash);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  app.get('/api/sessions/:id/git-branch/:hash', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const result = await gitService.nameRev(getWorkingDirectory(session), req.params.hash);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  app.get('/api/sessions/:id/git-log', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const result = await gitService.log(getWorkingDirectory(session), req.query.maxCount);
    if (!result.success) return res.status(500).json({ error: result.error, stderr: result.stderr });
    res.json({ success: true, commits: result.commits });
  });

  app.get('/api/sessions/:id/git-status', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const result = await gitService.status(getWorkingDirectory(session));
    if (!result.success) return res.status(500).json({ error: result.error, stderr: result.stderr });
    res.json({ success: true, files: result.files });
  });

  app.get('/api/sessions/:id/git-diff-numstat', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const result = await gitService.diffNumstat(getWorkingDirectory(session), req.query.staged === 'true');
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  app.get('/api/sessions/:id/git-diff-file', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    if (!req.query.path) return res.status(400).json({ error: 'Missing file path' });
    const result = await gitService.diffFile(getWorkingDirectory(session), req.query.path, req.query.staged === 'true');
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  app.get('/api/sessions/:id/file', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    if (!req.query.path) return res.status(400).json({ error: 'Missing file path' });
    try {
      const content = workspaceService.readFile(getWorkingDirectory(session), req.query.path);
      res.json({ success: true, content });
    } catch (error) {
      res.status(error.statusCode || 200).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sessions/:id/fs/dir', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    try {
      const files = await workspaceService.listDirectory(getWorkingDirectory(session), req.query.path || '');
      res.json({ success: true, files });
    } catch (error) {
      res.status(error.statusCode || 200).json({ success: false, error: error.message });
    }
  });
}

module.exports = registerWorkspaceRoutes;
