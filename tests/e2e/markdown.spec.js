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
