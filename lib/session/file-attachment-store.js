const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PER_SESSION = 8;
const MAX_CHUNKS = 128;
const CLEANUP_DELAY_MS = 30 * 60 * 1000;

function inputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeUploadId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(value);
}

function safeFileName(value) {
  let decoded = String(value || 'attachment.bin');
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  const base = decoded.replace(/\\/g, '/').split('/').pop() || 'attachment.bin';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().slice(0, 160);
  return cleaned || 'attachment.bin';
}

class FileAttachmentStore {
  constructor({ logger, root, uploadRoot } = {}) {
    this.logger = logger || console;
    this.root = root || path.join(os.tmpdir(), 'glad', 'session-files');
    this.uploadRoot = uploadRoot || path.join(os.tmpdir(), 'glad', 'session-file-uploads');
  }

  assertSession(session) {
    if (!session) throw inputError('Session not found', 404);
    if (!session.fileAttachments || !session.fileUploads) throw inputError('File attachments are unavailable for this session');
  }

  async appendChunk(session, input = {}, bytes) {
    this.assertSession(session);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw inputError('File chunk is required');
    const uploadId = String(input.uploadId || '');
    const chunkIndex = Number(input.chunkIndex);
    const chunkTotal = Number(input.chunkTotal);
    const name = safeFileName(input.name);
    if (!safeUploadId(uploadId)) throw inputError('Invalid file upload id');
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(chunkTotal) || chunkIndex < 0 || chunkTotal < 1 || chunkTotal > MAX_CHUNKS || chunkIndex >= chunkTotal) {
      throw inputError('Invalid file chunk metadata');
    }

    let upload = session.fileUploads.get(uploadId);
    if (!upload) {
      if (chunkIndex !== 0) throw inputError('File upload must start with the first chunk');
      const directory = path.join(this.uploadRoot, session.id);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      upload = { id: uploadId, name, path: path.join(directory, `${uploadId}.part`), chunkTotal, nextChunkIndex: 0, bytes: 0 };
      session.fileUploads.set(uploadId, upload);
    }
    if (upload.name !== name || upload.chunkTotal !== chunkTotal || upload.nextChunkIndex !== chunkIndex) {
      throw inputError('File chunks arrived out of order');
    }
    if (upload.bytes + bytes.length > MAX_BYTES) {
      await this.discardUpload(session, uploadId);
      throw inputError('File must be 50 MB or smaller');
    }

    if (chunkIndex === 0) await fs.promises.writeFile(upload.path, bytes, { mode: 0o600, flag: 'wx' });
    else await fs.promises.appendFile(upload.path, bytes, { mode: 0o600 });
    upload.bytes += bytes.length;
    upload.nextChunkIndex += 1;
    if (upload.nextChunkIndex < upload.chunkTotal) {
      return { complete: false, receivedChunks: upload.nextChunkIndex, size: upload.bytes };
    }

    const pendingAttachmentCount = Array.from(session.fileAttachments.values()).filter(item => !item.sent).length;
    if (pendingAttachmentCount >= MAX_PER_SESSION) {
      await this.discardUpload(session, uploadId);
      throw inputError(`You can attach at most ${MAX_PER_SESSION} files at a time`);
    }
    const directory = path.join(this.root, session.id);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const attachment = {
      id: uuidv4(),
      name: upload.name,
      path: path.join(directory, `${uuidv4()}-${upload.name}`),
      size: upload.bytes,
      createdAt: Date.now(),
      cleanupTimer: null
    };
    session.fileUploads.delete(uploadId);
    try {
      await fs.promises.rename(upload.path, attachment.path);
      await fs.promises.chmod(attachment.path, 0o600);
      session.fileAttachments.set(attachment.id, attachment);
      return { complete: true, attachment: { id: attachment.id, name: attachment.name, size: attachment.size, kind: 'file' } };
    } catch (error) {
      await fs.promises.rm(upload.path, { force: true });
      throw error;
    }
  }

  async discardUpload(session, uploadId) {
    if (!session?.fileUploads || !safeUploadId(uploadId)) return false;
    const upload = session.fileUploads.get(uploadId);
    if (!upload) return false;
    session.fileUploads.delete(uploadId);
    await fs.promises.rm(upload.path, { force: true });
    return true;
  }

  async discardAttachment(session, attachmentId) {
    if (!session?.fileAttachments) return false;
    const attachment = session.fileAttachments.get(attachmentId);
    if (!attachment) return false;
    clearTimeout(attachment.cleanupTimer);
    session.fileAttachments.delete(attachmentId);
    await fs.promises.rm(attachment.path, { force: true });
    return true;
  }

  resolve(session, attachmentIds = []) {
    const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
    if (!session) throw inputError('Session not found', 404);
    if (ids.length === 0) return [];
    this.assertSession(session);
    if (ids.length > MAX_PER_SESSION) throw inputError(`You can attach at most ${MAX_PER_SESSION} files at a time`);
    const uniqueIds = [...new Set(ids.map(String))];
    if (uniqueIds.length !== ids.length) throw inputError('Duplicate file attachment');
    return uniqueIds.map(attachmentId => {
      const attachment = session.fileAttachments.get(attachmentId);
      if (!attachment) throw inputError('File attachment is no longer available');
      return attachment;
    });
  }

  scheduleCleanup(session, attachmentIds) {
    if (!session?.fileAttachments) return;
    for (const attachmentId of attachmentIds) {
      const attachment = session.fileAttachments.get(attachmentId);
      if (!attachment) continue;
      attachment.sent = true;
      clearTimeout(attachment.cleanupTimer);
      attachment.cleanupTimer = setTimeout(() => {
        this.discardAttachment(session, attachmentId).catch(error => {
          this.logger.debugInfo?.(`[file-attachment] cleanup failed: ${error.message}`);
        });
      }, CLEANUP_DELAY_MS);
      attachment.cleanupTimer.unref?.();
    }
  }

  clear(session) {
    if (!session) return;
    for (const attachment of session.fileAttachments?.values?.() || []) clearTimeout(attachment.cleanupTimer);
    session.fileAttachments?.clear?.();
    session.fileUploads?.clear?.();
    fs.promises.rm(path.join(this.root, session.id), { recursive: true, force: true }).catch(error => {
      this.logger.debugInfo?.(`[file-attachment] cleanup failed: ${error.message}`);
    });
    fs.promises.rm(path.join(this.uploadRoot, session.id), { recursive: true, force: true }).catch(error => {
      this.logger.debugInfo?.(`[file-upload] cleanup failed: ${error.message}`);
    });
  }
}

module.exports = FileAttachmentStore;
