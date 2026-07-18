const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WorkspaceService = require('./service');

test('resolves files inside the workspace and rejects parent traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-workspace-'));
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'inside');
  const service = new WorkspaceService();

  assert.equal(service.readFile(root, 'file.txt'), 'inside');
  assert.throws(() => service.readFile(root, '../outside.txt'), /ENOENT|Access denied/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('does not follow a workspace symlink outside the workspace', { skip: process.platform === 'win32' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-workspace-link-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  const service = new WorkspaceService();

  assert.throws(() => service.readFile(root, 'linked/secret.txt'), /Access denied/);
  fs.rmSync(parent, { recursive: true, force: true });
});
