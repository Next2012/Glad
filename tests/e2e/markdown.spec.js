const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function showRichMessage(page, markdown, provider = 'codex') {
  await page.evaluate(({ markdown, provider }) => {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    activeToolKey = provider === 'codex' ? 'codex' : 'claude-code';
    setClaudeModeEnabled(provider === 'claude');
    if (provider === 'codex') {
      codexMessages = [{ id: 'rich-message', kind: 'assistant', text: markdown }];
      commitCodexChatRender();
    } else {
      claudeMessages = [{ id: 'rich-message', kind: 'assistant', text: markdown }];
      commitClaudeChatRender();
    }
  }, { markdown, provider });
}

const diagram = '```mermaid\nflowchart TD\n A[原始数据] --> B[提取特征]\n B -->|通过| C[输出结果]\n```';
const formula = String.raw`\[
R=\frac{\max(D_{pre})-\min(D_{pre})}{\max(|D_{candidate}-D_{baseline}|,\epsilon)}
\]`;

test('renders Mermaid and LaTeX in both providers using only bundled assets', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failures.push(response.url()); });
  await page.goto('/', { waitUntil: 'networkidle' });
  for (const provider of ['codex', 'claude']) {
    await showRichMessage(page, `${diagram}\n\n${formula}\n\n行内公式 \\(q=wp/(1-p+wp)\\) 和 $E=mc^2$。`, provider);
    const container = page.locator(`#${provider}-chat-container`);
    await expect(container.locator('.markdown-diagram-output svg')).toHaveCount(1);
    await expect(container.locator('.markdown-diagram-output')).toContainText('原始数据');
    await expect(container.locator('.katex')).toHaveCount(3);
    await expect(container.locator('.katex-display')).toHaveCount(1);
    await expect(container.locator('.markdown-math-fallback')).toHaveCount(0);
    await container.locator('.markdown-diagram-source summary').click();
    await expect(container.locator('.markdown-diagram-source code')).toContainText('flowchart TD');
    const geometry = await container.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  }
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name))
    .map(url => ({ origin: url.origin, path: url.pathname })));
  const origin = new URL(page.url()).origin;
  expect(resources.every(resource => resource.origin === origin)).toBe(true);
  expect(resources.some(resource => resource.path.endsWith('/mermaid.min.js'))).toBe(true);
  expect(resources.some(resource => resource.path.includes('/katex/fonts/'))).toBe(true);
  expect(failures).toEqual([]);
});

test('preserves formula syntax in code and prices, and protects math from Markdown formatting', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    String.raw`行内 \(a_i + b_j < c_k\)，美元 $5 and $10，转义 \$x\$。`,
    '', '代码：`$x_i$` 和 `\\(y_j\\)`。',
    '', '[Price](https://example.com/$5$) and https://example.com/$6$',
    '', '```js', String.raw`const example = "\(x_i\) and $$y$$";`, '```',
    '', '```latex', String.raw`\sum_{i=1}^{n} i`, '```',
    '', '$$', String.raw`\begin{aligned}a_i &= b_j \\ c_k &= d_l\end{aligned}`, '$$'
  ].join('\n'));
  const container = page.locator('#codex-chat-container');
  await expect(container.locator('.katex')).toHaveCount(3);
  await expect(container).toContainText('$5 and $10');
  await expect(container.locator('pre code')).toContainText('$$y$$');
  await expect(container.locator('p > code').first()).toHaveText('$x_i$');
  await expect(container.locator('.markdown-math-fallback')).toHaveCount(0);
  await expect(container.locator('em')).toHaveCount(0);
  await expect(container.getByRole('link', { name: 'Price' })).toHaveAttribute('href', 'https://example.com/$5$');
});

test('keeps completed diagrams stable during streaming and redraws on theme changes', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => setGladTheme('dark'));
  await showRichMessage(page, diagram.slice(0, -3));
  await expect(page.locator('#codex-chat-container svg')).toHaveCount(0);
  await showRichMessage(page, diagram);
  const svg = page.locator('#codex-chat-container .markdown-diagram-output svg');
  await expect(svg).toHaveCount(1);
  const firstID = await svg.getAttribute('id');
  await showRichMessage(page, `${diagram}\n\nNew streaming text`);
  await expect(svg).toHaveAttribute('id', firstID);
  await page.evaluate(() => setGladTheme('light'));
  await expect(page.locator('#codex-chat-container .markdown-diagram')).toHaveAttribute('data-diagram-theme', 'light');
  expect(await svg.getAttribute('id')).not.toBe(firstID);
  await showRichMessage(page, `${diagram}\n\n${diagram}`);
  await expect(page.locator('#codex-chat-container .markdown-diagram-output svg')).toHaveCount(2);
  const ids = await page.locator('#codex-chat-container .markdown-diagram-output svg').evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(2);
});

test('malformed diagrams and formulas retain readable source without executing content', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    '```mermaid', 'not a valid diagram <img src=x onerror="window.richInjected=true">', '```',
    '', String.raw`\(\unknownCommand{x}\)`,
    '', String.raw`\(\includegraphics{https://example.invalid/track.png}\)`,
    '', '```mermaid', 'flowchart TD', ' A[Safe] --> B[Result]', ' click A "javascript:window.richInjected=true"', '```'
  ].join('\n'));
  await expect(page.locator('.markdown-diagram-error')).toHaveCount(1);
  await expect(page.locator('.markdown-diagram-error + pre')).toContainText('not a valid diagram');
  await expect(page.locator('.markdown-math-fallback')).toContainText('unknownCommand');
  await expect(page.locator('.markdown-diagram-output svg')).toHaveCount(1);
  expect(await page.locator('.markdown-diagram-output a').evaluateAll(links => links.every(link =>
    !link.getAttribute('href') && !link.getAttribute('xlink:href') && !link.getAttribute('onclick')))).toBe(true);
  await expect(page.locator('#codex-chat-container img')).toHaveCount(0);
  expect(await page.evaluate(() => window.richInjected)).toBeUndefined();
  await expect(page.locator('.markdown-diagram-scratch')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('tiled conversation previews render diagrams and formulas', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tiled layout');
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('#send-btn')).toBeEnabled();
    await page.locator('#cmd-input').fill(`${diagram}\n\n${formula}`);
    await page.locator('#send-btn').click();
    await expect(page.locator('#cmd-input')).toHaveValue('');
    await page.locator('#lobby-collapse-button').click();
    const tile = page.locator(`.tile-session-window[data-session-id="${id}"]`);
    await expect(tile.locator('.markdown-diagram-output svg').first()).toBeVisible();
    await expect(tile.locator('.katex').first()).toBeVisible();
    await page.evaluate(id => renderTileConversation(id), id);
    await expect(tile.locator('.markdown-diagram-output svg').first()).toBeVisible();
    await tile.locator('.markdown-diagram-source summary').first().click({ timeout: 5000 });
    await expect(tile.locator('.markdown-diagram-source code').first()).toBeVisible();
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('renders nested fenced code blocks without stalling', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  const rendered = await page.evaluate(() => {
    const markdown = [
      'A four-backtick fence can contain a three-backtick example:',
      '',
      '````markdown',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '````',
      '',
      'The outer fence is now closed.'
    ].join('\n');
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(markdown);
    return {
      codeBlocks: container.querySelectorAll('pre code').length,
      code: container.querySelector('pre code')?.textContent || '',
      text: container.textContent || ''
    };
  });

  expect(rendered.codeBlocks).toBe(1);
  expect(rendered.code).toContain('```ts\nconst a = 1;');
  expect(rendered.code).toContain('const b = 2;\n```');
  expect(rendered.text).toContain('The outer fence is now closed.');
  expect(pageErrors).toEqual([]);
});

test('renders tilde fences and non-word info strings', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const codeBlocks = await page.evaluate(() => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown([
      '~~~c++',
      'int main() {}',
      '~~~',
      '',
      '```objective-c',
      '@interface Example',
      '```'
    ].join('\n'));
    return Array.from(container.querySelectorAll('pre')).map(pre => ({
      label: pre.querySelector('.claude-tool-section-title')?.textContent || '',
      code: pre.querySelector('code')?.textContent || ''
    }));
  });

  expect(codeBlocks).toEqual([
    { label: 'c++', code: 'int main() {}\n' },
    { label: 'objective-c', code: '@interface Example\n' }
  ]);
});

test('preserves ordered list numbering and nested bullet structure', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const lists = await page.evaluate(() => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown([
      '1. **First item**',
      '   - First detail',
      '',
      '2. **Second item**',
      '   - Second detail',
      '',
      '3. **Third item**',
      '   - Third detail'
    ].join('\n'));
    return Array.from(container.querySelectorAll('ol')).map(list => ({
      start: list.start,
      items: Array.from(list.children).map(item => ({
        title: item.querySelector('strong')?.textContent,
        detail: item.querySelector('ul li')?.textContent
      }))
    }));
  });

  expect(lists).toEqual([
    { start: 1, items: [
      { title: 'First item', detail: 'First detail' },
      { title: 'Second item', detail: 'Second detail' },
      { title: 'Third item', detail: 'Third detail' }
    ] }
  ]);
});

test('preserves intraword underscores while retaining intentional emphasis', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const rendered = await page.evaluate(() => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown([
      'foo_bar_baz snake_case_name foo__bar__baz 前缀_中间_后缀',
      '',
      '_italic_ and __bold__ and (_punctuation_)',
      '',
      '`code_with_underscores` and `[literal_emphasis_](https://example.com/a_b_c)`',
      '',
      '[read _this_](https://example.com/docs_with_underscores)'
    ].join('\n'));
    return {
      text: container.textContent,
      emphasis: Array.from(container.querySelectorAll('em')).map(element => element.textContent),
      strong: Array.from(container.querySelectorAll('strong')).map(element => element.textContent),
      code: Array.from(container.querySelectorAll('code')).map(element => ({
        text: element.textContent,
        emphasis: element.querySelectorAll('em, strong').length
      })),
      links: Array.from(container.querySelectorAll('a')).map(element => ({
        text: element.textContent,
        href: element.getAttribute('href')
      }))
    };
  });

  expect(rendered.text).toContain('foo_bar_baz snake_case_name foo__bar__baz 前缀_中间_后缀');
  expect(rendered.emphasis).toEqual(['italic', 'punctuation', 'this']);
  expect(rendered.strong).toEqual(['bold']);
  expect(rendered.code).toEqual([
    { text: 'code_with_underscores', emphasis: 0 },
    { text: '[literal_emphasis_](https://example.com/a_b_c)', emphasis: 0 }
  ]);
  expect(rendered.links).toEqual([
    { text: 'read this', href: 'https://example.com/docs_with_underscores' }
  ]);
});

test('renders task lists, nested blocks, strikethrough and all heading levels', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    '##### 五级标题', '', '###### 六级标题', '', 'Setext title', '============', '',
    '- [ ] Pending **task**', '  - [x] Completed child', '    - Third level', '',
    '1) First item', '', '   Second paragraph of the first item', '', '   > Quoted detail', '',
    '2) Second item', '', '~~Removed~~ and **bold with *italic* inside**', '',
    '\\*literal stars\\* and &copy; &#169;', '', '    const indented = 42;', '',
    '``contains a ` backtick``'
  ].join('\n'));
  const content = page.locator('#codex-chat-container');
  await expect(content.locator('h5')).toHaveText('五级标题');
  await expect(content.locator('h6')).toHaveText('六级标题');
  await expect(content.locator('h1')).toHaveText('Setext title');
  await expect(content.getByRole('checkbox', { name: 'Pending task' })).not.toBeChecked();
  await expect(content.getByRole('checkbox', { name: 'Completed child' })).toBeChecked();
  await expect(content.getByRole('checkbox', { name: 'Completed child' })).toBeDisabled();
  await expect(content.locator('ul ul ul > li')).toHaveText('Third level');
  await expect(content.locator('ol > li').first().locator('p').first()).toHaveText('First item');
  await expect(content.locator('ol > li').first().locator('blockquote')).toContainText('Quoted detail');
  await expect(content.locator('ol > li')).toHaveCount(2);
  await expect(content.locator('s')).toHaveText('Removed');
  await expect(content.locator('strong em')).toHaveText('italic');
  await expect(content).toContainText('*literal stars* and © ©');
  await expect(content.locator('pre code')).toHaveText('const indented = 42;\n');
  await expect(content.locator('p > code')).toHaveText('contains a ` backtick');
});

test('renders table alignment and escaped pipes without splitting cells', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, '| Left | Center | Right |\n| :--- | :---: | ---: |\n| A\\|B | `x\\|y` | \\(x_i\\) |');
  const content = page.locator('#codex-chat-container');
  await expect(content.locator('tbody td')).toHaveCount(3);
  await expect(content.locator('tbody td').nth(0)).toHaveText('A|B');
  await expect(content.locator('tbody td').nth(1).locator('code')).toHaveText('x|y');
  await expect(content.locator('tbody td').nth(2).locator('.katex')).toHaveCount(1);
  for (const [index, alignment] of ['left', 'center', 'right'].entries()) {
    await expect(content.locator('th').nth(index)).toHaveCSS('text-align', alignment);
    await expect(content.locator('td').nth(index)).toHaveCSS('text-align', alignment);
  }
});

test('preserves bracket math inside paragraphs, nested lists and blockquotes', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    '公式：\\[x^2\\]。', '', '\\(a_i +', 'b_j\\)', '',
    '- Formula: \\(x_i\\)', '  - Child: $y_j$', '',
    '> \\[', '> \\frac{a}{b}', '> \\]', '',
    '> ```mermaid', '> flowchart LR', '> A[Start] --> B[Done]', '> ```'
  ].join('\n'));
  const content = page.locator('#codex-chat-container');
  await expect(content.locator('.katex')).toHaveCount(5);
  await expect(content.locator('.katex-display')).toHaveCount(2);
  await expect(content.locator('ul ul .katex')).toHaveCount(1);
  await expect(content.locator('.markdown-math-fallback')).toHaveCount(0);
  await expect(content.locator('blockquote .markdown-diagram-output svg')).toHaveCount(1);
});

test('renders reference links, titles, balanced URLs, autolinks and scoped heading anchors', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    '[Reference][guide]', '[Title](https://example.com "A title")',
    '[Balanced](https://example.com/a_(b))', 'https://example.org and test@example.com',
    '[Jump](#details)', '', '[guide]: https://example.com/guide "Guide title"', '',
    Array.from({ length: 60 }, (_, index) => `Paragraph ${index}`).join('\n\n'), '',
    '## Details', '', 'Destination content', '', Array(30).fill('Following content').join('\n\n')
  ].join('\n'));
  const content = page.locator('#codex-chat-container');
  await expect(content.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.com/guide');
  await expect(content.getByRole('link', { name: 'Title', exact: true })).toHaveAttribute('title', 'A title');
  await expect(content.getByRole('link', { name: 'Balanced', exact: true })).toHaveAttribute('href', 'https://example.com/a_(b)');
  await expect(content.getByRole('link', { name: 'https://example.org', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(content.getByRole('link', { name: 'test@example.com', exact: true })).toHaveAttribute('href', 'mailto:test@example.com');
  await content.evaluate(element => { element.scrollTop = 0; });
  await content.getByRole('link', { name: 'Jump', exact: true }).click();
  await expect(content.locator('h2')).toBeInViewport();
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(500);
});

test('resolves local files and images in the correct conversation workspace', async ({ page }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-markdown-files-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0aIAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(directory, '中文 notes.md'), '# Markdown workspace file');
  fs.writeFileSync(path.join(directory, 'pixel image.png'), png);
  let id;
  try {
    const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex', workingDirectory: directory } });
    expect(created.ok()).toBe(true);
    ({ id } = await created.json());
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(id => { activeSessionId = id; }, id);
    await showRichMessage(page, '[Local file](<./中文 notes.md>)\n\n![Local image](./pixel%20image.png "Pixel")');
    const content = page.locator('#codex-chat-container');
    const href = await content.getByRole('link', { name: 'Local file' }).getAttribute('href');
    expect(href).toContain(`/api/sessions/${id}/workspace-resource?path=`);
    expect(await (await page.request.get(href)).text()).toBe('# Markdown workspace file');
    await expect.poll(() => content.getByAltText('Local image').evaluate(image => image.naturalWidth)).toBe(1);
    const popupPromise = page.waitForEvent('popup');
    await content.getByRole('link', { name: 'Local file' }).click();
    const popup = await popupPromise;
    await expect(popup.locator('body')).toContainText('# Markdown workspace file');
    await popup.close();
    const tiledHTML = await page.evaluate(() => tileConversationHtml({ id: 'different-session', toolKey: 'codex' }, {
      hydrated: true, permissions: [], state: { status: 'idle' },
      messages: [{ id: 'local-link', kind: 'assistant', text: '[Workspace](./README.md)' }]
    }));
    expect(tiledHTML).toContain('/api/sessions/different-session/workspace-resource?path=');
    expect(tiledHTML).not.toContain(`/api/sessions/${id}/workspace-resource`);
  } finally {
    if (id) await page.request.delete(`/api/sessions/${id}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps raw HTML inert and rejects executable links with the new parser', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await showRichMessage(page, [
    '<img src=x onerror="window.markdownInjected=true">', '',
    '[Unsafe](javascript:window.markdownInjected=true)', '',
    '[Encoded](javascript&#58;alert%281%29)', '',
    '<details><summary>Raw HTML</summary>Literal content</details>', '',
    '- [x] <script>window.markdownInjected=true</script>'
  ].join('\n'));
  const content = page.locator('#codex-chat-container');
  await expect(content.locator('script, img, details, a')).toHaveCount(0);
  await expect(content.getByRole('checkbox')).toBeChecked();
  expect(await page.evaluate(() => window.markdownInjected)).toBeUndefined();
});
