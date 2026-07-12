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
    timedInputs: new Map(),
    sendUserMessage: async () => true
  };
  manager.sessions.set(id, session);
  return session;
}

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
