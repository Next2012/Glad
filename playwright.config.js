const { defineConfig } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const providerBin = path.join(__dirname, 'tests', 'e2e', 'fixtures', 'bin');
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
    browserName: 'chromium',
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
      PATH: `${providerBin}${path.delimiter}${process.env.PATH || ''}`
    },
    reuseExistingServer: !process.env.CI,
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
