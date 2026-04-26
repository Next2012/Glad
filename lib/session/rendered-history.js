let TerminalCtor = null;

function getTerminalCtor() {
  if (TerminalCtor) return TerminalCtor;
  if (typeof global.window === 'undefined') {
    global.window = {};
  }
  ({ Terminal: TerminalCtor } = require('xterm-headless'));
  return TerminalCtor;
}

class RenderedHistory {
  constructor(options = {}) {
    const Terminal = getTerminalCtor();

    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.debugLabel = options.debugLabel || 'session';
    this.cols = Math.max(2, options.cols || 80);
    this.rows = Math.max(1, options.rows || 24);
    this.minCols = Math.max(2, options.minCols || 20);
    this.minRows = Math.max(1, options.minRows || 8);
    this.updatedAt = Date.now();
    this.totalWrites = 0;
    this.totalBytes = 0;
    this.pendingWrites = 0;
    this.resizeEvents = 0;
    this.truncated = false;
    this.lastEvents = [];
    this.archivedLines = [];
    this.archivedBytes = 0;
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: Math.max(20000, options.scrollback || 20000),
      allowProposedApi: true
    });
    this.hookBufferTrim();
  }

  write(data) {
    if (!data) return;
    const text = String(data);
    this.totalWrites += 1;
    this.totalBytes += Buffer.byteLength(text, 'utf8');
    this.pendingWrites += 1;
    this.updatedAt = Date.now();

    this.term.write(text, () => {
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      this.updatedAt = Date.now();
    });
  }

  resize(cols, rows) {
    const rawCols = Number.parseInt(cols, 10);
    const rawRows = Number.parseInt(rows, 10);
    const nextCols = Math.max(2, rawCols || this.cols);
    const nextRows = Math.max(1, rawRows || this.rows);

    // Hidden or unstable layouts can briefly report pathological sizes like 10x6.
    // Ignore those for rendered history so we don't reflow the whole buffer into noise.
    if (nextCols < this.minCols || nextRows < this.minRows) {
      this.recordEvent(`resize ignored ${nextCols}x${nextRows}`);
      return;
    }

    if (nextCols === this.cols && nextRows === this.rows) return;

    this.cols = nextCols;
    this.rows = nextRows;
    this.resizeEvents += 1;
    this.updatedAt = Date.now();
    this.recordEvent(`resize ${this.cols}x${this.rows}`);
    this.term.resize(this.cols, this.rows);
  }

  toJSON() {
    const snapshot = this.buildSnapshot();
    return {
      text: snapshot.text,
      updatedAt: this.updatedAt,
      truncated: snapshot.truncated,
      bytes: snapshot.bytes,
      lines: snapshot.lines.length
    };
  }

  getDebugSnapshot(options = {}) {
    const tailLines = options.tailLines || 12;
    const snapshot = this.buildSnapshot();
    const active = this.term.buffer.active;
    return {
      label: this.debugLabel,
      updatedAt: this.updatedAt,
      truncated: snapshot.truncated,
      cols: this.cols,
      rows: this.rows,
      totalWrites: this.totalWrites,
      totalBytes: this.totalBytes,
      pendingWrites: this.pendingWrites,
      resizeEvents: this.resizeEvents,
      bufferLines: active.length,
      baseY: active.baseY,
      cursorY: active.cursorY,
      cursorX: active.cursorX,
      lastEvents: [...this.lastEvents],
      tailPreview: this.previewText(snapshot.lines.slice(-tailLines).join('\n'))
    };
  }

  dispose() {
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }

  hookBufferTrim() {
    const lines = this.term && this.term._core && this.term._core.buffer && this.term._core.buffer.lines;
    if (!lines || typeof lines.trimStart !== 'function') return;

    const originalPush = lines.push.bind(lines);
    lines.push = (value) => {
      if (lines.isFull) {
        const line = lines.get(0);
        this.archiveLines([line ? line.translateToString(true) : '']);
      }
      return originalPush(value);
    };

    if (typeof lines.recycle === 'function') {
      const originalRecycle = lines.recycle.bind(lines);
      lines.recycle = () => {
        if (lines.isFull) {
          const line = lines.get(0);
          this.archiveLines([line ? line.translateToString(true) : '']);
        }
        return originalRecycle();
      };
    }

    const originalTrimStart = lines.trimStart.bind(lines);
    lines.trimStart = (amount) => {
      const removed = [];
      for (let i = 0; i < amount; i++) {
        const line = lines.get(i);
        removed.push(line ? line.translateToString(true) : '');
      }
      this.archiveLines(removed);
      return originalTrimStart(amount);
    };
  }

  archiveLines(lines) {
    if (!lines || lines.length === 0) return;
    for (const line of lines) {
      this.archivedLines.push(line);
      this.archivedBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    this.trimArchivedBytes();
  }

  buildSnapshot() {
    const active = this.term.buffer.active;
    let lines = [...this.archivedLines];

    for (let i = 0; i < active.length; i++) {
      const line = active.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }

    let truncated = false;

    let bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    while (bytes > this.maxBytes && lines.length > 1) {
      const removed = lines.shift();
      bytes -= Buffer.byteLength(removed, 'utf8') + 1;
      truncated = true;
    }

    if (bytes > this.maxBytes && lines.length === 1) {
      const line = lines[0];
      const keepChars = Math.max(1, Math.floor(this.maxBytes / 2));
      lines[0] = line.slice(-keepChars);
      bytes = Buffer.byteLength(lines[0], 'utf8');
      truncated = true;
    }

    const text = lines.join('\n').replace(/\s+$/g, '');
    this.truncated = truncated;
    return {
      lines,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      truncated
    };
  }

  recordEvent(message) {
    this.lastEvents.push(`${new Date().toISOString()} ${message}`);
    if (this.lastEvents.length > 25) this.lastEvents.shift();
  }

  trimArchivedBytes() {
    while (this.archivedBytes > this.maxBytes && this.archivedLines.length > 0) {
      const removed = this.archivedLines.shift();
      this.archivedBytes -= Buffer.byteLength(removed, 'utf8') + 1;
      this.truncated = true;
    }
  }

  previewText(text, maxChars = 400) {
    if (!text) return '';
    const normalized = String(text)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\x1b/g, '\\x1b');
    return normalized.length > maxChars ? normalized.slice(-maxChars) : normalized;
  }
}

module.exports = RenderedHistory;
