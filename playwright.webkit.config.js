const { defineConfig } = require('@playwright/test');
const shared = require('./playwright.config');

// Transport-only coverage on Linux WebKit, not an Apple device emulator.
module.exports = defineConfig({
  ...shared,
  testMatch: '**/websocket-transport.spec.js',
  projects: [{
    name: 'Linux WebKit transport',
    use: { browserName: 'webkit', viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true }
  }]
});
