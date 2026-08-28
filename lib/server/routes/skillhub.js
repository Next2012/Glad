const { v4: uuidv4 } = require('uuid');

function statusCode(error) {
  return Number(error?.statusCode) || 500;
}

function errorBody(error) {
  return {
    error: error?.message || 'SkillHub 操作失败',
    ...(error?.code ? { code: error.code } : {})
  };
}

function registerSkillHubRoutes(app, {
  settingsStore,
  client,
  installer,
  sessionManager
}) {
  app.get('/api/skillhub/status', (_req, res) => {
    res.json({ available: installer.available === true });
  });

  app.get('/api/skillhub/settings', (_req, res) => {
    try { res.json(settingsStore.getPublic()); }
    catch (error) { res.status(statusCode(error)).json(errorBody(error)); }
  });

  app.put('/api/skillhub/settings', async (req, res) => {
    try {
      const resolved = settingsStore.resolve(req.body || {});
      const user = await client.test(resolved);
      const settings = settingsStore.save(resolved);
      res.json({ success: true, settings, user });
    } catch (error) {
      res.status(statusCode(error)).json(errorBody(error));
    }
  });

  app.delete('/api/skillhub/settings', (_req, res) => {
    try { res.json({ success: true, settings: settingsStore.clear() }); }
    catch (error) { res.status(statusCode(error)).json(errorBody(error)); }
  });

  app.post('/api/skillhub/settings/test', async (req, res) => {
    try {
      const settings = settingsStore.resolve(req.body || {});
      const user = await client.test(settings);
      res.json({ success: true, user });
    } catch (error) {
      res.status(statusCode(error)).json(errorBody(error));
    }
  });

  app.get('/api/skillhub/skills', async (_req, res) => {
    try {
      installer.assertAvailable();
      const skills = await client.listSkills();
      res.json({ success: true, skills });
    } catch (error) {
      res.status(statusCode(error)).json(errorBody(error));
    }
  });

  app.post('/api/skillhub/sessions', async (req, res) => {
    const sessionId = uuidv4();
    let created = false;
    try {
      if (req.body?.toolKey !== 'codex') {
        const error = new Error('SkillHub Session 当前只支持 Codex');
        error.statusCode = 400;
        error.code = 'SKILLHUB_CODEX_ONLY';
        throw error;
      }
      const activeSkill = await installer.prepare(sessionId, req.body?.skill || {});
      const session = sessionManager.create({
        id: sessionId,
        toolKey: 'codex',
        workingDirectory: req.body?.workingDirectory,
        name: activeSkill.name,
        codexOptions: {
          activeSkill,
          extraSkillRoots: [activeSkill.skillsRoot]
        },
        disposeResources: () => installer.cleanupSync(sessionId)
      });
      created = true;
      const defaultPrompt = activeSkill.defaultPrompt
        || '请先用中文介绍这个 Skill 能完成什么、适合哪些任务，以及用户接下来应该如何使用。这一轮只做使用引导。';
      const intro = `$${activeSkill.name}\n\n${defaultPrompt}`;
      const started = await sessionManager.sendCodexInput(session.id, intro, [], [activeSkill], []);
      if (!started) throw new Error('Codex Skill 引导会话启动失败');
      res.status(201).json({ id: session.id, name: session.name });
    } catch (error) {
      if (created) await sessionManager.kill(sessionId).catch(() => {});
      else {
        try { installer.cleanupSync(sessionId); } catch (_) { /* 目录可能尚未创建 */ }
      }
      res.status(statusCode(error)).json(errorBody(error));
    }
  });
}

module.exports = registerSkillHubRoutes;
