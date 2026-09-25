// Desktop browser engines cannot open a phone's software keyboard. Resize and
// pan the visual viewport independently of the layout viewport instead.
async function mockVisualViewport(page, { iosStandalone = false } = {}) {
  await page.addInitScript(({ iosStandalone }) => {
    if (iosStandalone) {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    }
    const nativeViewport = window.visualViewport;
    const viewport = new EventTarget();
    const state = {};
    for (const key of ['height', 'offsetTop', 'scale']) {
      Object.defineProperty(viewport, key, { get: () => state[key] ?? nativeViewport[key] });
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.setTestVisualViewport = (next, event = 'resize') => {
      Object.assign(state, next);
      viewport.dispatchEvent(new Event(event));
    };
  }, { iosStandalone });
}

module.exports = { mockVisualViewport };
