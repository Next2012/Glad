class TextHistory {
  constructor(options = {}) {
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.debugLabel = options.debugLabel || 'session';
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.updatedAt = Date.now();
    this.truncated = false;
    this.totalWrites = 0;
    this.totalBytes = 0;
    this.escapeCount = 0;
    this.clearEvents = 0;
    this.eraseLineEvents = 0;
    this.cursorMoveEvents = 0;
    this.trimEvents = 0;
    this.lastEvents = [];
  }

  write(data) {
    if (!data) return;
    const text = String(data);
    this.totalWrites += 1;
    this.totalBytes += Buffer.byteLength(text, 'utf8');

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '\x1b') {
        this.escapeCount += 1;
        i = this.skipEscape(text, i);
        continue;
      }

      if (ch === '\r') {
        this.col = 0;
        continue;
      }

      if (ch === '\n') {
        this.newLine();
        continue;
      }

      if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
        continue;
      }

      if (ch === '\t') {
        const spaces = 4 - (this.col % 4);
        for (let j = 0; j < spaces; j++) this.writeChar(' ');
        continue;
      }

      if (ch >= ' ' || ch === '\u00a0') {
        this.writeChar(ch);
      }
    }

    this.updatedAt = Date.now();
    this.trim();
  }

  toJSON() {
    return {
      text: this.toString(),
      updatedAt: this.updatedAt,
      truncated: this.truncated,
      bytes: Buffer.byteLength(this.toString(), 'utf8'),
      lines: this.lines.length
    };
  }

  getDebugSnapshot(options = {}) {
    const tailLines = options.tailLines || 12;
    return {
      label: this.debugLabel,
      updatedAt: this.updatedAt,
      truncated: this.truncated,
      row: this.row,
      col: this.col,
      lines: this.lines.length,
      bytes: Buffer.byteLength(this.lines.join('\n'), 'utf8'),
      totalWrites: this.totalWrites,
      totalBytes: this.totalBytes,
      escapeCount: this.escapeCount,
      clearEvents: this.clearEvents,
      eraseLineEvents: this.eraseLineEvents,
      cursorMoveEvents: this.cursorMoveEvents,
      trimEvents: this.trimEvents,
      lastEvents: [...this.lastEvents],
      tailPreview: this.previewText(this.lines.slice(-tailLines).join('\n'))
    };
  }

  toString() {
    return this.lines.join('\n').replace(/\s+$/g, '');
  }

  writeChar(ch) {
    this.ensureRow();
    const line = this.lines[this.row] || '';
    const padded = line.length < this.col ? line + ' '.repeat(this.col - line.length) : line;
    this.lines[this.row] = padded.slice(0, this.col) + ch + padded.slice(this.col + 1);
    this.col += 1;
  }

  newLine() {
    this.row += 1;
    this.col = 0;
    this.ensureRow();
  }

  ensureRow() {
    while (this.row >= this.lines.length) {
      this.lines.push('');
    }
  }

  skipEscape(text, index) {
    const next = text[index + 1];

    if (next === ']') {
      return this.skipOsc(text, index + 2);
    }

    if (next === '[') {
      return this.handleCsi(text, index + 2);
    }

    return Math.min(index + 1, text.length - 1);
  }

  skipOsc(text, index) {
    for (let i = index; i < text.length; i++) {
      if (text[i] === '\x07') return i;
      if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 1;
    }
    return text.length - 1;
  }

  handleCsi(text, index) {
    let i = index;
    while (i < text.length && !/[A-Za-z@`~]/.test(text[i])) {
      i++;
    }
    if (i >= text.length) return text.length - 1;

    const params = text.slice(index, i);
    const command = text[i];
    this.applyCsi(params, command);
    return i;
  }

  applyCsi(params, command) {
    const values = params
      .replace(/[?>!]/g, '')
      .split(';')
      .filter(Boolean)
      .map(value => Number.parseInt(value, 10))
      .map(value => Number.isFinite(value) ? value : 0);
    const first = values[0] || 0;

    if (command === 'K') {
      this.eraseLineEvents += 1;
      this.recordEvent(`CSI K(${first})`);
      this.eraseLine(first);
      return;
    }

    if (command === 'J') {
      if (first === 2 || first === 3) {
        this.clearEvents += 1;
        this.recordEvent(`CSI J(${first}) ignored-clear`);
        this.startFreshLineAfterClear();
      }
      return;
    }

    if (command === 'H' || command === 'f') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI ${command}(${params || ''}) ignored-cursor`);
      return;
    }

    if (command === 'A') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI A(${first || 1}) ignored-cursor`);
      return;
    }

    if (command === 'B') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI B(${first || 1}) ignored-cursor`);
      return;
    }

    if (command === 'C') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI C(${first || 1}) ignored-cursor`);
      return;
    }

    if (command === 'D') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI D(${first || 1}) ignored-cursor`);
      return;
    }

    if (command === 'G') {
      this.cursorMoveEvents += 1;
      this.recordEvent(`CSI G(${first || 1}) ignored-cursor`);
    }
  }

  eraseLine(mode) {
    this.ensureRow();
    const line = this.lines[this.row] || '';
    if (mode === 1) {
      this.lines[this.row] = ' '.repeat(Math.min(this.col, line.length)) + line.slice(this.col);
    } else if (mode === 2) {
      this.lines[this.row] = '';
      this.col = 0;
    } else {
      this.lines[this.row] = line.slice(0, this.col);
    }
  }

  startFreshLineAfterClear() {
    const hasContent = this.lines.some(line => line.length > 0);
    const currentLine = this.lines[this.row] || '';
    if (hasContent && currentLine.length > 0) this.newLine();
    this.row = this.lines.length - 1;
    this.col = 0;
    this.lines[this.row] = '';
  }

  trim() {
    let bytes = Buffer.byteLength(this.lines.join('\n'), 'utf8');
    while (bytes > this.maxBytes && this.lines.length > 1) {
      const removed = this.lines.shift();
      bytes -= Buffer.byteLength(removed, 'utf8') + 1;
      this.row = Math.max(0, this.row - 1);
      this.truncated = true;
      this.trimEvents += 1;
    }

    if (bytes > this.maxBytes && this.lines.length === 1) {
      const keepChars = Math.floor(this.maxBytes / 2);
      this.lines[0] = this.lines[0].slice(-keepChars);
      this.col = Math.min(this.col, this.lines[0].length);
      this.truncated = true;
      this.trimEvents += 1;
    }
  }

  recordEvent(message) {
    this.lastEvents.push(`${new Date().toISOString()} ${message}`);
    if (this.lastEvents.length > 25) this.lastEvents.shift();
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

module.exports = TextHistory;
