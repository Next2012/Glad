const fs = require('fs');
const path = require('path');

const version = process.argv[2];
const artifactRoot = path.resolve(process.argv[3] || 'dist');
const outputRoot = path.resolve(process.argv[4] || 'dist/npm');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) {
  throw new Error('Usage: node scripts/stage-npm-packages.js <version> [artifact-directory]');
}

const packages = {
  'linux-x64': 'glad-linux-amd64',
  'linux-arm64': 'glad-linux-arm64',
  'darwin-x64': 'glad-macos-x64',
  'darwin-arm64': 'glad-macos-arm64',
  'win32-x64': 'glad-windows-amd64.exe'
};

function updateManifest(filename) {
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  manifest.version = version;
  if (manifest.optionalDependencies) {
    for (const name of Object.keys(manifest.optionalDependencies)) {
      manifest.optionalDependencies[name] = version;
    }
  }
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(path.resolve('npm/main'), path.join(outputRoot, 'main'), { recursive: true });
fs.cpSync(path.resolve('npm/platforms'), path.join(outputRoot, 'platforms'), { recursive: true });
for (const target of [path.join(outputRoot, 'main'), ...Object.keys(packages).map(name => path.join(outputRoot, 'platforms', name))]) {
  fs.copyFileSync(path.resolve('LICENSE'), path.join(target, 'LICENSE'));
  fs.copyFileSync(path.resolve('THIRD_PARTY_NOTICES.md'), path.join(target, 'THIRD_PARTY_NOTICES.md'));
}
updateManifest(path.join(outputRoot, 'main', 'package.json'));
for (const [target, artifact] of Object.entries(packages)) {
  const packageRoot = path.join(outputRoot, 'platforms', target);
  const binaryName = target.startsWith('win32') ? 'glad.exe' : 'glad';
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(artifactRoot, artifact), path.join(packageRoot, 'bin', binaryName));
  if (!target.startsWith('win32')) fs.chmodSync(path.join(packageRoot, 'bin', binaryName), 0o755);
  updateManifest(path.join(packageRoot, 'package.json'));
}
