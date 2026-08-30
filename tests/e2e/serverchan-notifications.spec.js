const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

test('configures ServerChan separately from the per-session notification toggle', async ({ page }) => {
  let configured = false;
  let enabled = false;
  let savedClientType = 'wechat';
  let saveCount = 0;
  let testCount = 0;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = payload => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload)
    });

    if (url.pathname === '/api/sessions' && request.method() === 'GET') {
      return json([{
        id: 'session-serverchan-test',
        name: '通知交互验证',
        tool: 'Claude Code',
        toolKey: 'claude-code',
        startTime: Date.now(),
        workingDirectory: '/root/data/Test/glad',
        serverChanNotificationEnabled: enabled,
        timedInputCount: 0
      }]);
    }

    if (url.pathname === '/api/notifications/serverchan' && request.method() === 'GET') {
      return json({
        configured,
        maskedKey: configured ? 'SCT••••••••1234' : '',
        clientType: savedClientType
      });
    }

    if (url.pathname === '/api/notifications/serverchan' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      saveCount += 1;
      configured = true;
      savedClientType = body.clientType;
      return json({
        success: true,
        settings: {
          configured: true,
          maskedKey: 'SCT••••••••1234',
          clientType: savedClientType
        }
      });
    }

    if (url.pathname === '/api/notifications/serverchan/test' && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.clientType).toBe('pushdeer');
      expect(body.sessionId).toBeUndefined();
      testCount += 1;
      return json({ success: true });
    }

    if (url.pathname === '/api/sessions/session-serverchan-test/notifications/serverchan' && request.method() === 'PUT') {
      enabled = request.postDataJSON().enabled;
      return json({
        success: true,
        state: { enabled, configured: true }
      });
    }

    return route.fallback();
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  const card = page.locator('.session-card');
  await expect(card).toContainText('通知交互验证');
  const toggle = card.getByRole('button', { name: 'Enable ServerChan notifications for this chat' });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toHaveClass(/active/);
  await expect(card.locator('.serverchan-toggle')).toHaveCount(1);
  await expect(card.locator('.serverchan-settings-trigger')).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings-modal-overlay')).toBeVisible();
  await expect(page.getByText('Notifications', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ServerChan' })).toBeVisible();
  await page.locator('#serverchan-client-type').selectOption('pushdeer');
  await page.locator('#serverchan-send-key').fill('SCT_E2E_TEST_1234');

  await page.locator('#serverchan-save-btn').click();
  await expect(page.locator('#serverchan-settings-status')).toContainText('Configuration saved');
  expect(saveCount).toBe(1);
  expect(testCount).toBe(0);

  await page.getByRole('button', { name: 'Send Test' }).click();
  await expect(page.locator('#serverchan-settings-status')).toContainText('Test message sent');
  expect(saveCount).toBe(1);
  expect(testCount).toBe(1);

  await page.getByRole('button', { name: 'Close' }).click();
  await toggle.click();
  await expect(card.getByRole('button', { name: 'Disable ServerChan notifications for this chat' })).toHaveClass(/active/);
  await expect(page.locator('#app-toast')).not.toHaveClass(/visible/);
  expect(enabled).toBe(true);
});

test('saves and sends one live ServerChan test message when explicitly enabled', async ({ page }) => {
  const keyFile = process.env.GLAD_SERVERCHAN_LIVE_KEY_FILE;
  test.skip(!keyFile, 'Live ServerChan test requires an explicit external key file');
  const sendKey = fs.readFileSync(keyFile, 'utf8').trim();
  expect(sendKey.length).toBeGreaterThan(8);

  const created = await page.request.post('/api/sessions', {
    data: {
      toolKey: 'claude-code',
      workingDirectory: '/root/data/Test/glad'
    }
  });
  expect(created.ok()).toBe(true);
  const { id: sessionId } = await created.json();
  const renamed = await page.request.patch(`/api/sessions/${sessionId}`, {
    data: { name: 'Server酱体验' }
  });
  expect(renamed.ok()).toBe(true);

  await page.goto('/', { waitUntil: 'networkidle' });
  const card = page.locator('.session-card').filter({ hasText: 'Server酱体验' });
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#serverchan-client-type').selectOption('wechat');
  await page.locator('#serverchan-send-key').fill(sendKey);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#serverchan-settings-status')).toContainText('Configuration saved');
  await page.getByRole('button', { name: 'Send Test' }).click();
  await expect(page.locator('#serverchan-settings-status')).toContainText('Test message sent', {
    timeout: 20_000
  });

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByRole('button', { name: 'Enable ServerChan notifications for this chat' })).not.toHaveClass(/active/);
});
