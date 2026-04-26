class TextHistory {
  constructor(options = {}) {
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.maxLines = options.maxLines || 20000;
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.updatedAt = Date.now();
    this.truncated = false;
  }

  write(data) {
    if (!data) return;
    const text = String(data);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '\x1b') {
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
      this.eraseLine(first);
      return;
    }

    if (command === 'J') {
      if (first === 2 || first === 3) this.clear();
      return;
    }

    if (command === 'H' || command === 'f') {
      this.row = Math.max(0, (values[0] || 1) - 1);
      this.col = Math.max(0, (values[1] || 1) - 1);
      this.ensureRow();
      return;
    }

    if (command === 'A') {
      this.row = Math.max(0, this.row - (first || 1));
      return;
    }

    if (command === 'B') {
      this.row += first || 1;
      this.ensureRow();
      return;
    }

    if (command === 'C') {
      this.col += first || 1;
      return;
    }

    if (command === 'D') {
      this.col = Math.max(0, this.col - (first || 1));
      return;
    }

    if (command === 'G') {
      this.col = Math.max(0, (first || 1) - 1);
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

  clear() {
    this.lines = [''];
    this.row = 0;
    this.col = 0;
  }

  trim() {
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.row = Math.max(0, this.row - 1);
      this.truncated = true;
    }

    let bytes = Buffer.byteLength(this.lines.join('\n'), 'utf8');
    while (bytes > this.maxBytes && this.lines.length > 1) {
      const removed = this.lines.shift();
      bytes -= Buffer.byteLength(removed, 'utf8') + 1;
      this.row = Math.max(0, this.row - 1);
      this.truncated = true;
    }

    if (bytes > this.maxBytes && this.lines.length === 1) {
      const keepChars = Math.floor(this.maxBytes / 2);
      this.lines[0] = this.lines[0].slice(-keepChars);
      this.col = Math.min(this.col, this.lines[0].length);
      this.truncated = true;
    }
  }
}

module.exports = TextHistory;
