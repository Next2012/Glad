const { execFile } = require('child_process');

function execFilePromise(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ success: !error, error: error?.message, stdout, stderr });
    });
  });
}

function parseGitStatusZ(stdout) {
  if (!stdout) return [];

  const entries = [];
  const records = stdout.split('\0').filter(Boolean);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 3) continue;

    const status = record.substring(0, 2);
    const path = record.substring(3);
    const entry = { path, status };

    if ((status.includes('R') || status.includes('C')) && i + 1 < records.length) {
      entry.originalPath = records[++i];
    }

    entries.push(entry);
  }

  return entries;
}

class GitService {
  async show(cwd, hash) {
    return execFilePromise('git', ['show', '--format=fuller', '--stat', '-p', hash], cwd);
  }

  async log(cwd, maxCount = 100) {
    const count = Number.parseInt(maxCount, 10) || 100;
    const result = await execFilePromise(
      'git',
      ['log', '--all', '--date-order', `--max-count=${count}`, '--pretty=format:%h|%p|%d|%s|%an|%ar'],
      cwd
    );
    if (!result.success) return result;

    const commits = result.stdout.split('\n').filter(Boolean).map(line => {
      const [hash, parents, refs, subject, author, time] = line.split('|');
      return { hash, parents: parents ? parents.split(' ') : [], refs: refs ? refs.trim() : '', subject, author, time };
    });
    return { ...result, commits };
  }

  async status(cwd) {
    const result = await execFilePromise('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
    if (!result.success) return result;
    return { ...result, files: parseGitStatusZ(result.stdout) };
  }

  diffNumstat(cwd, isStaged = false) {
    const args = isStaged ? ['diff', '--cached', '--numstat'] : ['diff', '--numstat'];
    return execFilePromise('git', args, cwd);
  }

  diffFile(cwd, filePath, isStaged = false) {
    const args = isStaged
      ? ['diff', '--cached', '--no-ext-diff', '--', filePath]
      : ['diff', '--no-ext-diff', '--', filePath];
    return execFilePromise('git', args, cwd);
  }
}

module.exports = {
  GitService,
  execFilePromise,
  parseGitStatusZ
};
