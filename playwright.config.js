const { defineConfig } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const providerBin = path.join(__dirname, 'tests', 'e2e', 'fixtures', 'bin');
// Keep read-only Go module-cache directories out of the disposable application
// HOME. Non-root CI workers must be able to remove that HOME after each run.
const goEnvironment = spawnSync('go', ['env', 'GOPATH', 'GOCACHE'], { encoding:'utf8' });
if (goEnvironment.status !== 0) throw new Error(`Unable to locate Go caches: ${goEnvironment.stderr}`);
const [goPath, goCache] = goEnvironment.stdout.trim().split(/\r?\n/);
const port = Number(process.env.GLAD_E2E_PORT || 3001);
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-e2e-'));
const testCodexHome = path.join(testHome, '.codex');
fs.mkdirSync(testCodexHome, { recursive: true });
process.once('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

module.exports = defineConfig({
  testDir: './tests/e2e',
  outputDir: '.playwright-results',
  fullyParallel: false,
  // Every project shares one stateful Glad daemon. Serial workers keep session
  // create/delete flows isolated while individual browser interactions remain
  // representative of production behavior.
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: process.env.GLAD_E2E_BROWSER || 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `go run . --port ${port}`,
    url: `http://127.0.0.1:${port}/api/config`,
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      CODEX_HOME: testCodexHome,
      GOPATH: goPath,
      GOCACHE: goCache,
      GLAD_CCUSAGE_BIN: path.join(providerBin, 'ccusage'),
      PATH: `${providerBin}${path.delimiter}${process.env.PATH || ''}`
    },
    // Never point E2E writes at a developer's already-running Glad instance.
    // The spawned daemon receives an isolated HOME; reusing a live server
    // would bypass that boundary and can create/delete real rooms or sessions.
    reuseExistingServer: false,
    timeout: 120000
  },
  projects: [
    {
      name: 'iPhone 17 Pro Max',
      use: {
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true
      }
    },
    {
      name: 'iPad Air 7',
      use: {
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true
      }
    },
    {
      name: 'MacBook Pro 16',
      use: {
        viewport: { width: 1728, height: 1117 },
        deviceScaleFactor: 2
      }
    }
  ]
});
