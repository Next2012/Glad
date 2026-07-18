const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PER_SESSION = 5;
const CLEANUP_DELAY_MS = 5 * 60 * 1000;
const MAX_CHUNKS = 128;

function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function inputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeUploadId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(value);
}

class CodexImageStore {
  constructor({ logger, root, uploadRoot } = {}) {
    this.logger = logger || console;
    this.root = root || path.join(os.tmpdir(), 'glad', 'codex-images');
    this.uploadRoot = uploadRoot || path.join(os.tmpdir(), 'glad', 'codex-image-uploads');
  }

  assertSession(session) {
    if (!session) throw inputError('Session not found', 404);
    const structured = session.kind === 'claude-structured'
      || (session.kind === 'codex-structured' && session.presentation === 'structured');
    if (!structured) {
      throw inputError('Image attachments are available only in structured chat mode');
    }
  }

  async store(session, bytes) {
    this.assertSession(session);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw inputError('Image data is required');
    if (bytes.length > MAX_BYTES) throw inputError('Image must be 50 MB or smaller');
    if (session.imageAttachments.size >= MAX_PER_SESSION) throw inputError(`You can attach at most ${MAX_PER_SESSION} images at a time`);

    const extension = imageExtension(bytes);
    if (!extension) throw inputError('Only PNG, JPEG, GIF, and WebP images are supported');
    const directory = path.join(this.root, session.id);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const attachment = {
      id: uuidv4(),
      name: `image.${extension}`,
      path: path.join(directory, `${uuidv4()}.${extension}`),
      size: bytes.length,
      createdAt: Date.now(),
      cleanupTimer: null
    };
    await fs.promises.writeFile(attachment.path, bytes, { mode: 0o600, flag: 'wx' });
    session.imageAttachments.set(attachment.id, attachment);
    return { id: attachment.id, name: attachment.name, size: attachment.size };
  }

  async appendChunk(session, input = {}, bytes) {
    this.assertSession(session);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw inputError('Image chunk is required');
    const uploadId = String(input.uploadId || '');
    const chunkIndex = Number(input.chunkIndex);
    const chunkTotal = Number(input.chunkTotal);
    if (!safeUploadId(uploadId)) throw inputError('Invalid image upload id');
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(chunkTotal) || chunkIndex < 0 || chunkTotal < 1 || chunkTotal > MAX_CHUNKS || chunkIndex >= chunkTotal) {
      throw inputError('Invalid image chunk metadata');
    }

    let upload = session.imageUploads.get(uploadId);
    if (!upload) {
      if (chunkIndex !== 0) throw inputError('Image upload must start with the first chunk');
      const directory = path.join(this.uploadRoot, session.id);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      upload = { id: uploadId, path: path.join(directory, `${uploadId}.part`), chunkTotal, nextChunkIndex: 0, bytes: 0 };
      session.imageUploads.set(uploadId, upload);
    }
    if (upload.chunkTotal !== chunkTotal || upload.nextChunkIndex !== chunkIndex) throw inputError('Image chunks arrived out of order');
    if (upload.bytes + bytes.length > MAX_BYTES) {
      await this.discardUpload(session, uploadId);
      throw inputError('Image must be 50 MB or smaller');
    }

    if (chunkIndex === 0) await fs.promises.writeFile(upload.path, bytes, { mode: 0o600, flag: 'wx' });
    else await fs.promises.appendFile(upload.path, bytes, { mode: 0o600 });
    upload.bytes += bytes.length;
    upload.nextChunkIndex += 1;
    if (upload.nextChunkIndex < upload.chunkTotal) {
      return { complete: false, receivedChunks: upload.nextChunkIndex, size: upload.bytes };
    }

    session.imageUploads.delete(uploadId);
    try {
      const attachment = await this.store(session, await fs.promises.readFile(upload.path));
      return { complete: true, attachment };
    } finally {
      await fs.promises.rm(upload.path, { force: true });
    }
  }

  async discardUpload(session, uploadId) {
    if (!session?.imageUploads || !safeUploadId(uploadId)) return false;
    const upload = session.imageUploads.get(uploadId);
    if (!upload) return false;
    session.imageUploads.delete(uploadId);
    await fs.promises.rm(upload.path, { force: true });
    return true;
  }

  async discardAttachment(session, attachmentId) {
    if (!session || !['claude-structured', 'codex-structured'].includes(session.kind)) return false;
    const attachment = session.imageAttachments.get(attachmentId);
    if (!attachment) return false;
    clearTimeout(attachment.cleanupTimer);
    session.imageAttachments.delete(attachmentId);
    await fs.promises.rm(attachment.path, { force: true });
    return true;
  }

  resolve(session, attachmentIds = []) {
    if (!session || !['claude-structured', 'codex-structured'].includes(session.kind)) throw inputError('Structured session not found', 404);
    const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
    if (ids.length > MAX_PER_SESSION) throw inputError(`You can attach at most ${MAX_PER_SESSION} images at a time`);
    const uniqueIds = [...new Set(ids.map(String))];
    if (uniqueIds.length !== ids.length) throw inputError('Duplicate image attachment');
    return uniqueIds.map(attachmentId => {
      const attachment = session.imageAttachments.get(attachmentId);
      if (!attachment) throw inputError('Image attachment is no longer available');
      return attachment;
    });
  }

  scheduleCleanup(session, attachmentIds) {
    if (!session || !['claude-structured', 'codex-structured'].includes(session.kind)) return;
    for (const attachmentId of attachmentIds) {
      const attachment = session.imageAttachments.get(attachmentId);
      if (!attachment) continue;
      clearTimeout(attachment.cleanupTimer);
      attachment.cleanupTimer = setTimeout(() => {
        this.discardAttachment(session, attachmentId).catch(error => {
          this.logger.debugInfo?.(`[structured-image] cleanup failed: ${error.message}`);
        });
      }, CLEANUP_DELAY_MS);
      attachment.cleanupTimer.unref?.();
    }
  }

  clearAttachments(session) {
    if (!session?.imageAttachments) return;
    for (const attachment of session.imageAttachments.values()) clearTimeout(attachment.cleanupTimer);
    session.imageAttachments.clear();
    fs.promises.rm(path.join(this.root, session.id), { recursive: true, force: true }).catch(error => {
      this.logger.debugInfo?.(`[structured-image] session cleanup failed: ${error.message}`);
    });
  }

  clearUploads(session) {
    if (!session?.imageUploads) return;
    session.imageUploads.clear();
    fs.promises.rm(path.join(this.uploadRoot, session.id), { recursive: true, force: true }).catch(error => {
      this.logger.debugInfo?.(`[structured-image] upload cleanup failed: ${error.message}`);
    });
  }
}

module.exports = CodexImageStore;
