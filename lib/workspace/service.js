const fs = require('fs');
const path = require('path');

class WorkspaceService {
  constructor({ gitService } = {}) {
    this.gitService = gitService || null;
  }

  resolveInside(rootDir, targetPath = '') {
    const root = fs.realpathSync(path.resolve(rootDir));
    const requestedPath = path.resolve(root, String(targetPath || ''));
    const fullPath = fs.realpathSync(requestedPath);
    const relative = path.relative(root, fullPath);

    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return fullPath;
    }

    const error = new Error('Access denied');
    error.statusCode = 403;
    throw error;
  }

  readFile(rootDir, filePath) {
    const fullPath = this.resolveInside(rootDir, filePath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  async listDirectory(rootDir, dirPath = '') {
    const fullPath = this.resolveInside(rootDir, dirPath);
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    let files = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory()
    })).sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    if (!this.gitService) return files;

    try {
      const gitResult = await this.gitService.status(rootDir);
      if (!gitResult.success || !Array.isArray(gitResult.files)) return files;

      const gitMap = new Map();
      gitResult.files.forEach(entry => {
        gitMap.set(entry.path, entry.status);
      });

      files = files.map(file => {
        const relativePath = dirPath ? `${dirPath}/${file.name}` : file.name;
        let gitStatus = null;

        if (file.isDirectory) {
          for (const [gitFile] of gitMap.entries()) {
            if (gitFile.startsWith(relativePath + '/')) {
              gitStatus = 'M';
              break;
            }
          }
        } else if (gitMap.has(relativePath)) {
          gitStatus = gitMap.get(relativePath);
        }

        return { ...file, gitStatus };
      });
    } catch (_) {
      return files;
    }

    return files;
  }
}

module.exports = WorkspaceService;
