const { test, expect } = require('@playwright/test');

for (const mode of ['ordinary', 'workbench-prefix']) {
  for (const noLink of [false, true]) {
    test(`receipt download survives model output: ${mode}/${noLink ? 'no-link' : 'sandbox'}`, async ({ page, context }) => {
      const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
      expect(created.ok()).toBe(true);
      const { id } = await created.json();
      const uri = 'botlink-hub://resource/software/pdf-instance/'
        + Buffer.from('botlink://markdown-pdf/tasks/build-e2e/document.pdf').toString('base64url');
      try {
        await page.goto('/', { waitUntil: 'networkidle' });
        await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
        await expect(page.locator('#send-btn')).toBeEnabled();
        if (mode === 'workbench-prefix') {
          // 浏览器层沿用 WB 的资源前缀规则；真实身份/HTTP 原字节由 Go 合同验证。
          await page.evaluate(() => {
            window.gladWorkbenchResourceURL = u => typeof u === 'string' && u.startsWith('/')
              && !u.startsWith('//') && !u.startsWith('/owned-ui/') ? '/owned-ui/' + u.slice(1) : u;
          });
        }
        await page.locator('#cmd-input').fill('__GLAD_E2E_RESOURCE_RECEIPT__' + (noLink ? 'NO_LINK' : ''));
        await page.locator('#send-btn').click();
        const link = page.locator('#codex-chat-container').getByRole('link', { name: '打开 / 下载 document.pdf', exact: true });
        await expect(link).toBeVisible();
        const href = await link.getAttribute('href');
        const address = new URL(href, page.url());
        expect(address.protocol).toBe('http:');
        expect(address.pathname).toBe(`${mode === 'workbench-prefix' ? '/owned-ui' : ''}/api/sessions/${id}/mcp-resource`);
        expect(address.searchParams.get('uri')).toBe(uri);
        expect(address.href).not.toContain('/mnt/data');
        await expect(link).toHaveCount(1);
        const body = Buffer.from('%PDF-1.7\noriginal e2e bytes\n%%EOF\n');
        await context.route(address.href, route => route.fulfill({
          status: 200, contentType: 'application/pdf', body,
          headers: { 'Content-Disposition': 'inline; filename=document.pdf' }
        }));
        const response = context.waitForEvent('response', r => r.url() === address.href);
        const popup = page.waitForEvent('popup');
        await link.click();
        const downloaded = await response;
        expect(downloaded.status()).toBe(200);
        expect(downloaded.headers()['content-type']).toBe('application/pdf');
        expect(await downloaded.body()).toEqual(body);
        await (await popup).close();
      } finally {
        await page.request.delete(`/api/sessions/${id}`);
      }
    });
  }
}
