const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { SkillInstaller, extractVerifiedBundle, parseSkillName, parseDefaultPrompt } = require('./skill-installer');

const SKILL_MD = `---\nname: embedded-question-guide\ndescription: Ask for missing embedded context.\n---\n\n# Guide\n`;
const OPENAI_YAML = `interface:\n  default_prompt: |\n    请介绍嵌入式需求向导。\n    这一轮只做引导。\n`;

function zipBuffer(files, prefix = '') {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content), `${prefix}${name}`, { mode: 0o100600 });
    }
    zip.end();
  });
}

function manifest(files) {
  return {
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      size: Buffer.byteLength(content),
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    }))
  };
}

test('extracts a prefixed Git archive after verifying every file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-skill-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'SKILL.md': SKILL_MD, 'references/pins.md': 'PA5 = SCK\n' };
  const bundle = await zipBuffer(files, 'embedded-question-guide-1.0.0/');

  await extractVerifiedBundle(bundle, manifest(files), root);

  assert.equal(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'), SKILL_MD);
  assert.equal(fs.readFileSync(path.join(root, 'references/pins.md'), 'utf8'), 'PA5 = SCK\n');
  assert.equal(parseSkillName(SKILL_MD), 'embedded-question-guide');
});

test('rejects a bundle whose content differs from the manifest', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-skill-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await zipBuffer({ 'SKILL.md': `${SKILL_MD}tampered` });

  await assert.rejects(extractVerifiedBundle(bundle, manifest({ 'SKILL.md': SKILL_MD }), root), /\u6821\u9a8c\u5931\u8d25/);
});

test('prepares and synchronously removes one session-only skill', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-skill-session-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'SKILL.md': SKILL_MD, 'agents/openai.yaml': OPENAI_YAML };
  const skillManifest = manifest(files);
  skillManifest.manifestDigest = 'sha256:' + 'a'.repeat(64);
  const bundle = await zipBuffer(files);
  const bundleHash = crypto.createHash('sha256').update(bundle).digest('hex');
  const client = {
    async getSkill() {
      return {
        id: '11111111-1111-4111-8111-111111111111',
        version: '1.0.0',
        digest: skillManifest.manifestDigest,
        manifest: skillManifest
      };
    },
    async downloadBundle() {
      return { buffer: bundle, digest: skillManifest.manifestDigest, sha256: bundleHash };
    }
  };
  const installer = new SkillInstaller({ client, root, available: true });
  const sessionId = '22222222-2222-4222-8222-222222222222';

  const prepared = await installer.prepare(sessionId, {
    id: '11111111-1111-4111-8111-111111111111',
    version: '1.0.0',
    digest: skillManifest.manifestDigest
  });

  assert.equal(prepared.name, 'embedded-question-guide');
  assert.equal(prepared.defaultPrompt, '请介绍嵌入式需求向导。\n这一轮只做引导。');
  assert.equal(fs.existsSync(prepared.path), true);
  assert.equal(prepared.path.includes('.agents/skills'), false);
  installer.cleanupSync(sessionId);
  assert.equal(fs.existsSync(path.join(root, sessionId)), false);
});

test('disables Skill sessions when creating tmpfs fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-skill-no-tmpfs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = new SkillInstaller({
    client: {},
    root,
    readMounts: () => 'overlay / overlay rw 0 0\n',
    tryMountTmpfs: () => { throw new Error('operation not permitted'); }
  });

  assert.equal(await installer.initialize(), false);
  assert.equal(installer.available, false);
  await assert.rejects(
    installer.prepare('22222222-2222-4222-8222-222222222222', {}),
    error => error.statusCode === 503 && error.message === 'Skill暂不可用'
  );
});

test('ignores invalid or oversized default_prompt metadata', () => {
  assert.equal(parseDefaultPrompt('interface: [invalid'), '');
  assert.equal(parseDefaultPrompt(`interface:\n  default_prompt: "${'x'.repeat(8001)}"`), '');
});
