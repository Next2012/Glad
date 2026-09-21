function cancelClaudeHistoryPicker(panel) {
    const state = panel?._claudeHistory;
    state?.listRequest?.abort();
    state?.previewRequest?.abort();
    if (panel) panel._claudeHistory = null;
}

async function claudeHistoryJSON(url, controller, timeout) {
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function renderClaudeHistoryPicker(panel, action) {
    cancelClaudeHistoryPicker(panel);
    const state = { sessionId: activeSessionId, action, items: [], nextOffset: 0, loading: false, error: '', preview: null };
    panel._claudeHistory = state;
    const label = action === 'fork' ? 'Fork' : 'Resume';
    panel.innerHTML = `<div class="codex-history-header"><div class="codex-history-heading"><strong>${label} conversation</strong><span class="claude-resume-meta">${action === 'fork' ? 'Create a copy and keep the original.' : 'Continue an existing Claude conversation.'}</span></div><div class="codex-history-filters"><select aria-label="Claude history sort"><option value="updated_at">Recently updated</option><option value="created_at">Recently created</option></select></div></div><div class="codex-history-results" aria-live="polite"></div>`;
    panel.querySelector('select').addEventListener('change', () => fetchClaudeHistoryPage(panel, state, false));
    await fetchClaudeHistoryPage(panel, state, false);
}

function claudeHistoryCurrent(panel, state) {
    return panel?._claudeHistory === state && activeSessionId === state.sessionId;
}

async function fetchClaudeHistoryPage(panel, state, append) {
    if (!claudeHistoryCurrent(panel, state)) return;
    state.listRequest?.abort();
    const controller = new AbortController();
    state.listRequest = controller;
    state.loading = true;
    state.error = '';
    if (!append) {
        state.items = [];
        state.nextOffset = 0;
        state.preview = null;
    }
    renderClaudeHistoryResults(panel, state);
    try {
        const query = new URLSearchParams({
            sort: panel.querySelector('[aria-label="Claude history sort"]').value,
            offset: String(append ? state.nextOffset : 0), limit: '20'
        });
        const data = await claudeHistoryJSON(`/api/sessions/${encodeURIComponent(state.sessionId)}/claude-resume-sessions?${query}`, controller, 30000);
        if (!claudeHistoryCurrent(panel, state) || state.listRequest !== controller) return;
        const seen = new Set(state.items.map(item => item.id));
        for (const item of data.items || []) if (!seen.has(item.id)) state.items.push(item);
        state.nextOffset = data.hasMore ? Number(data.nextOffset || state.items.length) : -1;
    } catch (error) {
        if (!claudeHistoryCurrent(panel, state) || state.listRequest !== controller) return;
        state.error = error.name === 'AbortError' ? 'History request timed out. Please retry.' : error.message;
    } finally {
        if (claudeHistoryCurrent(panel, state) && state.listRequest === controller) {
            state.loading = false;
            renderClaudeHistoryResults(panel, state);
        }
    }
}

function renderClaudeHistoryResults(panel, state) {
    const results = panel.querySelector('.codex-history-results');
    if (!results || !claudeHistoryCurrent(panel, state)) return;
    const sortCreated = panel.querySelector('[aria-label="Claude history sort"]').value === 'created_at';
    const action = state.action === 'fork' ? 'Fork' : 'Resume';
    results.innerHTML = state.items.map((item, index) => {
        const title = item.questions?.[0] || 'Claude session';
        const expanded = state.preview?.id === item.id;
        const timestamp = sortCreated ? item.createdAt : item.updatedAt;
        return `<article class="codex-history-item"><div class="codex-history-row"><button type="button" class="claude-resume-item" data-claude-preview="${index}" aria-expanded="${expanded}"><div class="codex-history-title">${escapeHtml(title)}${item.id === claudeState.claudeSessionId ? ' · current' : ''}</div><div class="codex-resume-question-secondary">${escapeHtml(item.questions?.[1] || '')}</div><div class="claude-resume-meta">${sortCreated ? 'Created' : 'Updated'} ${escapeHtml(codexHistoryTime(timestamp))}</div><span class="codex-history-preview-label">${expanded ? 'Hide preview' : 'Preview'}</span></button><button type="button" class="small-btn primary" data-claude-history-action="${index}"${claudeStatus === 'thinking' ? ' disabled' : ''}>${action}</button></div>${expanded ? renderClaudeHistoryPreview(item, state.preview) : ''}</article>`;
    }).join('');
    if (state.error) results.insertAdjacentHTML('beforeend', `<div class="codex-history-notice" role="alert">${escapeHtml(state.error)} <button type="button" class="small-btn" data-claude-history-retry>Retry</button></div>`);
    if (!state.items.length && !state.loading && !state.error) results.insertAdjacentHTML('beforeend', '<div class="codex-history-notice">No local Claude sessions found for this folder.</div>');
    results.insertAdjacentHTML('beforeend', `<div class="codex-history-footer"><span>${state.items.length} sessions loaded</span>${state.loading ? '<span role="status">Loading sessions…</span>' : state.nextOffset >= 0 ? '<button type="button" class="small-btn" data-claude-history-more>Load more</button>' : ''}</div>`);
    results.querySelectorAll('[data-claude-preview]').forEach(button => button.addEventListener('click', () => previewClaudeHistory(panel, state, state.items[Number(button.dataset.claudePreview)])));
    results.querySelectorAll('[data-claude-history-action]').forEach(button => button.addEventListener('click', () => {
        const item = state.items[Number(button.dataset.claudeHistoryAction)];
        cancelClaudeHistoryPicker(panel);
        if (state.action === 'fork') selectClaudeForkSession(item.id);
        else selectClaudeResumeSession(item.id);
    }));
    results.querySelector('[data-claude-history-more]')?.addEventListener('click', () => fetchClaudeHistoryPage(panel, state, true));
    results.querySelector('[data-claude-history-retry]')?.addEventListener('click', () => fetchClaudeHistoryPage(panel, state, state.nextOffset > 0));
    updateTerminalControlsHeight();
}

function renderClaudeHistoryPreview(item, preview) {
    const messages = (preview.messages || []).map(message => `<div class="codex-history-message"><strong>${message.kind === 'user' ? 'You' : 'Claude'}</strong><div>${escapeHtml(message.text)}</div></div>`).join('');
    return `<div class="codex-history-detail"><div class="claude-resume-meta">ID: ${escapeHtml(item.id)}<br>Directory: ${escapeHtml(item.cwd || 'Unknown')}</div><strong>Recent conversation</strong>${preview.loading ? '<div>Loading preview…</div>' : preview.error ? `<div role="alert">${escapeHtml(preview.error)}</div>` : `<div class="codex-history-transcript">${messages || '<div>No recent text messages.</div>'}</div>`}</div>`;
}

async function previewClaudeHistory(panel, state, item) {
    state.previewRequest?.abort();
    if (state.preview?.id === item.id) {
        state.preview = null;
        renderClaudeHistoryResults(panel, state);
        return;
    }
    const preview = { id: item.id, loading: true, messages: [] };
    state.preview = preview;
    renderClaudeHistoryResults(panel, state);
    const controller = new AbortController();
    state.previewRequest = controller;
    try {
        const query = new URLSearchParams({ sessionId: item.id });
        const data = await claudeHistoryJSON(`/api/sessions/${encodeURIComponent(state.sessionId)}/claude-session-preview?${query}`, controller, 20000);
        preview.messages = data.messages || [];
    } catch (error) {
        preview.error = error.name === 'AbortError' ? 'Preview timed out.' : error.message;
    } finally {
        preview.loading = false;
        if (claudeHistoryCurrent(panel, state) && state.preview === preview) renderClaudeHistoryResults(panel, state);
    }
}
