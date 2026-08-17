const { test, expect } = require('@playwright/test');

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
    { label: 'c++', code: 'int main() {}' },
    { label: 'objective-c', code: '@interface Example' }
  ]);
});

test('preserves ordered list numbers when nested bullets split the list into blocks', async ({ page }) => {
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
      text: list.textContent
    }));
  });

  expect(lists).toEqual([
    { start: 1, text: 'First item' },
    { start: 2, text: 'Second item' },
    { start: 3, text: 'Third item' }
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
