const { defineConfig } = require('@playwright/test');
const shared = require('./playwright.config');

// Linux WebKit transport and desktop workspace coverage, not an Apple device emulator.
module.exports = defineConfig({
  ...shared,
  testMatch: ['**/websocket-transport.spec.js', '**/workspace-tabs.spec.js'],
  projects: [{
    name: 'Linux WebKit transport',
    testMatch: '**/websocket-transport.spec.js',
    use: { browserName: 'webkit', viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true }
  }, {
    name: 'Linux WebKit desktop',
    testMatch: '**/workspace-tabs.spec.js',
    use: { browserName: 'webkit', viewport: { width: 1728, height: 1117 } }
  }]
});
