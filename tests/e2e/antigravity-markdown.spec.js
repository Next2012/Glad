const { test, expect } = require('@playwright/test');

const chat = '#antigravity-chat-container';
const diagram = '```mermaid\nflowchart TD\n A[Stable source] --> B[Stable result]\n```';

async function openHarness(page, messages, state = {}) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(({ messages, state }) => {
    activeSessionId = 'antigravity-markdown-harness';
    activeToolKey = 'antigravity';
    activeSessionHydrated = true;
    antigravityMessages = messages;
    antigravityPendingPermissions = [];
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    antigravityState = { ...createDefaultAntigravityState(), status: 'idle', capabilities: { resume: true, list: true }, ...state };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    applyAntigravityState(antigravityState);
    handleComposerSocketOpen();
  }, { messages, state });
  await page.waitForFunction(() => antigravityRenderFrame === null);
}

async function saveEvidence(page, testInfo, name) {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: false, scale: 'css', animations: 'disabled' });
  await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
}

async function expectPreservedNodesAndSelection(page) {
  expect(await page.evaluate(() => {
    const saved = window.__stableMarkdownNodes;
    const card = document.querySelector('[data-agy-key="message-stable-answer"]');
    const selection = getSelection();
    return {
      card: card === saved.card,
      bubble: card.querySelector('.codex-message') === saved.bubble,
      paragraph: card.querySelector('p') === saved.paragraph,
      textNode: card.querySelector('p').firstChild === saved.textNode,
      svg: card.querySelector('.markdown-diagram-output svg') === saved.svg,
      source: card.querySelector('.markdown-diagram-source') === saved.source,
      sourceOpen: saved.source.open,
      tailCard: document.querySelector('[data-agy-key="message-stream-tail"]') === saved.tailCard,
      selectionText: selection.toString(),
      selectionNode: selection.anchorNode === saved.textNode,
      selectionOffset: selection.anchorOffset
    };
  })).toEqual({
    card: true, bubble: true, paragraph: true, textNode: true, svg: true, source: true,
    sourceOpen: true, tailCard: true, selectionText: 'Permanent selection', selectionNode: true, selectionOffset: 0
  });
}

test('Antigravity streaming preserves earlier DOM, SVG, Source disclosure and text selection while work groups change', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHarness(page, [
    { id: 'stable-answer', kind: 'assistant', turnId: 'old-turn', completedAtMs: 1700000000000,
      text: `## Stable answer\n\nPermanent selection must survive later streaming updates.\n\n${diagram}\n\nFormula: \\(E=mc^2\\).` },
    { id: 'stream-tail', kind: 'assistant', turnId: 'stream-turn', streaming: true, text: 'Streaming update 0' }
  ], { status: 'running', turnId: 'stream-turn', canAbort: true, canSteer: true });
  const stable = page.locator(`${chat} [data-agy-key="message-stable-answer"]`);
  await expect(stable.locator('.markdown-diagram-output svg')).toHaveCount(1);
  await expect(stable.locator('.katex')).toHaveCount(1);
  await stable.locator('.markdown-diagram-source > summary').click();
  await expect(stable.locator('.markdown-diagram-source code')).toBeVisible();
  await page.evaluate(() => {
    const card = document.querySelector('[data-agy-key="message-stable-answer"]');
    const paragraph = card.querySelector('p');
    const textNode = paragraph.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'Permanent selection'.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    window.__stableMarkdownNodes = {
      card, paragraph, textNode, bubble: card.querySelector('.codex-message'),
      svg: card.querySelector('.markdown-diagram-output svg'), source: card.querySelector('.markdown-diagram-source'),
      tailCard: document.querySelector('[data-agy-key="message-stream-tail"]')
    };
  });
  for (let update = 1; update <= 4; update++) {
    await page.evaluate(update => applyAntigravityEvent({ type: 'message-updated', message: {
      ...antigravityMessages.find(item => item.id === 'stream-tail'), text: `Streaming update ${update}`
    } }), update);
    await expect(page.locator(`${chat} [data-agy-key="message-stream-tail"] .codex-message`)).toHaveText(`Streaming update ${update}`);
    await expectPreservedNodesAndSelection(page);
  }

  await page.evaluate(() => {
    antigravityMessages.splice(1, 0,
      { id: 'inserted-reason', kind: 'reasoning', turnId: 'old-work-turn', text: 'Inspecting **a separate operation**.' },
      { id: 'inserted-tool', kind: 'tool', turnId: 'old-work-turn', title: 'Read another file', toolStatus: 'completed' }
    );
    applyAntigravityState({});
  });
  await expect(page.locator(`${chat} .antigravity-work-group`)).toHaveCount(1);
  await expectPreservedNodesAndSelection(page);
  await page.evaluate(() => {
    antigravityMessages = antigravityMessages.filter(item => !['inserted-reason', 'inserted-tool'].includes(item.id));
    applyAntigravityState({});
  });
  await expect(page.locator(`${chat} .antigravity-work-group`)).toHaveCount(0);
  await expectPreservedNodesAndSelection(page);
  await saveEvidence(page, testInfo, 'antigravity-stream-preserved-markdown');

  await stable.locator('.markdown-diagram-source > summary').click();
  await page.evaluate(() => applyAntigravityEvent({ type: 'message-updated', message: {
    ...antigravityMessages.find(item => item.id === 'stream-tail'), text: 'Streaming update complete', streaming: false, completedAtMs: 1700000001000
  } }));
  await expect(page.locator(`${chat} [data-agy-key="message-stream-tail"] .codex-message`)).toHaveText('Streaming update complete');
  await expect(stable.locator('.markdown-diagram-source')).not.toHaveAttribute('open', '');
  expect(await stable.locator('.markdown-diagram-output svg').evaluate(svg => svg === window.__stableMarkdownNodes.svg)).toBe(true);
  expect(errors).toEqual([]);
});

test('asynchronous Mermaid growth follows the Antigravity bottom and preserves a reader scrolled up', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 812 });
  // Resolve real renderDiagrams jobs on demand. This tests its asynchronous
  // scroll correction independently of Mermaid's rendering speed and fonts.
  await page.route('**/vendor/mermaid.min.js', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.__controlledDiagramJobs = [];
    window.mermaid = { initialize() {}, render(id, source) {
      return new Promise(resolve => window.__controlledDiagramJobs.push({ id, source, resolve }));
    } };
    window.__finishControlledDiagram = height => {
      const job = window.__controlledDiagramJobs.shift();
      job.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg" id="' + job.id + '" viewBox="0 0 400 ' + height + '" style="width:100%;height:' + height + 'px"><text x="10" y="20">Controlled asynchronous diagram</text></svg>' });
    };
  ` }));
  await openHarness(page, Array.from({ length: 35 }, (_, index) => ({
    id: `scroll-history-${index}`, kind: 'assistant', completedAtMs: 1700000000000 + index,
    text: `History ${index + 1}.\n\nEnough earlier content to keep a stable reading position.`
  })));
  await page.locator(chat).evaluate(host => { host.style.overflowAnchor = 'none'; host.scrollTop = host.scrollHeight; });
  await page.evaluate(() => applyAntigravityEvent({ type: 'message', message: {
    id: 'bottom-diagram', kind: 'assistant', text: '```mermaid\nflowchart TD\nBOTTOM[Bottom] --> GROW[Grow]\n```'
  } }));
  await expect.poll(() => page.evaluate(() => window.__controlledDiagramJobs?.length || 0)).toBe(1);
  await expect.poll(() => page.locator(chat).evaluate(host => host.scrollHeight - host.clientHeight - host.scrollTop)).toBeLessThanOrEqual(1);
  const beforeBottom = await page.locator(chat).evaluate(host => host.scrollHeight);
  await page.evaluate(() => window.__finishControlledDiagram(1200));
  await expect(page.locator(`${chat} [data-agy-key="message-bottom-diagram"] svg`)).toHaveCount(1);
  await expect.poll(() => page.locator(chat).evaluate(host => host.scrollHeight)).toBeGreaterThan(beforeBottom + 600);
  await expect.poll(() => page.locator(chat).evaluate(host => host.scrollHeight - host.clientHeight - host.scrollTop)).toBeLessThanOrEqual(1);

  const readingTop = await page.locator(chat).evaluate(host => { host.scrollTop = 180; return host.scrollTop; });
  expect(readingTop).toBeGreaterThan(0);
  await page.evaluate(() => {
    applyAntigravityEvent({ type: 'message', message: {
      id: 'reading-diagram', kind: 'assistant', text: '```mermaid\nflowchart TD\nREADING[Reading] --> GROW[Grow again]\n```'
    } });
    applyAntigravityEvent({ type: 'message', message: {
      id: 'reading-footer', kind: 'assistant', text: Array(18).fill('Following content keeps this reader above the conversation bottom.').join('\n\n')
    } });
  });
  await page.waitForFunction(() => antigravityRenderFrame === null);
  expect(await page.evaluate(() => window.__controlledDiagramJobs.length)).toBe(0);
  // Far-away diagrams remain source placeholders. Bring this one into the
  // visible scroller while later content keeps the reader above the bottom.
  await page.locator(`${chat} [data-agy-key="message-reading-diagram"]`).evaluate(element => element.scrollIntoView({ block: 'center' }));
  await expect.poll(() => page.evaluate(() => window.__controlledDiagramJobs?.length || 0)).toBe(1);
  const nearReadingTop = await page.locator(chat).evaluate(host => host.scrollTop);
  expect(await page.locator(chat).evaluate(host => host.scrollHeight - host.clientHeight - host.scrollTop)).toBeGreaterThan(64);
  expect(await page.locator(chat).evaluate(host => host.scrollTop)).toBeCloseTo(nearReadingTop, 0);
  const beforeReading = await page.locator(chat).evaluate(host => host.scrollHeight);
  await page.evaluate(() => window.__finishControlledDiagram(1400));
  await expect(page.locator(`${chat} [data-agy-key="message-reading-diagram"] svg`)).toHaveCount(1);
  await expect.poll(() => page.locator(chat).evaluate(host => host.scrollHeight)).toBeGreaterThan(beforeReading + 600);
  expect(await page.locator(chat).evaluate(host => host.scrollTop)).toBeCloseTo(nearReadingTop, 0);
});

test('Antigravity native history preview renders Mermaid and math through its preview request', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/sessions/antigravity-markdown-harness/antigravity-resume-sessions*', route => route.fulfill({ json: {
    success: true, items: [{ sessionId: 'native-rich-preview', title: 'Native rich history' }]
  } }));
  await page.route('**/api/sessions/antigravity-markdown-harness/antigravity-session-preview*', route => route.fulfill({ json: {
    success: true, messages: [{ id: 'native-preview-answer', kind: 'assistant', createdAt: 1700000000000,
      text: `## Preview answer\n\n${diagram}\n\nFormula: \\(x_i + y_j\\).` }]
  } }));
  await openHarness(page, [{ id: 'current-answer', kind: 'assistant', text: 'Keep the current conversation intact.' }]);
  await page.locator('#antigravity-resume-btn').click();
  const request = page.waitForRequest(request => request.url().includes('/antigravity-session-preview?sessionId=native-rich-preview'));
  await page.locator('[data-agy-preview="native-rich-preview"]').click();
  await request;
  const preview = page.locator('#antigravity-history-preview');
  await expect(preview.locator('.markdown-diagram-output svg')).toHaveCount(1);
  await expect(preview.locator('.katex')).toHaveCount(1);
  await expect(preview.locator('.markdown-diagram-error')).toHaveCount(0);
  await preview.locator('.markdown-diagram-source > summary').click();
  await expect(preview.locator('.markdown-diagram-source code')).toBeVisible();
  await expect(page.locator(`${chat} [data-agy-key="message-current-answer"]`)).toHaveCount(1);
  await expect(page.locator(`${chat} [data-agy-key="message-native-preview-answer"]`)).toHaveCount(0);
  await saveEvidence(page, testInfo, 'antigravity-native-rich-preview');
  expect(errors).toEqual([]);
});

test('Antigravity system events and errors remain plain text while reasoning stays collapsed', async ({ page }, testInfo) => {
  const literal = '**System text**\n[Literal link](https://example.com)\n```mermaid\nflowchart TD\n A --> B\n```\n\\(x_i\\)\n<img src=x onerror="window.agyMarkdownInjected=true">';
  await openHarness(page, [
    { id: 'plain-event', kind: 'event', text: literal, createdAt: 1700000000000 },
    { id: 'level-error', kind: 'event', level: 'error', text: literal, createdAt: 1700000000001 },
    { id: 'kind-error', kind: 'error', text: literal, createdAt: 1700000000002 },
    { id: 'folded-reason', kind: 'reasoning', turnId: 'reason-turn', text: '**Reasoned emphasis** stays inside folded work.' },
    { id: 'reason-end', kind: 'turn-end', turnId: 'reason-turn', turnStatus: 'completed' }
  ]);
  const event = page.locator(`${chat} .antigravity-conversation > .codex-message.event[data-agy-key="message-plain-event"]`);
  await expect(event).toBeVisible();
  for (const id of ['plain-event', 'level-error', 'kind-error']) {
    const block = page.locator(`${chat} .antigravity-conversation > .codex-message.event[data-agy-key="message-${id}"]`);
    await expect(block).toContainText('**System text**');
    await expect(block).toContainText('[Literal link](https://example.com)');
    await expect(block).toContainText('```mermaid');
    await expect(block).not.toHaveClass(/claude-md/);
    await expect(block.locator('a, strong, em, svg, .katex, .markdown-diagram, script, img')).toHaveCount(0);
  }
  for (const id of ['level-error', 'kind-error']) {
    const error = page.locator(`${chat} [data-agy-key="message-${id}"]`);
    await expect(error).toHaveClass(/\berror\b/);
    expect(await error.evaluate(element => getComputedStyle(element).color))
      .not.toBe(await event.evaluate(element => getComputedStyle(element).color));
  }
  const group = page.locator(`${chat} .antigravity-work-group`);
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute('open', '');
  const reasoning = group.locator('.antigravity-reasoning');
  await expect(reasoning).not.toHaveAttribute('open', '');
  await expect(reasoning.locator('strong')).toHaveText('Reasoned emphasis');
  await expect(reasoning.locator('strong')).not.toBeVisible();
  expect(await page.evaluate(() => window.agyMarkdownInjected)).toBeUndefined();
  await saveEvidence(page, testInfo, 'antigravity-plain-events-folded-reasoning');
});
