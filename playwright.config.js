const { defineConfig } = require('@playwright/test');
const path = require('node:path');

const providerBin = path.join(__dirname, 'tests', 'e2e', 'fixtures', 'bin');
const port = Number(process.env.GLAD_E2E_PORT || 3001);

module.exports = defineConfig({
  testDir: './tests/e2e',
  outputDir: '.playwright-results',
  fullyParallel: false,
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
