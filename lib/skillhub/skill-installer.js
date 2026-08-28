const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yauzl = require('yauzl');
const YAML = require('yaml');

const MAX_FILES = 256;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function installProblem(message, statusCode = 400, code = 'SKILLHUB_INVALID_BUNDLE') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function safeRelativePath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return normalized;
}

function parseSkillName(markdown) {
  const frontmatter = String(markdown || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw installProblem('SKILL.md 缺少 frontmatter');
  const match = frontmatter[1].match(/^name\s*:\s*(.+?)\s*$/m);
  if (!match) throw installProblem('SKILL.md 缺少 name');
  const name = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
    throw installProblem('SKILL.md name 格式无效');
  }
  return name;
}

function parseDefaultPrompt(content) {
  try {
    const document = YAML.parse(String(content || ''));
    const prompt = document?.interface?.default_prompt;
    if (typeof prompt !== 'string') return '';
    const normalized = prompt.trim();
    return normalized.length <= 8000 ? normalized : '';
  } catch (_) {
    return '';
  }
}

function mountTmpfs(root) {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    const result = spawnSync('mount', [
      '-t', 'tmpfs',
      '-o', `rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=${uid},gid=${gid}`,
      'tmpfs', root
    ], { stdio: 'ignore', timeout: 2000 });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(installProblem(`Skill bundle 无法解析：${error.message}`));
      else resolve(zip);
    });
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) stream.destroy(installProblem('Skill 单文件超过 10 MB', 413));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function extractVerifiedBundle(buffer, manifest, destination) {
  const declaredFiles = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!declaredFiles.length || declaredFiles.length > MAX_FILES) {
    throw installProblem(`Skill manifest 文件数必须在 1-${MAX_FILES} 之间`);
  }
  const expected = new Map();
  let declaredTotal = 0;
  for (const file of declaredFiles) {
    const filePath = safeRelativePath(file?.path);
    const size = Number(file?.size);
    const sha256 = String(file?.sha256 || '').toLowerCase();
    if (!filePath || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES
      || !/^[0-9a-f]{64}$/.test(sha256) || expected.has(filePath)) {
      throw installProblem('Skill manifest 文件声明无效');
    }
    declaredTotal += size;
    if (declaredTotal > MAX_TOTAL_BYTES) throw installProblem('Skill 文件总大小超过 20 MB', 413);
    expected.set(filePath, { size, sha256 });
  }
  if (!expected.has('SKILL.md')) throw installProblem('Skill bundle 缺少 SKILL.md');

  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  const zip = await openZip(buffer);
  const written = new Set();
  let archivePrefix = null;
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        void (async () => {
          const rawName = String(entry.fileName || '');
          if (rawName.endsWith('/')) {
            const directory = safeRelativePath(rawName.slice(0, -1));
            if (!directory) throw installProblem(`Skill bundle 包含不安全目录：${rawName}`);
            zip.readEntry();
            return;
          }
          let filePath = safeRelativePath(rawName);
          if (filePath && !expected.has(filePath)) {
            const separator = filePath.indexOf('/');
            const prefix = separator > 0 ? filePath.slice(0, separator) : '';
            const nested = separator > 0 ? filePath.slice(separator + 1) : '';
            if (prefix && expected.has(nested) && (archivePrefix == null || archivePrefix === prefix)) {
              archivePrefix = prefix;
              filePath = nested;
            }
          } else if (filePath && expected.has(filePath)) {
            if (archivePrefix && archivePrefix !== '') {
              throw installProblem('Skill bundle 同时包含带前缀和无前缀文件');
            }
            if (archivePrefix == null) archivePrefix = '';
          }
          const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!filePath || unixType === 0xa000 || !expected.has(filePath) || written.has(filePath)) {
            throw installProblem(`Skill bundle 包含未声明或不安全文件：${rawName}`);
          }
          const content = await readEntry(zip, entry);
          const declared = expected.get(filePath);
          const digest = crypto.createHash('sha256').update(content).digest('hex');
          if (content.length !== declared.size || digest !== declared.sha256) {
            throw installProblem(`Skill 文件校验失败：${filePath}`);
          }
          const target = path.join(destination, ...filePath.split('/'));
          await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const originalMode = (entry.externalFileAttributes >>> 16) & 0o777;
          const mode = originalMode & 0o111 ? 0o700 : 0o600;
          await fs.promises.writeFile(target, content, { mode, flag: 'wx' });
          written.add(filePath);
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    try { zip.close(); } catch (_) { /* already closed */ }
  }
  if (written.size !== expected.size) {
    const missing = [...expected.keys()].filter(item => !written.has(item));
    throw installProblem(`Skill bundle 缺少文件：${missing.join(', ')}`);
  }
}

class SkillInstaller {
  constructor({
    client,
    root = process.env.GLAD_SKILL_SESSION_ROOT || '/run/glad-skill-sessions',
    readMounts = () => fs.readFileSync('/proc/mounts', 'utf8'),
    tryMountTmpfs = mountTmpfs,
    available = null
  } = {}) {
    this.client = client;
    this.root = path.resolve(root);
    this.readMounts = readMounts;
    this.tryMountTmpfs = tryMountTmpfs;
    this.available = available;
  }

  sessionRoot(sessionId) {
    if (!SESSION_ID.test(String(sessionId || ''))) throw installProblem('Glad Session ID 无效');
    return path.join(this.root, sessionId);
  }

  async initialize() {
    this.available = this.isTmpfsMounted();
    if (!this.available) {
      let created = false;
      try {
        if (!fs.existsSync(this.root)) {
          await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
          created = true;
        }
        this.tryMountTmpfs(this.root);
        this.available = this.isTmpfsMounted();
      } catch (_) {
        this.available = false;
      }
      if (!this.available) {
        if (created) {
          try { fs.rmdirSync(this.root); } catch (_) { /* 只清理本次创建的空目录 */ }
        }
        return false;
      }
    }
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SESSION_ID.test(entry.name)) {
        await fs.promises.rm(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }
    return true;
  }

  isTmpfsMounted() {
    try {
      const rows = String(this.readMounts() || '').split(/\r?\n/);
      return rows.some(row => {
        const fields = row.trim().split(/\s+/);
        const mountPoint = String(fields[1] || '').replace(/\\040/g, ' ');
        return mountPoint === this.root && fields[2] === 'tmpfs';
      });
    } catch (_) {
      return false;
    }
  }

  assertAvailable() {
    if (this.available === true) return;
    throw installProblem('Skill暂不可用', 503, 'SKILL_TEMPORARILY_UNAVAILABLE');
  }

  async prepare(sessionId, selection) {
    this.assertAvailable();
    const id = String(selection?.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw installProblem('Skill ID 无效');
    const detail = await this.client.getSkill({
      id,
      version: String(selection?.version || ''),
      digest: String(selection?.digest || '')
    });
    if (!detail?.manifest || detail.id !== id || !detail.version || !detail.digest) {
      throw installProblem('SkillHub Skill 详情格式无效', 502);
    }
    if (selection.version && detail.version !== selection.version) throw installProblem('Skill 版本已变更', 409);
    if (selection.digest && detail.digest !== selection.digest) throw installProblem('Skill 内容已变更', 409);
    if (detail.manifest.manifestDigest !== detail.digest) throw installProblem('Skill manifest digest 不一致', 502);

    const downloaded = await this.client.downloadBundle({
      id,
      version: detail.version,
      digest: detail.digest
    });
    if (downloaded.digest && downloaded.digest !== detail.digest) {
      throw installProblem('Skill bundle digest 不一致', 502);
    }
    if (downloaded.sha256) {
      const actual = crypto.createHash('sha256').update(downloaded.buffer).digest('hex');
      if (actual !== downloaded.sha256.toLowerCase()) throw installProblem('Skill bundle SHA256 校验失败', 502);
    }

    const sessionRoot = this.sessionRoot(sessionId);
    const skillsRoot = path.join(sessionRoot, 'skills');
    const temporary = path.join(sessionRoot, `.extract-${crypto.randomUUID()}`);
    const skillDirectory = path.join(skillsRoot, id);
    try {
      await fs.promises.mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      await extractVerifiedBundle(downloaded.buffer, detail.manifest, temporary);
      const skillMd = await fs.promises.readFile(path.join(temporary, 'SKILL.md'), 'utf8');
      const name = parseSkillName(skillMd);
      let defaultPrompt = '';
      const openAIMetadata = detail.manifest.files.find(file => file?.path === 'agents/openai.yaml');
      if (openAIMetadata && Number(openAIMetadata.size) <= 64 * 1024) {
        const metadata = await fs.promises.readFile(path.join(temporary, 'agents/openai.yaml'), 'utf8');
        defaultPrompt = parseDefaultPrompt(metadata);
      }
      await fs.promises.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
      await fs.promises.rename(temporary, skillDirectory);
      return {
        id,
        name,
        version: detail.version,
        digest: detail.digest,
        defaultPrompt,
        skillsRoot,
        path: path.join(skillDirectory, 'SKILL.md')
      };
    } catch (error) {
      await fs.promises.rm(sessionRoot, { recursive: true, force: true });
      throw error;
    }
  }

  cleanupSync(sessionId) {
    if (this.available === false) return;
    const target = this.sessionRoot(sessionId);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

module.exports = {
  SkillInstaller,
  extractVerifiedBundle,
  parseSkillName,
  safeRelativePath,
  parseDefaultPrompt
};
