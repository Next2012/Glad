const Conf = require('conf');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const config = new Conf({
  projectName: 'termly',
  cwd: path.join(os.homedir(), '.termly'),
  configName: 'schedules'
});

function normalizeWeekdays(weekdays) {
  const values = Array.isArray(weekdays) ? weekdays : [];
  return Array.from(new Set(values.map(Number).filter(value => value >= 0 && value <= 6))).sort((a, b) => a - b);
}

function normalizeSteps(steps) {
  const values = Array.isArray(steps) ? steps : [];
  return values.map(step => {
    const type = String(step.type || '').trim();
    if (type === 'sleep') return { type, seconds: Math.max(0, Number(step.seconds) || 0) };
    if (type === 'sendText') return { type, text: String(step.text || '') };
    if (type === 'sendKey') return { type, key: String(step.key || 'enter') };
    if (type === 'keyDown' || type === 'keyUp') return { type, key: String(step.key || '') };
    if (type === 'stop' || type === 'closeSession') return { type };
    return null;
  }).filter(Boolean);
}

function computeNextRunAt(schedule, from = Date.now()) {
  const weekdays = normalizeWeekdays(schedule && schedule.weekdays);
  const time = String(schedule && schedule.time || '').trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match || weekdays.length === 0) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const start = new Date(from);

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(start);
    candidate.setDate(start.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= from) continue;
    if (weekdays.includes(candidate.getDay())) return candidate.getTime();
  }

  return null;
}

function normalizeJob(input, existing = null, options = {}) {
  const now = Date.now();
  const schedule = input.schedule || {};
  const target = input.target || {};
  const job = {
    id: existing?.id || input.id || uuidv4(),
    name: String(input.name || existing?.name || 'Scheduled Task').trim() || 'Scheduled Task',
    enabled: Boolean(input.enabled ?? existing?.enabled ?? true),
    schedule: {
      time: String(schedule.time || existing?.schedule?.time || '09:00'),
      weekdays: normalizeWeekdays(schedule.weekdays ?? existing?.schedule?.weekdays ?? [1, 2, 3, 4, 5])
    },
    target: {
      toolKey: String(target.toolKey || existing?.target?.toolKey || 'demo'),
      workingDirectory: String(target.workingDirectory ?? existing?.target?.workingDirectory ?? '')
    },
    steps: normalizeSteps(input.steps ?? existing?.steps ?? []),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: options.touch ? now : (existing?.updatedAt || input.updatedAt || now),
    lastRunAt: existing?.lastRunAt || input.lastRunAt || null,
    lastRunStatus: existing?.lastRunStatus || input.lastRunStatus || 'idle',
    lastRunMessage: existing?.lastRunMessage || input.lastRunMessage || '',
    lastSessionId: existing?.lastSessionId || input.lastSessionId || null,
    running: Boolean(existing?.running || false)
  };
  job.nextRunAt = job.enabled ? computeNextRunAt(job.schedule) : null;
  return job;
}

class JobStore {
  list() {
    return config.get('jobs', []).map(job => normalizeJob(job, job));
  }

  saveAll(jobs) {
    config.set('jobs', jobs);
  }

  get(id) {
    return this.list().find(job => job.id === id) || null;
  }

  create(input) {
    const jobs = this.list();
    const job = normalizeJob(input, null, { touch: true });
    jobs.push(job);
    this.saveAll(jobs);
    return job;
  }

  update(id, input) {
    const jobs = this.list();
    const index = jobs.findIndex(job => job.id === id);
    if (index === -1) return null;
    jobs[index] = normalizeJob(input, jobs[index], { touch: true });
    this.saveAll(jobs);
    return jobs[index];
  }

  patchRuntime(id, patch) {
    const jobs = this.list();
    const index = jobs.findIndex(job => job.id === id);
    if (index === -1) return null;
    jobs[index] = { ...jobs[index], ...patch, updatedAt: Date.now() };
    if ('enabled' in patch || 'lastRunAt' in patch || 'schedule' in patch) {
      jobs[index].nextRunAt = jobs[index].enabled ? computeNextRunAt(jobs[index].schedule) : null;
    }
    this.saveAll(jobs);
    return jobs[index];
  }

  delete(id) {
    const jobs = this.list();
    const next = jobs.filter(job => job.id !== id);
    this.saveAll(next);
    return next.length !== jobs.length;
  }

  duplicate(id) {
    const source = this.get(id);
    if (!source) return null;
    return this.create({
      ...source,
      id: uuidv4(),
      name: `${source.name} Copy`,
      enabled: false,
      lastRunAt: null,
      lastRunStatus: 'idle',
      lastRunMessage: '',
      lastSessionId: null,
      running: false
    });
  }
}

module.exports = {
  JobStore,
  computeNextRunAt,
  normalizeJob
};
