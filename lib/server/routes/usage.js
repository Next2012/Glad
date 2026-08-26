module.exports = function registerUsageRoutes(app, { usageService, sendJson = (_req, res, payload) => res.json(payload) }) {
  app.get('/api/usage/sources', async (req, res) => {
    try {
      res.json(await usageService.listSources(req.query.refresh === '1'));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load usage sources' });
    }
  });

  app.get('/api/usage/report', async (req, res) => {
    try {
      const report = await usageService.getDashboard(
        req.query.source,
        req.query.scope || 'weekly',
        req.query.period,
        req.query.refresh === '1'
      );
      sendJson(req, res, report);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load usage report' });
    }
  });
};
