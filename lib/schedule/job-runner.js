const { sequenceForKey } = require('./key-sequences');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SessionEndedError extends Error {
  constructor() {
    super('Session ended');
    this.code = 'SESSION_ENDED';
  }
}

class JobRunner {
  constructor({ createSession, getJob, updateJob, logger }) {
    this.createSession = createSession;
    this.getJob = getJob;
    this.updateJob = updateJob;
    this.logger = logger;
    this.running = new Set();
  }

  async run(jobId, options = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error('Scheduled task not found');
    if (this.running.has(job.id)) {
      this.updateJob(job.id, {
        lastRunAt: Date.now(),
        lastRunStatus: 'skipped',
        lastRunMessage: 'Previous run is still active'
      });
      return { skipped: true, reason: 'Previous run is still active' };
    }

    this.running.add(job.id);
    this.updateJob(job.id, {
      running: true,
      lastRunAt: Date.now(),
      lastRunStatus: options.manual ? 'manual-running' : 'running',
      lastRunMessage: ''
    });

    let session = null;
    try {
      session = this.createSession({
        toolKey: job.target.toolKey,
        workingDirectory: job.target.workingDirectory,
        name: `${job.name}${options.manual ? ' (Test)' : ''}`
      });

      this.updateJob(job.id, {
        lastSessionId: session.id,
        lastRunMessage: `Started session ${session.id}`
      });

      const execute = async () => {
        try {
          await sleep(1000);
          await this.executeSteps(job, session);
          this.updateJob(job.id, {
            running: false,
            lastRunStatus: options.manual ? 'manual-success' : 'success',
            lastRunMessage: `Started session ${session.id}`,
            lastSessionId: session.id
          });
        } catch (error) {
          const ended = error && error.code === 'SESSION_ENDED';
          if (!ended) this.logger?.error?.(`Scheduled task failed: ${error.message}`);
          this.updateJob(job.id, {
            running: false,
            lastRunStatus: ended ? 'cancelled' : 'failed',
            lastRunMessage: ended ? 'Session ended' : error.message,
            lastSessionId: session?.id || null
          });
          if (!options.background) throw error;
        } finally {
          this.running.delete(job.id);
          this.updateJob(job.id, { running: false });
        }
      };

      if (options.background) {
        execute();
        return { success: true, sessionId: session.id };
      }

      await execute();
      return { success: true, sessionId: session.id };
    } catch (error) {
      if (!session) {
        this.running.delete(job.id);
        this.updateJob(job.id, { running: false });
      }
      this.logger?.error?.(`Scheduled task failed: ${error.message}`);
      this.updateJob(job.id, {
        running: false,
        lastRunStatus: 'failed',
        lastRunMessage: error.message,
        lastSessionId: session?.id || null
      });
      throw error;
    }
  }

  async executeSteps(job, session) {
    const modifiers = { ctrl: false, alt: false };

    for (const step of job.steps || []) {
      this.assertSessionRunning(session);
      if (step.type === 'sleep') {
        await this.sleepWhileRunning(session, Math.max(0, Number(step.seconds) || 0) * 1000);
        continue;
      }

      if (step.type === 'sendText') {
        if (!session.write(String(step.text || ''))) throw new SessionEndedError();
        continue;
      }

      if (step.type === 'sendKey') {
        if (!session.write(sequenceForKey(step.key, modifiers))) throw new SessionEndedError();
        continue;
      }

      if (step.type === 'keyDown') {
        const key = String(step.key || '').toLowerCase();
        if (key === 'ctrl' || key === 'alt') modifiers[key] = true;
        continue;
      }

      if (step.type === 'keyUp') {
        const key = String(step.key || '').toLowerCase();
        if (key === 'ctrl' || key === 'alt') modifiers[key] = false;
        continue;
      }

      if (step.type === 'stop') break;

      if (step.type === 'closeSession') {
        session.kill?.();
        break;
      }
    }
  }

  assertSessionRunning(session) {
    if (session && typeof session.isRunning === 'function' && !session.isRunning()) {
      throw new SessionEndedError();
    }
  }

  async sleepWhileRunning(session, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.assertSessionRunning(session);
      await sleep(Math.min(500, end - Date.now()));
    }
    this.assertSessionRunning(session);
  }
}

module.exports = JobRunner;
