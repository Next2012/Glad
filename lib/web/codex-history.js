// Shared, metadata-first history picker. Preview requests never resume a thread.
function cancelCodexThreadPicker(panel) {
    const state = panel?._codexPicker;
    if (!state) return;
    state.listRequest?.abort();
    state.previewRequest?.abort();
    panel._codexPicker = null;
}

function codexPickerIsCurrent(panel, state) {
    return panel._codexPicker === state && activeSessionId === state.sessionId
        && panel.classList.contains('active');
}

async function codexPickerJSON(url, controller, timeout) {
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load history');
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function loadCodexThreadPanel(panel, action) {
    for (const id of ['codex-resume-panel', 'codex-fork-panel']) {
        cancelCodexThreadPicker(document.getElementById(id));
    }
    delete panel.dataset.resumeError;
    const state = { sessionId: activeSessionId, action, items: [], cursor: '', seenCursors: new Set(), loading: false };
    panel._codexPicker = state;
    const label = action === 'fork' ? 'Fork' : 'Resume';
    panel.innerHTML = `<div class="codex-history-header">
        <div class="codex-history-heading"><strong>${label} conversation</strong><span class="claude-resume-meta">${action === 'fork' ? 'Create a copy; keep the original history.' : 'Continue an existing conversation.'}</span></div>
        <div class="codex-history-filters">
            <select aria-label="History sort"><option value="updated_at">Recently updated</option><option value="created_at">Recently created</option></select>
        </div></div><div class="codex-history-results" aria-live="polite"></div>`;
    const refresh = () => {
        state.listRequest?.abort();
        state.listRequest = null;
        state.previewRequest?.abort();
        state.preview = null;
        state.items = [];
        state.cursor = '';
        state.error = '';
        state.seenCursors.clear();
        state.loading = true;
        renderCodexThreadResults(panel, state);
        void fetchCodexThreadPage(panel, state);
    };
    panel.querySelector('select').addEventListener('change', refresh);
    panel.scrollTop = 0;
    await fetchCodexThreadPage(panel, state);
}

async function fetchCodexThreadPage(panel, state, append = false) {
    if (!codexPickerIsCurrent(panel, state)) return;
    const controller = new AbortController();
    state.listRequest?.abort();
    state.listRequest = controller;
    state.loading = true;
    state.error = '';
    const cursor = append ? state.cursor : '';
    const query = new URLSearchParams({
        sort: panel.querySelector('[aria-label="History sort"]').value
    });
    if (cursor) query.set('cursor', cursor);
    renderCodexThreadResults(panel, state);
    try {
        const data = await codexPickerJSON(`/api/sessions/${encodeURIComponent(state.sessionId)}/codex-resume-threads?${query}`, controller, 30000);
        if (!codexPickerIsCurrent(panel, state) || state.listRequest !== controller) return;
        const items = append ? state.items : [];
        const ids = new Set(items.map(item => item.id));
        for (const item of data.items || []) {
            if (!ids.has(item.id)) { items.push(item); ids.add(item.id); }
        }
        state.items = items;
        if (cursor) state.seenCursors.add(cursor);
        state.cursor = data.nextCursor || '';
        if (state.cursor && state.seenCursors.has(state.cursor)) {
            state.cursor = '';
            state.error = 'History returned a repeated page. Reopen the picker to refresh.';
        }
    } catch (error) {
        if (!codexPickerIsCurrent(panel, state) || state.listRequest !== controller) return;
        state.error = error.name === 'AbortError' ? 'History request timed out. Please retry.' : error.message;
    } finally {
        if (codexPickerIsCurrent(panel, state) && state.listRequest === controller) {
            state.loading = false;
            renderCodexThreadResults(panel, state);
        }
    }
}

function codexHistoryTime(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Unknown';
}

function renderCodexThreadResults(panel, state) {
    if (!codexPickerIsCurrent(panel, state)) return;
    const results = panel.querySelector('.codex-history-results');
    if (!results) return;
    const scrollTop = panel.scrollTop;
    const action = state.action === 'fork' ? 'Fork' : 'Resume';
    const sortCreated = panel.querySelector('[aria-label="History sort"]').value === 'created_at';
    results.innerHTML = state.items.map((item, index) => {
        const title = item.title || item.questions?.[0] || 'Codex session';
        const expanded = state.preview?.id === item.id;
        return `<article class="codex-history-item">
            <div class="codex-history-row"><button type="button" class="claude-resume-item" data-preview="${index}" aria-expanded="${expanded}" aria-label="Preview ${escapeHtml(title)}">
                <div class="codex-history-title">${escapeHtml(title)}${item.current ? ' · current' : ''}</div>
                <div class="claude-resume-meta">${sortCreated ? 'Created' : 'Updated'} ${escapeHtml(codexHistoryTime(sortCreated ? item.createdAt : item.updatedAt))}</div>
                <span class="codex-history-preview-label">${expanded ? 'Hide preview' : 'Preview'}</span>
            </button><button type="button" class="small-btn primary" data-action="${index}" aria-label="${action} ${escapeHtml(title)}"${codexReadyForInput() ? '' : ' disabled'}>${action}</button></div>
            ${expanded ? renderCodexThreadPreview(item, state.preview) : ''}</article>`;
    }).join('');
    if (state.error) results.insertAdjacentHTML('beforeend', `<div class="codex-history-notice" role="alert">${escapeHtml(state.error)} <button type="button" class="small-btn" data-retry>Retry</button></div>`);
    if (!state.items.length && !state.loading && !state.error) results.insertAdjacentHTML('beforeend', '<div class="codex-history-notice">No matching sessions.</div>');
    results.insertAdjacentHTML('beforeend', `<div class="codex-history-footer"><span>${state.items.length} sessions loaded</span>${state.loading ? '<span role="status">Loading sessions…</span>' : state.cursor ? '<button type="button" class="small-btn" data-more>Load more</button>' : ''}</div>`);
    results.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => previewCodexThread(panel, state, state.items[Number(button.dataset.preview)])));
    results.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
        if (!codexReadyForInput()) return;
        const id = state.items[Number(button.dataset.action)].id;
        cancelCodexThreadPicker(panel);
        if (state.action === 'fork') selectCodexForkThread(id);
        else selectCodexResumeThread(id);
    }));
    results.querySelector('[data-more]')?.addEventListener('click', () => fetchCodexThreadPage(panel, state, true));
    results.querySelector('[data-retry]')?.addEventListener('click', () => fetchCodexThreadPage(panel, state, Boolean(state.cursor)));
    results.querySelector('[data-preview-retry]')?.addEventListener('click', () => {
        const item = state.items.find(item => item.id === state.preview?.id);
        state.preview = null;
        if (item) previewCodexThread(panel, state, item);
    });
    panel.scrollTop = scrollTop;
    updateTerminalControlsHeight();
}

function renderCodexThreadPreview(item, preview) {
    const messages = (preview.messages || []).map(message => `<div class="codex-history-message"><strong>${message.kind === 'user' ? 'You' : 'Codex'}</strong><div>${escapeHtml(message.text)}</div></div>`).join('');
    return `<div class="codex-history-detail">
        <div class="claude-resume-meta">ID: ${escapeHtml(item.id)}<br>Created: ${escapeHtml(codexHistoryTime(item.createdAt))}<br>Updated: ${escapeHtml(codexHistoryTime(item.updatedAt))}<br>Directory: ${escapeHtml(item.cwd || 'Unknown')}${item.branch ? `<br>Branch: ${escapeHtml(item.branch)}` : ''}</div>
        <strong>Recent conversation</strong><div class="claude-resume-meta">Preview of the last 3 turns; long messages are shortened. No session switch.</div>
        ${preview.loading ? '<div role="status">Loading preview…</div>' : preview.error ? `<div role="alert">${escapeHtml(preview.error)} <button type="button" class="small-btn" data-preview-retry>Retry preview</button></div>` : `<div class="codex-history-transcript">${messages || '<div>No recent text messages.</div>'}</div>`}
        </div>`;
}

async function previewCodexThread(panel, state, item) {
    state.previewRequest?.abort();
    if (state.preview?.id === item.id) {
        state.preview = null;
        renderCodexThreadResults(panel, state);
        return;
    }
    const preview = { id: item.id, loading: true };
    state.preview = preview;
    const controller = new AbortController();
    state.previewRequest = controller;
    renderCodexThreadResults(panel, state);
    try {
        const query = new URLSearchParams({ threadId: item.id });
        const data = await codexPickerJSON(`/api/sessions/${encodeURIComponent(state.sessionId)}/codex-thread-preview?${query}`, controller, 20000);
        preview.messages = data.messages || [];
    } catch (error) {
        preview.error = error.name === 'AbortError' ? 'Preview timed out. You can retry or continue without a preview.' : error.message;
    } finally {
        preview.loading = false;
        if (codexPickerIsCurrent(panel, state) && state.preview === preview) renderCodexThreadResults(panel, state);
    }
}
