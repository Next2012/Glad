function registerScheduleRoutes(app, { jobStore, jobRunner }) {
  app.get('/api/schedules', (req, res) => {
    res.json(jobStore.list());
  });

  app.post('/api/schedules', (req, res) => {
    try {
      res.json(jobStore.create(req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/schedules/:id', (req, res) => {
    const job = jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.patch('/api/schedules/:id', (req, res) => {
    const job = jobStore.update(req.params.id, req.body || {});
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.patch('/api/schedules/:id/enabled', (req, res) => {
    const job = jobStore.patchRuntime(req.params.id, { enabled: Boolean(req.body?.enabled) });
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.delete('/api/schedules/:id', (req, res) => {
    res.json({ success: jobStore.delete(req.params.id) });
  });

  app.post('/api/schedules/:id/duplicate', (req, res) => {
    const job = jobStore.duplicate(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  const runJob = options => async (req, res) => {
    try {
      res.json(await jobRunner.run(req.params.id, options));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  };

  app.post('/api/schedules/:id/run', runJob({ manual: false }));
  app.post('/api/schedules/:id/simulate', runJob({ manual: true, background: true }));
}

module.exports = registerScheduleRoutes;
