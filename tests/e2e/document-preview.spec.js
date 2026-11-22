const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dialogSelector = '#glad-document-preview';
const previewVendor = url => /\/vendor\/.*(?:pdf|viewer|highlight)/i.test(url);

function makePDF() {
  const stream = 'BT /F1 15 Tf 24 120 Td (Document preview PDF fixture) Tj ET\n';
  const secondStream = 'BT /F1 15 Tf 24 120 Td (Second preview page fixture) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(secondStream)} >>\nstream\n${secondStream}endstream`
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

const test = base.extend({
  documents: async ({ page }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-document-preview-'));
    const directory = path.join(root, 'workspace');
    const files = {
      text: { relative: 'docs/notes 中文.txt', data: Buffer.from('# Plain text stays literal\n<em>Not HTML</em>\nText preview fixture.\n') },
      code: { relative: 'docs/code sample.js', data: Buffer.from('// Document preview fixture\nconst message = "source line two";\nconsole.log(message);\n') },
      markdown: { relative: 'docs/guide.md', data: Buffer.from([
        '# Preview guide', '', '[Jump to local heading](#local-heading)', '',
        '[Nested child](./nested/child.md#child-section)', '', '![Guide image](<./images/pixel image.png>)', '',
        ...Array.from({ length: 25 }, (_, index) => `Guide paragraph ${index + 1}. This keeps the heading below the initial viewport.\n`),
        '## Local heading', '', 'LOCAL_GUIDE_TARGET'
      ].join('\n')) },
      image: { relative: 'docs/images/pixel image.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0aIAAAAASUVORK5CYII=', 'base64') },
      pdf: { relative: 'docs/report.pdf', data: makePDF() },
      child: { relative: 'docs/nested/child.md', data: Buffer.from([
        '# Nested child document', '', '[Return to guide](../guide.md#local-heading)', '',
        ...Array.from({ length: 25 }, (_, index) => `Child paragraph ${index + 1}. Follow the document fragment to its own heading.\n`),
        '## Child section', '', 'NESTED_CHILD_TARGET'
      ].join('\n')) },
      long: { relative: 'docs/A long document title with spaces and 中文 characters for narrow screen layout.txt', data: Buffer.from('Long filename preview fixture.\n') },
      slow: { relative: 'docs/slow.txt', data: Buffer.from('The real slow file.\n') },
      large: { relative: 'docs/large.txt', data: Buffer.concat([
        Buffer.from('LARGE_DOCUMENT_START\n'), Buffer.alloc(1024 * 1024 + 8192, 'a'), Buffer.from('\nLARGE_DOCUMENT_END\n')
      ]) }
    };
    let id;
    try {
      for (const file of Object.values(files)) {
        const filename = path.join(directory, file.relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, file.data);
        file.name = path.basename(filename);
      }
      fs.writeFileSync(path.join(root, 'outside.txt'), 'Outside the session workspace.');
      const created = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity', name: 'Document preview fixtures', workingDirectory: directory } });
      expect(created.ok()).toBe(true);
      ({ id } = await created.json());
      const url = (relative, hash = '') => `/api/sessions/${id}/workspace-resource?path=${encodeURIComponent(relative)}${hash}`;
      const markdown = [
        '[Text](<./docs/notes 中文.txt>)', '[Code](<./docs/code sample.js#L2-L3>)',
        '[Markdown](./docs/guide.md)', '[Image](<./docs/images/pixel image.png>)', '[PDF](./docs/report.pdf)',
        `[Long title](<./${files.long.relative}>)`, '[Missing](./docs/missing.txt)', '[Directory](./docs/nested)', '[Outside](../outside.txt)'
      ].join('\n\n');
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.evaluate(({ id, markdown }) => {
        activeSessionId = id;
        activeToolKey = 'antigravity';
        activeSessionHydrated = true;
        antigravityMessages = [{ id: 'document-links', kind: 'assistant', completedAtMs: 1700000000000, text: markdown }];
        antigravityPendingPermissions = [];
        antigravityState = { ...createDefaultAntigravityState(), status: 'idle' };
        document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
        document.getElementById('terminal-view').classList.add('active');
        setClaudeModeEnabled(false);
        currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
        applyAntigravityState(antigravityState);
        handleComposerSocketOpen();
      }, { id, markdown });
      await expect(page.locator('#antigravity-chat-container').getByRole('link', { name: 'Text', exact: true })).toBeVisible();
      await use({ id, directory, files, url });
    } finally {
      if (id) await page.request.delete(`/api/sessions/${id}`);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

async function openLink(page, name) {
  await page.locator('#antigravity-chat-container').getByRole('link', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document preview', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closePreview(page) {
  await page.getByRole('button', { name: 'Close document preview', exact: true }).click();
  await expect(page.locator(dialogSelector)).not.toBeVisible();
}

async function downloadBytes(page, file) {
  const href = await page.locator(`${dialogSelector} .document-preview-download`).getAttribute('href');
  expect(new URL(href, page.url()).searchParams.get('download')).toBe('1');
  const pending = page.waitForEvent('download');
  await page.locator(`${dialogSelector} .document-preview-download`).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(file.name);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(file.data);
}

async function attachScreenshot(page, testInfo, name) {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: false, scale: 'css', animations: 'disabled' });
  await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
}

async function expectPDFInk(canvas) {
  await expect.poll(() => canvas.evaluate(element => {
    const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180) return true;
    }
    return false;
  }), { timeout: 15000 }).toBe(true);
}

test('five real document types share one preview and download their original bytes and filenames', async ({ page, documents }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const initialResources = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => resource.name));
  expect(initialResources.filter(previewVendor)).toEqual([]);
  for (const [type, label] of [['text', 'Text'], ['markdown', 'Markdown'], ['code', 'Code'], ['image', 'Image'], ['pdf', 'PDF']]) {
    const dialog = await openLink(page, label);
    await expect(dialog.locator('.document-preview-title')).toContainText(documents.files[type].name);
    if (type === 'text') {
      await expect(dialog.locator('.document-preview-code')).toContainText('# Plain text stays literal');
      await expect(dialog.locator('.document-preview-code')).toContainText('<em>Not HTML</em>');
      await expect(dialog.locator('.document-preview-code em')).toHaveCount(0);
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => resource.name));
      expect(resources.filter(previewVendor)).toEqual([]);
    } else if (type === 'markdown') {
      await expect(dialog.locator('.document-preview-markdown h1')).toHaveText('Preview guide');
      await expect.poll(() => dialog.getByAltText('Guide image', { exact: true }).evaluate(image => image.naturalWidth)).toBe(1);
    } else if (type === 'code') {
      await expect(dialog.locator('.document-preview-code')).toContainText('source line two');
      await expect(dialog.locator('.document-preview-code [class*="hljs-"]')).not.toHaveCount(0);
      const selected = dialog.locator('.document-preview-line-highlight');
      await expect(selected).toHaveAttribute('data-start-line', '2');
      await expect(selected).toHaveAttribute('data-end-line', '3');
      await expect(selected).toBeVisible();
    } else if (type === 'image') {
      const image = dialog.locator('.document-preview-image');
      await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1);
      expect((await image.getAttribute('src')).startsWith('blob:')).toBe(false);
      await expect(dialog.locator('.viewer-container')).toBeVisible();
    } else {
      const canvas = dialog.locator('canvas.document-preview-canvas');
      await expect(canvas).toBeVisible();
      await expect(dialog.locator('.document-preview-page')).toHaveText('Page 1 of 2');
      await expectPDFInk(canvas);
      const firstPage = await canvas.evaluate(element => element.toDataURL());
      const fitWidth = await canvas.evaluate(element => parseFloat(element.style.width));
      const previous = dialog.getByRole('button', { name: 'Previous page', exact: true });
      const next = dialog.getByRole('button', { name: 'Next page', exact: true });
      await expect(previous).toBeDisabled();
      await next.click();
      await expect(dialog.locator('.document-preview-page')).toHaveText('Page 2 of 2');
      await expectPDFInk(canvas);
      expect(await canvas.evaluate(element => element.toDataURL())).not.toBe(firstPage);
      await expect(next).toBeDisabled();
      await previous.click();
      await expect(dialog.locator('.document-preview-page')).toHaveText('Page 1 of 2');
      await expectPDFInk(canvas);
      await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect.poll(() => canvas.evaluate(element => parseFloat(element.style.width))).toBeGreaterThan(fitWidth);
      await expectPDFInk(canvas);
      await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await expect.poll(() => canvas.evaluate(element => parseFloat(element.style.width))).toBeCloseTo(fitWidth, 0);
      await expectPDFInk(canvas);
      await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect.poll(() => canvas.evaluate(element => parseFloat(element.style.width))).toBeGreaterThan(fitWidth);
      await dialog.getByRole('button', { name: 'Fit page width', exact: true }).click();
      await expect.poll(() => canvas.evaluate(element => parseFloat(element.style.width))).toBeCloseTo(fitWidth, 0);
      await expectPDFInk(canvas);
    }
    await downloadBytes(page, documents.files[type]);
    if (type === 'pdf') await attachScreenshot(page, testInfo, 'document-preview-pdf');
    await closePreview(page);
  }
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => resource.name));
  expect(resources.some(url => /\/vendor\/.*pdf/i.test(url))).toBe(true);
  expect(resources.some(url => /\/vendor\/.*viewer/i.test(url))).toBe(true);
  expect(resources.some(url => /\/vendor\/.*highlight/i.test(url))).toBe(true);
  expect(errors).toEqual([]);
});

test('Markdown previews resolve nested document links, images and heading anchors from the document directory', async ({ page, documents }) => {
  const dialog = await openLink(page, 'Markdown');
  const markdown = dialog.locator('.document-preview-markdown');
  const image = markdown.getByAltText('Guide image', { exact: true });
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1);
  const imageURL = new URL(await image.getAttribute('src'), page.url());
  expect(imageURL.pathname).toBe(`/api/sessions/${documents.id}/workspace-resource`);
  expect(path.normalize(imageURL.searchParams.get('path'))).toBe(documents.files.image.relative);
  await markdown.getByRole('link', { name: 'Jump to local heading', exact: true }).click();
  await expect(markdown.locator('h2').filter({ hasText: 'Local heading' })).toBeInViewport();
  expect(await dialog.locator('.document-preview-body').evaluate(body => body.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.locator('.document-preview-title')).toContainText('guide.md');
  await markdown.getByRole('link', { name: 'Nested child', exact: true }).click();
  await expect(dialog.locator('.document-preview-title')).toContainText('child.md');
  await expect(markdown.locator('h1')).toHaveText('Nested child document');
  await expect(markdown.locator('h2').filter({ hasText: 'Child section' })).toBeInViewport();
  await markdown.getByRole('link', { name: 'Return to guide', exact: true }).click();
  await expect(dialog.locator('.document-preview-title')).toContainText('guide.md');
  await expect(markdown.locator('h2').filter({ hasText: 'Local heading' })).toBeInViewport();
});

test('missing files, directories and paths outside the workspace show an error inside the preview', async ({ page, documents }) => {
  for (const label of ['Missing', 'Directory', 'Outside']) {
    const dialog = await openLink(page, label);
    const error = dialog.getByRole('alert');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/not found|unavailable|cannot|can't|could not|unable|directory|access|找不到|无法|不存在|目录/i);
    expect((await error.innerText()).trim()).not.toBe('404 page not found');
    expect(await dialog.locator('.document-preview-code, .document-preview-markdown, .document-preview-canvas, .document-preview-image').evaluateAll(elements =>
      elements.every(element => { const box = element.getBoundingClientRect(); return box.width === 0 || box.height === 0; }))).toBe(true);
    await closePreview(page);
  }
  const outside = await page.request.get(documents.url('../outside.txt'));
  expect(outside.status()).toBe(404);
});

test('closing a delayed preview and opening another document prevents the old response from replacing it', async ({ page, documents }) => {
  let release;
  let arrived;
  let finished;
  const gate = new Promise(resolve => { release = resolve; });
  const requestArrived = new Promise(resolve => { arrived = resolve; });
  const routeFinished = new Promise(resolve => { finished = resolve; });
  await page.route(`**/api/sessions/${documents.id}/workspace-resource?*`, async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.searchParams.get('previewRace') !== 'slow') return route.continue();
    arrived();
    await gate;
    try {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'OBSOLETE_PREVIEW_RESPONSE' });
    } catch (_) {
      // Closing the dialog may already have aborted the controlled request.
    } finally {
      finished();
    }
  });
  try {
    await page.evaluate(url => { window.__delayedDocumentPreview = window.gladAssets.openDocument({ url }); }, `${documents.url(documents.files.slow.relative)}&previewRace=slow`);
    await requestArrived;
    await expect(page.locator(dialogSelector)).toBeVisible();
    await closePreview(page);
    await page.evaluate(url => window.gladAssets.openDocument({ url }), documents.url(documents.files.text.relative));
    const dialog = page.locator(dialogSelector);
    await expect(dialog.locator('.document-preview-title')).toContainText(documents.files.text.name);
    await expect(dialog.locator('.document-preview-code')).toContainText('Text preview fixture.');
    release();
    await routeFinished;
    await page.evaluate(() => window.__delayedDocumentPreview);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.document-preview-title')).toContainText(documents.files.text.name);
    await expect(dialog.locator('.document-preview-body')).not.toContainText('OBSOLETE_PREVIEW_RESPONSE');
    await expect(dialog.getByRole('alert')).not.toBeVisible();
  } finally {
    release();
  }
});

test('a queued close event cannot dismiss a document reopened in the same task', async ({ page, documents }) => {
  await page.evaluate(url => window.gladAssets.openDocument({ url }), documents.url(documents.files.text.relative));
  await page.evaluate(url => {
    window.gladDocumentPreview.close();
    window.__reopenedPreview = window.gladAssets.openDocument({ url });
  }, documents.url(documents.files.code.relative));
  await page.evaluate(() => window.__reopenedPreview);
  const dialog = page.getByRole('dialog', { name: 'Document preview', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.document-preview-title')).toHaveText(documents.files.code.name);
  await expect(dialog.locator('.document-preview-code')).toContainText('source line two');
  await closePreview(page);
});

test('large text uses a bounded preview request while its download retains the full original', async ({ page, documents }) => {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/workspace-resource') && url.searchParams.get('path') === documents.files.large.relative) {
      requests.push({ method: request.method(), range: request.headers().range, download: url.searchParams.get('download') });
    }
  });
  await page.evaluate(url => window.gladAssets.openDocument({ url }), documents.url(documents.files.large.relative));
  const preview = page.locator(`${dialogSelector} .document-preview-code`);
  await expect(preview).toContainText('LARGE_DOCUMENT_START');
  await expect(preview).not.toContainText('LARGE_DOCUMENT_END');
  expect((await preview.textContent()).length).toBeLessThanOrEqual(1024 * 1024 + 500);
  expect(requests.some(request => request.method === 'GET' && request.range === 'bytes=0-1048575' && request.download !== '1')).toBe(true);
  await downloadBytes(page, documents.files.large);
});

test('the preview keeps keyboard focus and its close and download controls inside narrow viewports', async ({ page, documents }, testInfo) => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 843, height: 388 }]) {
    await page.setViewportSize(viewport);
    const trigger = page.locator('#antigravity-chat-container').getByRole('link', { name: 'Long title', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Document preview', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.document-preview-code')).toContainText('Long filename preview fixture.');
    await expect(dialog.locator('.document-preview-title')).toContainText(documents.files.long.name);
    const geometry = await dialog.evaluate(element => {
      const inside = node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
      };
      return {
        dialog: inside(element), close: inside(element.querySelector('[aria-label="Close document preview"]')),
        download: inside(element.querySelector('.document-preview-download')),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
      };
    });
    expect(geometry).toEqual({ dialog: true, close: true, download: true, noPageOverflow: true });
    // Native modal dialogs may let Tab leave the web page for browser chrome.
    // Verify in-page order and background inertness without assuming a custom trap.
    const close = dialog.getByRole('button', { name: 'Close document preview', exact: true });
    const download = dialog.locator('.document-preview-download');
    await close.focus();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.document-preview-body')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(download).toBeFocused();
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    await trigger.evaluate(element => element.focus());
    await expect(download).toBeFocused();
    await attachScreenshot(page, testInfo, `document-preview-${viewport.width}`);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
});
