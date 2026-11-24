// Resolve the production conversation document. Desktop conversations live in
// persistent tab frames; mobile and renderer-only harnesses use the main page.
// Keep lobby navigation, routing, screenshots and browser events on Page.
async function conversationView(page) {
  const selected = page.locator('#desktop-workspace.active .workspace-tab-panel.selected iframe');
  if (!await selected.count()) return page;
  // An iframe may still be navigating, or lose animation frames as another tab
  // becomes selected. Observe readiness from the host before binding its frame.
  await page.waitForFunction(() => Boolean(document.querySelector(
    '#desktop-workspace.active .workspace-tab-panel.selected iframe'
  )?.contentWindow?.gladTabs), null, { polling: 50, timeout: 10000 });
  const frame = await (await selected.elementHandle()).contentFrame();
  // Locators must survive reloads and tab changes just as Page locators did.
  // Evaluate and readiness checks run in the document selected for this call.
  const scope = page.frameLocator('#desktop-workspace.active .workspace-tab-panel.selected iframe');
  const view = {};
  for (const method of ['locator', 'getByRole', 'getByTitle', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId']) {
    view[method] = (...args) => scope[method](...args);
  }
  view.evaluate = (...args) => frame.evaluate(...args);
  view.waitForFunction = (...args) => frame.waitForFunction(...args);
  return view;
}

async function closeConversation(page, mobileSelector = '#back-btn') {
  const workspace = page.locator('#desktop-workspace.active');
  if (await workspace.count()) {
    const active = page.getByRole('tab', { selected: true });
    await page.locator('.workspace-tab-item').filter({ has: active }).locator('.workspace-tab-close').click();
  } else {
    await page.locator(mobileSelector).click();
  }
}

module.exports = { conversationView, closeConversation };
