const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SessionManager = require('./session-manager');

function createManager() {
  return new SessionManager({
    baseDir: process.cwd(),
    logger: { debugInfo() {} }
  });
}

function addCodexSession(manager, id = 'codex-image-test') {
  const session = {
    id,
    kind: 'codex-structured',
    presentation: 'structured',
    imageAttachments: new Map(),
    fileAttachments: new Map(),
    fileUploads: new Map(),
    timedInputs: new Map(),
    sendUserMessage: async () => true
  };
  manager.sessions.set(id, session);
  return session;
}

function addClaudeSession(manager, id = 'claude-image-test') {
  const session = {
    id,
    name: 'Claude Work',
    kind: 'claude-structured',
    status: 'idle',
    workingDir: '/tmp/project',
    tool: { key: 'claude-code', displayName: 'Claude Code', command: 'claude' },
    imageAttachments: new Map(),
    imageUploads: new Map(),
    fileAttachments: new Map(),
    fileUploads: new Map(),
    pendingPermissions: new Map(),
    timedInputs: new Map(),
    messages: [],
    sendUserMessage: () => true
  };
  manager.sessions.set(id, session);
  return session;
}

test('switches the current Glad session to a selected Codex thread fork', async () => {
  const manager = createManager();
  const source = {
    id: 'source-session',
    kind: 'codex-structured',
    presentation: 'structured',
    status: 'idle',
    threadId: null,
    name: 'Codex Work',
    tool: { key: 'codex', displayName: 'Codex', command: 'codex' },
    workingDir: '/tmp/project',
    hasModelOverride: true,
    hasEffortOverride: true,
    model: 'gpt-test',
    effort: 'high',
    permissionMode: 'on-request',
    sandboxMode: 'workspace-write',
    forkFrom: async threadId => {
      assert.equal(threadId, 'thread-selected');
      source.threadId = 'thread-forked';
      return { threadId: source.threadId };
    }
  };
  manager.sessions.set(source.id, source);

  const result = await manager.forkCodex(source.id, 'thread-selected');

  assert.equal(result, source);
  assert.equal(source.threadId, 'thread-forked');
  assert.equal(source.forkedFromThreadId, 'thread-selected');
  assert.equal(manager.sessions.size, 1);
});

test('forks a Claude session through the SDK and switches the current conversation', async () => {
  const manager = new SessionManager({
    baseDir: process.cwd(),
    logger: { debugInfo() {} },
    claudeForkSession: async (sourceId, options) => {
      assert.equal(sourceId, 'claude-source');
      assert.deepEqual(options, { dir: '/tmp/project' });
      return { sessionId: 'claude-forked' };
    },
    claudeTranscriptRepository: {
      list: () => [],
      readMessages: (_cwd, id) => [{ id: 'history-1', kind: 'user', text: `history for ${id}` }]
    }
  });
  const session = addClaudeSession(manager, 'claude-fork-test');
  session.claudeSessionId = 'claude-source';
  session.selectResumeSession = (id, history) => {
    session.claudeSessionId = id;
    session.messages = history;
    return true;
  };
  session.appendMessage = message => session.messages.push(message);

  const result = await manager.forkClaude(session.id, 'claude-source');

  assert.equal(result.claudeSessionId, 'claude-forked');
  assert.equal(session.claudeSessionId, 'claude-forked');
  assert.equal(session.messages[0].text, 'history for claude-forked');
  assert.match(session.messages[1].text, /Forked from Claude session claude-source/);
});

test('stores and prepares a Claude image without changing the Codex send path', async () => {
  const manager = createManager();
  manager.codexImageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-claude-images-'));
  const session = addClaudeSession(manager);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  let sent = null;
  session.sendUserMessage = (text, attachments) => {
    sent = { text, attachments };
    return true;
  };

  const attachment = await manager.storeImageAttachment(session.id, png);
  assert.equal(await manager.sendClaudeInput(session.id, 'inspect', [attachment.id]), true);
  assert.equal(sent.text, 'inspect');
  assert.equal(sent.attachments[0].mediaType, 'image/png');
  assert.equal(sent.attachments[0].data, png.toString('base64'));

  manager.clearCodexImageAttachments(session);
  await fs.promises.rm(manager.codexImageRoot, { recursive: true, force: true });
});

test('sends a private file reference to Claude while displaying only its name', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-files-'));
  const manager = createManager();
  manager.fileAttachmentStore.root = path.join(temp, 'files');
  manager.fileAttachmentStore.uploadRoot = path.join(temp, 'uploads');
  const session = addClaudeSession(manager, 'claude-file-test');
  let sent = null;
  session.sendUserMessage = (text, images, options) => {
    sent = { text, images, options };
    return true;
  };
  const uploaded = await manager.appendFileChunk(session.id, {
    uploadId: 'claude-file-upload', chunkIndex: 0, chunkTotal: 1, name: 'requirements.txt'
  }, Buffer.from('express@5'));

  assert.equal(await manager.sendClaudeInput(session.id, 'Review this file', [], [uploaded.attachment.id]), true);
  assert.equal(sent.text, 'Review this file');
  assert.match(sent.options.agentText, /Review this file/);
  assert.match(sent.options.agentText, /requirements\.txt:/);
  assert.equal(sent.options.agentText.includes(manager.fileAttachmentStore.root), true);
  assert.deepEqual(sent.options.displayAttachments.map(item => ({ name: item.name, kind: item.kind })), [
    { name: 'requirements.txt', kind: 'file' }
  ]);
  manager.fileAttachmentStore.clear(session);
  await fs.promises.rm(temp, { recursive: true, force: true });
});

test('sends a private file reference through the Codex text input', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-codex-files-'));
  const manager = createManager();
  manager.fileAttachmentStore.root = path.join(temp, 'files');
  manager.fileAttachmentStore.uploadRoot = path.join(temp, 'uploads');
  const session = addCodexSession(manager, 'codex-file-test');
  session.fileUploads = new Map();
  let sent = null;
  session.sendUserMessage = async (text, images, skills, options) => {
    sent = { text, images, skills, options };
    return true;
  };
  const uploaded = await manager.appendFileChunk(session.id, {
    uploadId: 'codex-file-upload', chunkIndex: 0, chunkTotal: 1, name: 'design.md'
  }, Buffer.from('# Design'));

  assert.equal(await manager.sendCodexInput(session.id, 'Review', [], [], [uploaded.attachment.id]), true);
  assert.equal(sent.text, 'Review');
  assert.match(sent.options.agentText, /design\.md:/);
  assert.equal(sent.options.displayAttachments[0].kind, 'file');
  manager.fileAttachmentStore.clear(session);
  await fs.promises.rm(temp, { recursive: true, force: true });
});

test('stores validated Codex images outside the workspace and removes them on request', async () => {
  const manager = createManager();
  manager.codexImageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-images-'));
  const session = addCodexSession(manager);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

  const attachment = await manager.storeCodexImageAttachment(session.id, png);
  const internal = session.imageAttachments.get(attachment.id);
  assert.equal(attachment.name, 'image.png');
  assert.equal(fs.existsSync(internal.path), true);
  assert.equal(internal.path.startsWith(manager.codexImageRoot), true);

  assert.equal(await manager.discardCodexImageAttachment(session.id, attachment.id), true);
  assert.equal(fs.existsSync(internal.path), false);
  await fs.promises.rm(manager.codexImageRoot, { recursive: true, force: true });
});

test('rejects non-image uploads before writing a temporary file', async () => {
  const manager = createManager();
  manager.codexImageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-images-'));
  const session = addCodexSession(manager, 'codex-invalid-image-test');

  await assert.rejects(
    manager.storeCodexImageAttachment(session.id, Buffer.from('not an image')),
    /Only PNG, JPEG, GIF, and WebP/
  );
  assert.equal(session.imageAttachments.size, 0);
  await fs.promises.rm(manager.codexImageRoot, { recursive: true, force: true });
});

test('assembles ordered image chunks before creating a Codex attachment', async () => {
  const manager = createManager();
  manager.codexImageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-images-'));
  manager.codexImageUploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-test-image-chunks-'));
  const session = addCodexSession(manager, 'codex-chunk-image-test');
  session.imageUploads = new Map();
  const image = Buffer.alloc(1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);

  const first = await manager.appendCodexImageChunk(session.id, {
    uploadId: 'chunk-upload-1234', chunkIndex: 0, chunkTotal: 2
  }, image.subarray(0, 512));
  assert.deepEqual(first, { complete: false, receivedChunks: 1, size: 512 });

  const last = await manager.appendCodexImageChunk(session.id, {
    uploadId: 'chunk-upload-1234', chunkIndex: 1, chunkTotal: 2
  }, image.subarray(512));
  assert.equal(last.complete, true);
  assert.equal(last.attachment.size, 1024);
  assert.equal(session.imageUploads.size, 0);
  await fs.promises.rm(manager.codexImageRoot, { recursive: true, force: true });
  await fs.promises.rm(manager.codexImageUploadRoot, { recursive: true, force: true });
});
