const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function previewText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function isLocalCommandTranscript(text) {
  const value = String(text || '').trim();
  return value.startsWith('<command-name>/') || value.startsWith('<local-command-caveat>');
}

class ClaudeTranscriptRepository {
  constructor({ baseDir, logger } = {}) {
    this.baseDir = baseDir || process.cwd();
    this.logger = logger || console;
  }

  list(workingDirectory) {
    const projectDir = this.getProjectDirectory(workingDirectory);
    if (!fs.existsSync(projectDir)) return [];
    const files = fs.readdirSync(projectDir)
      .filter(file => /^[0-9a-f-]{36}\.jsonl$/i.test(file))
      .map(file => {
        const fullPath = path.join(projectDir, file);
        const stat = fs.statSync(fullPath);
        return {
          id: file.replace(/\.jsonl$/i, ''),
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40);

    return files.map(file => this.describe(file));
  }

  readMessages(workingDirectory, resumeSessionId) {
    const id = String(resumeSessionId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
    const filePath = path.join(this.getProjectDirectory(workingDirectory), `${id}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const messages = [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const record = this.parseLine(line);
        if (!record || record.isSidechain) continue;
        messages.push(...this.mapRecord(record));
      }
    } catch (error) {
      this.logger.debugInfo?.(`[claude-resume] Failed to backfill ${filePath}: ${error.message}`);
      return [];
    }

    const maxMessages = 1000;
    const visible = messages.filter(Boolean).slice(-maxMessages);
    if (messages.length > maxMessages) {
      visible.unshift({
        id: uuidv4(),
        kind: 'event',
        level: 'info',
        text: `Showing the latest ${maxMessages} resumed transcript items.`,
        createdAt: Date.now()
      });
    }
    return visible;
  }

  getProjectDirectory(workingDirectory) {
    const cwd = path.resolve(workingDirectory || this.baseDir);
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  describe(file) {
    let cwd = '';
    let firstText = '';
    let lastText = '';
    const userQuestions = [];
    try {
      const lines = fs.readFileSync(file.path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = this.parseLine(line);
        if (!parsed) continue;
        if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
        const userText = this.extractUserText(parsed);
        if (userText && userQuestions.at(-1) !== userText) userQuestions.push(userText);
        const text = this.extractText(parsed);
        if (!text) continue;
        if (!firstText) firstText = text;
        lastText = text;
      }
    } catch (error) {
      this.logger.debugInfo?.(`[claude-resume] Failed to read ${file.path}: ${error.message}`);
    }
    return {
      id: file.id,
      cwd,
      updatedAt: file.mtimeMs,
      size: file.size,
      questions: userQuestions.slice(-2).reverse().map(text => previewText(text, 120)),
      firstText: firstText ? previewText(firstText, 120) : '',
      lastText: lastText ? previewText(lastText, 160) : ''
    };
  }

  mapRecord(record) {
    const createdAt = Number.isFinite(Date.parse(record.timestamp)) ? Date.parse(record.timestamp) : Date.now();
    const message = record.message || {};
    const content = message.content;
    if (record.type === 'user') {
      if (typeof content === 'string') {
        const text = content.trim();
        return text && !isLocalCommandTranscript(text) ? [{ id: uuidv4(), kind: 'user', text, createdAt }] : [];
      }
      if (Array.isArray(content)) {
        return content.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          if (item.type === 'tool_result') {
            const text = this.textFromContent(item.content).trim();
            return text ? [{
              id: uuidv4(), kind: 'tool-result', toolUseId: item.tool_use_id,
              text, isError: Boolean(item.is_error), createdAt
            }] : [];
          }
          if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
            const text = item.text.trim();
            return isLocalCommandTranscript(text) ? [] : [{ id: uuidv4(), kind: 'user', text, createdAt }];
          }
          return [];
        });
      }
    }

    if (record.type === 'assistant' && Array.isArray(content)) {
      const mapped = [];
      const text = this.textFromContent(content).trim();
      if (text) mapped.push({ id: uuidv4(), kind: 'assistant', text, createdAt });
      for (const item of content) {
        if (!item || item.type !== 'tool_use') continue;
        mapped.push({
          id: uuidv4(), kind: 'tool', name: item.name || 'tool',
          summary: this.summarizeToolInput(item.input), input: item.input,
          toolUseId: item.id, createdAt
        });
      }
      return mapped;
    }

    if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.trim()) {
      return [{ id: uuidv4(), kind: 'event', level: 'info', text: `Summary: ${record.summary.trim()}`, createdAt }];
    }
    return [];
  }

  textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(item => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'tool_result') return this.textFromContent(item.content);
      return '';
    }).filter(Boolean).join('\n');
  }

  summarizeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    const serialized = JSON.stringify(input);
    return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
  }

  parseLine(line) {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }

  extractText(record) {
    const content = record?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content.map(item => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'tool_use') return `[tool] ${item.name || 'tool'}`;
      return '';
    }).filter(Boolean).join('\n').trim();
  }

  extractUserText(record) {
    if (record?.type !== 'user') return '';
    const content = record?.message?.content;
    if (typeof content === 'string') {
      const text = content.trim();
      return isLocalCommandTranscript(text) ? '' : text;
    }
    if (!Array.isArray(content)) return '';
    return content.map(item => item?.type === 'text' && typeof item.text === 'string' && !isLocalCommandTranscript(item.text) ? item.text : '')
      .filter(Boolean).join('\n').trim();
  }
}

module.exports = ClaudeTranscriptRepository;
