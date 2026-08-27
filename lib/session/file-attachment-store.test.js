const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FileAttachmentStore = require('./file-attachment-store');

test('stores a sanitized chunked file privately and removes it', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-file-store-'));
  const store = new FileAttachmentStore({ root: path.join(temp, 'files'), uploadRoot: path.join(temp, 'uploads'), logger: { debugInfo() {} } });
  const session = { id: 'session-file-test', fileAttachments: new Map(), fileUploads: new Map() };
  const bytes = Buffer.from('attachment contents');

  const result = await store.appendChunk(session, {
    uploadId: 'file-upload-1234', chunkIndex: 0, chunkTotal: 1,
    name: encodeURIComponent('../report:final.pdf')
  }, bytes);

  assert.equal(result.complete, true);
  assert.equal(result.attachment.name, 'report_final.pdf');
  const stored = session.fileAttachments.get(result.attachment.id);
  assert.equal(stored.path.startsWith(path.join(temp, 'files', session.id)), true);
  assert.deepEqual(await fs.promises.readFile(stored.path), bytes);
  if (process.platform !== 'win32') assert.equal((await fs.promises.stat(stored.path)).mode & 0o777, 0o600);

  assert.deepEqual(store.resolve(session, [stored.id]), [stored]);
  assert.throws(() => store.resolve(session, [stored.id, stored.id]), /Duplicate file attachment/);
  assert.equal(await store.discardAttachment(session, stored.id), true);
  assert.equal(fs.existsSync(stored.path), false);
  await fs.promises.rm(temp, { recursive: true, force: true });
});

test('rejects out-of-order file chunks', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-file-store-order-'));
  const store = new FileAttachmentStore({ root: path.join(temp, 'files'), uploadRoot: path.join(temp, 'uploads') });
  const session = { id: 'session-file-order', fileAttachments: new Map(), fileUploads: new Map() };
  await assert.rejects(store.appendChunk(session, {
    uploadId: 'file-upload-5678', chunkIndex: 1, chunkTotal: 2, name: 'notes.txt'
  }, Buffer.from('second')), /must start with the first chunk/);
  await fs.promises.rm(temp, { recursive: true, force: true });
});
