// A bounded initial history window is a view concern. Providers retain their
// own event reducers, interaction state and native conversation lifecycles.
(() => {
    let current = null;
    const adapters = new Map();
    function register(kind, adapter) { adapters.set(kind, adapter); }
    function close() {
        if (!current) return;
        current.controller.abort();
        current.adapter.container()?.removeEventListener('scroll', current.onScroll);
        current = null;
    }
    function activate(sessionId, kind) {
        close();
        const adapter = adapters.get(kind);
        if (!adapter) return;
        const state = { sessionId, kind, adapter, controller: new AbortController(), page: null,
            loading: false, error: '', expanded: new Map(), bodyRequests: new Set(), userScrollUntil: 0 };
        state.onScroll = () => {
            if (Date.now() < state.userScrollUntil && state.adapter.container()?.scrollTop < 60) void loadBefore(state);
        };
        adapter.container()?.addEventListener('scroll', state.onScroll, { passive: true });
        current = state;
    }
    function active(state) { return current === state && !state.controller.signal.aborted && activeSessionId === state.sessionId; }
    function revision(message) { return Number(message?.revision || 0); }
    function mergeMessages(older, latest) {
        const values = new Map();
        for (const item of older || []) if (item?.id) values.set(item.id, item);
        for (const item of latest || []) {
            if (!item?.id) continue;
            const old = values.get(item.id);
            if (!old || revision(item) >= revision(old)) values.set(item.id, { ...old, ...item });
        }
        return [...values.values()].sort((a, b) => {
            const ai = Number.isFinite(a.historyIndex) ? a.historyIndex : Infinity;
            const bi = Number.isFinite(b.historyIndex) ? b.historyIndex : Infinity;
            return ai === bi ? 0 : ai - bi;
        });
    }
    function retainExpanded(state, messages) {
        return messages.map(message => {
            const saved = state.expanded.get(message.id);
            return saved && saved.version === message.textVersion
                ? { ...message, text: saved.text, textDeferred: false, fullTextLoaded: true } : message;
        });
    }
    function acceptSnapshot(sessionId, snapshot) {
        const state = current;
        if (!state || state.sessionId !== sessionId) return snapshot;
        const changed = state.page?.epoch !== snapshot.historyPage?.epoch;
        if (changed) {
            state.controller.abort();
            state.controller = new AbortController();
            state.expanded.clear(); state.bodyRequests.clear(); state.loading = false;
        }
        state.page = snapshot.historyPage || null;
        state.error = '';
        return { ...snapshot, messages: retainExpanded(state, mergeMessages(snapshot.messages, snapshot.pendingQuestions)) };
    }
    function prepareEvent(sessionId, event) {
        const state = current;
        if (!event || !state || state.sessionId !== sessionId) return event;
        if (event.type === 'history-reset') {
            const snapshot = acceptSnapshot(sessionId, event);
            if (Array.isArray(event.pendingPermissions)) state.adapter.setPermissions(event.pendingPermissions);
            if (typeof event.name === 'string') applySessionName(sessionId, event.name);
            if (event.hasUnreadCompletion) noteSessionCompletion(sessionId, event.completionRevision);
            return { ...event, messages: snapshot.messages };
        }
        if (event.message) {
            const existing = state.adapter.messages().find(item => item.id === event.message.id);
            if (existing && revision(event.message) && revision(event.message) < revision(existing)) return null;
            const message = retainExpanded(state, [event.message])[0];
            if (!Number.isFinite(message.historyIndex) && Number.isFinite(existing?.historyIndex)) message.historyIndex = existing.historyIndex;
            if (existing?.textVersion && message.textVersion !== existing.textVersion) {
                state.expanded.delete(message.id);
                message.fullTextLoaded = false;
            }
            return { ...event, type: existing && event.type === 'message' ? 'message-updated' : event.type, message };
        }
        return event;
    }
    function header(kind, messages) {
        const state = current;
        if (!state || state.kind !== kind || state.adapter.messages() !== messages || !state.page?.paged) return '';
        const key = kind === 'claude-code' ? 'data-claude-key' : kind === 'codex' ? 'data-codex-key' : 'data-agy-key';
        return `<div class="conversation-page-controls" ${key}="conversation-pages">${state.page.hasBefore
            ? `<button type="button" class="conversation-load-older" data-conversation-session="${escapeHtml(state.sessionId)}"${state.loading ? ' disabled' : ''}>${state.loading ? 'Loading earlier messages…' : 'Load earlier messages'}</button>`
            : '<span>Beginning of loaded conversation</span>'}${state.error ? `<span class="conversation-page-error" role="status">${escapeHtml(state.error)}</span>` : ''}</div>`;
    }
    function body(message, html, interactive = true) {
        if (!message.textDeferred) return html;
        if (!interactive) return `${html}<p class="conversation-body-note">Message preview · open the session to read more</p>`;
        const state = current;
        if (!state) return html;
        const loading = state.bodyRequests.has(message.id);
        return `${html}<div class="conversation-body-note"><button type="button" class="conversation-expand-message" data-conversation-session="${escapeHtml(state.sessionId)}" data-conversation-message="${escapeHtml(message.id)}"${loading ? ' disabled' : ''}>${loading ? 'Loading message…' : 'Read full message'}</button></div>`;
    }
    function captureAnchor(container) {
        const top = container.getBoundingClientRect().top;
        for (const element of container.querySelectorAll('[data-codex-key], [data-claude-key], [data-agy-key]')) {
            const key = ['data-codex-key', 'data-claude-key', 'data-agy-key'].find(name => element.hasAttribute(name));
            if (element.getAttribute(key) === 'conversation-pages') continue;
            if (element.getBoundingClientRect().bottom >= top) return { key, id: element.getAttribute(key), top: element.getBoundingClientRect().top };
        }
        return null;
    }
    async function loadBefore(state = current) {
        if (!state || !active(state) || state.loading || !state.page?.hasBefore || !state.page.beforeCursor) return;
        const epoch = state.page.epoch;
        const container = state.adapter.container();
        const anchor = container && captureAnchor(container);
        const oldTop = container?.scrollTop || 0, oldHeight = container?.scrollHeight || 0;
        state.loading = true; state.error = ''; state.adapter.render();
        try {
            const url = `/api/sessions/${encodeURIComponent(state.sessionId)}/conversation?before=${encodeURIComponent(state.page.beforeCursor)}`;
            const response = await fetch(url, { signal: state.controller.signal });
            const data = await response.json().catch(() => ({ error: 'Unable to load earlier messages.' }));
            if (!active(state) || state.page?.epoch !== epoch) return;
            if (!response.ok) throw new Error(response.status === 409 ? 'Conversation changed. Reconnect to refresh its history.' : data.error || 'Unable to load earlier messages.');
            if (data.historyPage?.epoch !== epoch) return;
            const latest = state.adapter.messages();
            state.adapter.setMessages(retainExpanded(state, mergeMessages(data.messages, latest)));
            const permissions = new Map((data.resolvedPermissions || []).map(item => [item.id, item]));
            for (const item of state.adapter.permissions()) permissions.set(item.id, item);
            state.adapter.setPermissions([...permissions.values()]);
            state.page = { ...state.page, ...data.historyPage };
            state.adapter.render();
            requestAnimationFrame(() => {
                if (!active(state) || !container) return;
                const target = anchor && [...container.querySelectorAll(`[${anchor.key}]`)].find(item => item.getAttribute(anchor.key) === anchor.id);
                container.scrollTop = target ? container.scrollTop + target.getBoundingClientRect().top - anchor.top
                    : oldTop + container.scrollHeight - oldHeight;
            });
        } catch (error) {
            if (active(state) && error.name !== 'AbortError') state.error = error.message;
        } finally {
            if (active(state) && state.page?.epoch === epoch) { state.loading = false; state.adapter.render(); }
        }
    }
    async function expandMessage(state, id) {
        if (!active(state) || state.bodyRequests.has(id)) return;
        const original = state.adapter.messages().find(item => item.id === id);
        if (!original?.textDeferred || !original.textVersion) return;
        const version = original.textVersion;
        const controller = state.controller;
        const valid = () => active(state) && state.controller === controller;
        state.bodyRequests.add(id); state.adapter.render();
        try {
            let offset = 0, text = '';
            do {
                const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/conversation-messages/${encodeURIComponent(id)}/text?version=${encodeURIComponent(version)}&offset=${offset}`, { signal: state.controller.signal });
                const data = await response.json().catch(() => ({ error: 'Unable to read this message.' }));
                if (!valid()) return;
                const latest = state.adapter.messages().find(item => item.id === id);
                if (!latest || latest.textVersion !== version) return;
                if (!response.ok) throw new Error(response.status === 409 ? 'Message changed. Open it again to read the latest version.' : data.error || 'Unable to read this message.');
                if (data.version !== version) throw new Error('Message changed. Open it again to read the latest version.');
                text += data.text || '';
                if (!data.hasMore) break;
                if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset) throw new Error('Unable to continue reading this message.');
                offset = data.nextOffset;
            } while (valid());
            if (!valid()) return;
            const collapsed = new Map();
            state.expanded.set(id, { version, text, preview: original.text || '' });
            let bytes = [...state.expanded.values()].reduce((total, item) => total + item.text.length * 2, 0);
            while (state.expanded.size > 1 && (state.expanded.size > 4 || bytes > 4 * 1024 * 1024)) {
                const oldest = state.expanded.keys().next().value;
                const saved = state.expanded.get(oldest);
                collapsed.set(oldest, saved); bytes -= saved.text.length * 2; state.expanded.delete(oldest);
            }
            state.adapter.setMessages(state.adapter.messages().map(item => {
                const saved = collapsed.get(item.id);
                if (saved && saved.version === item.textVersion) return { ...item, text: saved.preview, textDeferred: true, fullTextLoaded: false };
                return item.id === id && item.textVersion === version ? { ...item, text, textDeferred: false, fullTextLoaded: true } : item;
            }));
        } catch (error) {
            if (valid() && error.name !== 'AbortError') showAppToast(error.message);
        } finally {
            if (valid()) { state.bodyRequests.delete(id); state.adapter.render(); }
        }
    }
    document.addEventListener('click', event => {
        const button = event.target.closest?.('.conversation-load-older, .conversation-expand-message');
        const state = current;
        if (!button || !state || button.dataset.conversationSession !== state.sessionId) return;
        if (button.classList.contains('conversation-load-older')) void loadBefore(state);
        else void expandMessage(state, button.dataset.conversationMessage);
    });
    for (const name of ['wheel', 'touchmove', 'keydown']) document.addEventListener(name, event => {
        if (name === 'keydown' && !['PageUp', 'Home', 'ArrowUp'].includes(event.key)) return;
        if (current && current.adapter.container()?.contains(event.target)) current.userScrollUntil = Date.now() + 1500;
    }, { passive: true });
    window.gladConversationPages = Object.freeze({ register, activate, close, acceptSnapshot, prepareEvent, header, body, mergeMessages });
})();
