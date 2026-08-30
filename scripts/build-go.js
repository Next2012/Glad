const { spawnSync } = require('child_process');
const packageJson = require('../package.json');

const [goos, goarch, output] = process.argv.slice(2);
if (!goos || !goarch || !output) {
  throw new Error('Usage: node scripts/build-go.js <goos> <goarch> <output>');
}

const result = spawnSync('go', [
  'build',
  '-trimpath',
  '-ldflags', `-s -w -X main.version=${packageJson.version}`,
  '-o', output,
  '.'
], {
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
});

if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
