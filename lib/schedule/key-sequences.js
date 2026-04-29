const KEY_SEQUENCES = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F'
};

function ctrlSequence(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (normalized.length !== 1) return null;
  const code = normalized.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  if (normalized === '[') return '\x1b';
  if (normalized === ']') return '\x1d';
  if (normalized === '\\') return '\x1c';
  if (normalized === '^') return '\x1e';
  if (normalized === '_') return '\x1f';
  return null;
}

function sequenceForKey(key, modifiers = {}) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return '';

  if (normalized.startsWith('ctrl+')) {
    return ctrlSequence(normalized.slice(5)) || '';
  }

  if (modifiers.ctrl) {
    const sequence = ctrlSequence(normalized);
    if (sequence) return sequence;
  }

  const sequence = KEY_SEQUENCES[normalized] || normalized;
  return modifiers.alt ? '\x1b' + sequence : sequence;
}

module.exports = {
  sequenceForKey
};
