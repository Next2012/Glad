class SchedulerService {
  constructor({ jobStore, jobRunner, logger, intervalMs = 30000 }) {
    this.jobStore = jobStore;
    this.jobRunner = jobRunner;
    this.logger = logger || console;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()) {
    for (const job of this.jobStore.list()) {
      if (!job.enabled || !job.nextRunAt || job.nextRunAt > now) continue;
      this.jobStore.patchRuntime(job.id, {
        nextRunAt: null,
        lastRunAt: now,
        lastRunStatus: 'queued',
        lastRunMessage: ''
      });
      this.jobRunner.run(job.id, { manual: false }).catch(error => {
        this.logger.error(`Scheduled task ${job.id} failed: ${error.message}`);
      });
    }
  }
}

module.exports = SchedulerService;
