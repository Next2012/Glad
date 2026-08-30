const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');

test('stages matching packages with the publishable Windows name', t => {
  const version = '9.8.7-test.1';
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-npm-stage-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(temporaryRoot, 'artifacts');
  const outputRoot = path.join(temporaryRoot, 'staged');
  fs.mkdirSync(artifactRoot);
  for (const artifact of [
    'glad-linux-amd64',
    'glad-linux-arm64',
    'glad-macos-x64',
    'glad-macos-arm64',
    'glad-windows-amd64.exe'
  ]) {
    fs.writeFileSync(path.join(artifactRoot, artifact), artifact);
  }

  const result = spawnSync(
    process.execPath,
    ['scripts/stage-npm-packages.js', version, artifactRoot, outputRoot],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);

  const main = require(path.join(outputRoot, 'main/package.json'));
  const windows = require(path.join(outputRoot, 'platforms/win32-x64/package.json'));
  assert.equal(main.version, version);
  assert.equal(main.optionalDependencies['glad-web-windows-x64'], version);
  assert.equal(main.optionalDependencies['glad-web-win32-x64'], undefined);
  assert.equal(windows.name, 'glad-web-windows-x64');
  assert.equal(windows.version, version);

  const launcher = fs.readFileSync(path.join(outputRoot, 'main/bin/glad.cjs'), 'utf8');
  assert.match(launcher, /'win32-x64': \['glad-web-windows-x64', 'bin\/glad\.exe'\]/);
});
