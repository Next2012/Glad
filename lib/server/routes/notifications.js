function statusCode(error) {
  return Number(error?.statusCode) || 500;
}

function registerNotificationRoutes(app, {
  settingsStore,
  notificationService
}) {
  app.get('/api/notifications/serverchan', (_req, res) => {
    res.json(settingsStore.getPublic());
  });

  app.put('/api/notifications/serverchan', (req, res) => {
    try {
      res.json({ success: true, settings: settingsStore.save(req.body || {}) });
    } catch (error) {
      res.status(statusCode(error)).json({ error: error.message });
    }
  });

  app.delete('/api/notifications/serverchan', (_req, res) => {
    const settings = settingsStore.clear();
    notificationService.disableAllSessions();
    res.json({ success: true, settings });
  });

  app.post('/api/notifications/serverchan/test', async (req, res) => {
    try {
      await notificationService.sendTest(req.body || {});
      res.json({ success: true });
    } catch (error) {
      res.status(statusCode(error)).json({ error: error.message });
    }
  });

  app.put('/api/sessions/:id/notifications/serverchan', async (req, res) => {
    try {
      const state = await notificationService.setSessionEnabled(
        req.params.id,
        Boolean(req.body?.enabled)
      );
      res.json({ success: true, state });
    } catch (error) {
      res.status(statusCode(error)).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
  });
}

module.exports = registerNotificationRoutes;
