// Native subagents are an independent, read-only view of this session's graph.
// No child CLI is started and no child control/approval request is exposed.
(() => {
    const POLL_MS = 3000;
    const MAX_MESSAGES = 600;
    let current = null;
    const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
    const chat = document.getElementById('antigravity-chat-container');
    const view = document.getElementById('terminal-view');
    function visible() {
        return !document.hidden && (!window.gladPresentation || window.gladPresentation.visible()) && isAntigravitySession() && activeSessionId && activeSessionHydrated
            && view.classList.contains('active') && chat.style.display !== 'none';
    }
    function owned(state) { return current === state && visible() && state.parent === String(antigravityState.nativeConversationId || antigravityState.antigravitySessionId || '') && state.session === activeSessionId; }
    function ensureHost() {
        let host = document.getElementById('antigravity-subagents');
        if (!host && chat.firstElementChild) {
            host = document.createElement('section'); host.id = 'antigravity-subagents';
            host.className = 'codex-conversation antigravity-subagents'; host.hidden = true;
            host.setAttribute('aria-label', 'Native subagents'); chat.appendChild(host);
        }
        return host;
    }
    function reset() {
        if (current) { clearTimeout(current.timer); current.controller.abort(); }
        current = null;
        document.getElementById('antigravity-subagents')?.remove();
    }
    function activity(item) {
        const labels = { running: 'Recorded running', idle: 'Recorded idle', terminated: 'Native terminated' };
        return labels[item.activity] || (item.nativeStatus === 'SUBAGENT_STATE_ALIVE' ? 'Alive · activity unknown' : 'Activity unknown');
    }
    function timestamp(value) {
        const date = new Date(Number(value));
        return value > 0 && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not reported';
    }
    async function request(state, suffix = '', query = '', signal = state.controller.signal) {
        const response = await fetch(`/api/sessions/${encodeURIComponent(state.session)}/antigravity-subagents${suffix}${query}`, { signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || data.success === false) throw new Error(data.error || `Native history unavailable (HTTP ${response.status})`);
        if (!owned(state) || data.parentSessionId !== state.parent) return null;
        return data;
    }
    function note(card, message, error = false) {
        const target = card.element.querySelector('.antigravity-subagent-note');
        target.textContent = message; target.classList.toggle('error', error);
    }
    function displayHistory(state, card) {
        const container = card.element.querySelector('.antigravity-subagent-history');
        const top = container.scrollTop;
        const bottom = container.scrollHeight - top - container.clientHeight < 48;
        const template = document.createElement('template');
        template.innerHTML = card.messages.length ? buildAntigravityConversationHtml(card.messages, [], { status: 'idle', threadId: card.id }, { sessionId: state.session }) : '<div class="codex-message event">No complete native records are available in this preview window.</div>';
        if (container.firstElementChild) syncAntigravityDom(container.firstElementChild, template.content.firstElementChild);
        else container.appendChild(template.content.firstElementChild);
        gladMarkdownRich.renderDiagrams(container);
        container.scrollTop = bottom ? container.scrollHeight : top;
        card.element.querySelector('[data-agy-subagent-before]').hidden = !card.before;
        card.element.querySelector('[data-agy-subagent-before]').disabled = card.loading;
    }
    function windowNote(card, omitted = 0, older = false) {
        const summary = omitted > 0
            ? `Showing the ${older ? 'earlier' : 'newest'} ${MAX_MESSAGES} messages; ${omitted} ${older ? 'newer' : 'earlier'} messages were omitted from this window.`
            : `This read-only window contains ${MAX_MESSAGES} messages. Automatic tail updates are paused.`;
        return summary + (card.before ? ' Load earlier records moves this bounded window back; Refresh returns to the latest records.'
            : ' Refresh returns to the latest records. The complete transcript remains in the native client.');
    }
    async function loadHistory(state, card, older = false) {
        if (!owned(state) || !state.overview?.open || card.loading || !card.element.open || !card.hasTranscript || card.limited && !older) return;
        const before = older ? card.before : '';
        if (older && !before) return;
        card.loading = true;
        const revision = card.revision;
        const controller = new AbortController(); card.controller = controller;
        const abort = () => controller.abort(); state.controller.signal.addEventListener('abort', abort, { once: true });
        note(card, older ? 'Loading earlier native records…' : 'Reading native transcript…');
        try {
            const data = await request(state, `/${encodeURIComponent(card.id)}`, `?limit=40${before ? `&before=${encodeURIComponent(before)}` : ''}`, controller.signal);
            if (!data || controller.signal.aborted || card.controller !== controller || !card.element.isConnected) return;
            if (card.transcriptEpoch && data.transcriptEpoch && card.transcriptEpoch !== data.transcriptEpoch) {
                card.messages = []; card.before = ''; card.loaded = false; card.limited = false;
            }
            card.transcriptEpoch = data.transcriptEpoch || card.transcriptEpoch;
            const merged = new Map(card.messages.map(item => [item.id, item]));
            for (const item of data.messages || []) merged.set(item.id, item);
            const messages = [...merged.values()].sort((a, b) => Number(a.nativeOffset || 0) - Number(b.nativeOffset || 0) || Number(a.nativePart || 0) - Number(b.nativePart || 0));
            if (messages.length > MAX_MESSAGES && !older && card.loaded) {
                card.limited = true;
                note(card, [windowNote(card), ...new Set(data.warnings || [])].join(' '));
                return;
            }
            const omitted = Math.max(0, messages.length - MAX_MESSAGES);
            card.messages = older ? messages.slice(0, MAX_MESSAGES) : messages.slice(-MAX_MESSAGES);
            card.limited = messages.length >= MAX_MESSAGES;
            if (older || !card.loaded) card.before = data.nextBefore || '';
            card.loaded = true;
            if (!older) card.loadedRevision = revision;
            displayHistory(state, card);
            const warnings = [...new Set(data.warnings || [])];
            if (card.messages.some(item => item.previewTruncated)) warnings.push('Some native record text is truncated in this bounded preview.');
            note(card, [card.limited ? windowNote(card, omitted, older) : '', ...warnings].filter(Boolean).join(' ') || 'Read-only native records. Approval requests must be handled in the parent or native client.');
        } catch (error) {
            if (owned(state) && error.name !== 'AbortError') note(card, error.message, true);
        } finally {
            state.controller.signal.removeEventListener('abort', abort);
            card.loading = false;
            if (owned(state) && card.element.isConnected) {
                const button = card.element.querySelector('[data-agy-subagent-before]');
                button.disabled = false; button.hidden = !card.before;
            }
        }
    }
    function createCard(state, item) {
        const element = document.createElement('details');
        element.className = 'codex-work-group codex-subagent-group antigravity-subagent-group';
        element.dataset.agySubagentId = item.id;
        element.innerHTML = '<summary><span class="antigravity-subagent-heading"><strong></strong><small></small></span><span class="antigravity-subagent-state"></span></summary><div class="codex-work-group-body"><dl class="antigravity-subagent-metadata"><dt>Task summary</dt><dd data-agy-task></dd><dt>Native status</dt><dd data-agy-native-status></dd><dt>Last native record</dt><dd data-agy-activity></dd></dl><p class="antigravity-subagent-note" role="status">Read-only. Open to load native transcript.</p><div class="antigravity-subagent-history"></div><div class="antigravity-subagent-history-actions"><button type="button" class="small-btn" data-agy-subagent-before hidden>Load earlier records</button><button type="button" class="small-btn" data-agy-subagent-refresh>Refresh native records</button></div></div>';
        const card = { id: item.id, element, messages: [], before: '', loaded: false, loading: false, limited: false, revision: '' };
        element.addEventListener('toggle', () => { if (!element.open) card.controller?.abort(); else if (card.hasTranscript && !card.loaded) void loadHistory(state, card); });
        element.querySelector('[data-agy-subagent-before]').addEventListener('click', () => void loadHistory(state, card, true));
        element.querySelector('[data-agy-subagent-refresh]').addEventListener('click', () => {
            if (card.loading) return;
            card.messages = []; card.before = ''; card.loaded = false; card.limited = false;
            void loadHistory(state, card);
        });
        return card;
    }
    function renderDirectory(state) {
        if (!owned(state)) return;
        const scrollTop = chat.scrollTop;
        const atBottom = chat.scrollHeight - chat.clientHeight - scrollTop <= 64;
        const host = ensureHost(); if (!host) return;
        host.hidden = !state.items.length && !state.warnings.length;
        let overview = host.querySelector(':scope > .antigravity-subagent-overview');
        if (!overview) {
            overview = document.createElement('details');
            overview.className = 'codex-work-group antigravity-subagent-overview';
            const summary = document.createElement('summary'); summary.appendChild(document.createElement('span'));
            const list = document.createElement('div'); list.className = 'antigravity-subagents-list';
            overview.append(summary, list); host.appendChild(overview);
            overview.addEventListener('toggle', () => {
                if (!owned(state)) return;
                // Opening is a viewing action, not a request to jump to the
                // transcript's bottom. Keep existing child/Source nodes intact.
                for (const card of state.cards.values()) {
                    if (!overview.open) card.controller?.abort();
                    else if (card.element.open && (!card.loaded || card.loadedRevision !== card.revision)) void loadHistory(state, card);
                }
            });
        }
        state.overview = overview;
        const summary = overview.querySelector(':scope > summary');
        const label = `Native subagents (${state.items.length}) · read-only overview`;
        if (summary.firstElementChild.textContent !== label) summary.firstElementChild.textContent = label;
        summary.title = label;
        const list = overview.querySelector(':scope > .antigravity-subagents-list');
        let directoryNote = list.querySelector(':scope > .antigravity-subagents-directory-note');
        if (!directoryNote) { directoryNote = document.createElement('p'); directoryNote.className = 'antigravity-subagents-directory-note antigravity-subagent-note'; directoryNote.setAttribute('role', 'status'); list.prepend(directoryNote); }
        const directoryText = state.warnings.length ? [...new Set(state.warnings)].join(' ') : 'Native subagents · local read-only history';
        if (directoryNote.textContent !== directoryText) directoryNote.textContent = directoryText;
        const known = new Set(state.items.map(item => item.id));
        for (const [id, card] of state.cards) if (!known.has(id)) { card.controller?.abort(); card.element.remove(); state.cards.delete(id); }
        for (const item of state.items) {
            let card = state.cards.get(item.id);
            if (!card) { card = createCard(state, item); state.cards.set(item.id, card); list.appendChild(card.element); }
            card.hasTranscript = item.hasTranscript;
            card.element.dataset.nativeStatus = item.nativeStatus || '';
            card.element.dataset.activity = item.activity || 'unknown';
            const heading = card.element.querySelector('.antigravity-subagent-heading');
            const name = `${item.name || 'Subagent'}${item.depth > 1 ? ` · depth ${item.depth}` : ''}`;
            if (heading.querySelector('strong').textContent !== name) heading.querySelector('strong').textContent = name;
            if (heading.querySelector('small').textContent !== (item.role || '')) heading.querySelector('small').textContent = item.role || '';
            card.element.querySelector('.antigravity-subagent-state').textContent = activity(item);
            card.element.querySelector('[data-agy-task]').textContent = item.taskSummary || 'Not reported by the native index. See the transcript for recorded instructions.';
            card.element.querySelector('[data-agy-native-status]').textContent = item.nativeStatus || 'Not reported';
            card.element.querySelector('[data-agy-activity]').textContent = timestamp(item.lastActivityAt);
            const signature = item.revision || `${item.lastActivityAt || 0}:${item.nativeStatus || ''}`;
            card.revision = signature;
            if (card.element.open && item.hasTranscript && signature !== card.loadedRevision) void loadHistory(state, card);
            if (!item.hasTranscript) note(card, 'This native child is known, but its transcript is not available on this machine.');
        }
        chat.scrollTop = atBottom ? chat.scrollHeight : scrollTop;
    }
    async function poll(state) {
        if (!owned(state) || state.busy) return;
        state.busy = true;
        try {
            const data = await request(state);
            if (!data) return;
            state.items = Array.isArray(data.items) ? data.items : [];
            state.revision = data.revision || '';
            state.warnings = data.warnings || [];
            renderDirectory(state);
        } catch (error) {
            if (owned(state) && error.name !== 'AbortError') {
                for (const card of state.cards.values()) if (card.element.open) note(card, 'Native subagent index is temporarily unavailable. Refresh to retry.', true);
            }
        } finally {
            state.busy = false;
            if (owned(state)) state.timer = setTimeout(() => void poll(state), POLL_MS);
        }
    }
    function sync() {
        const parent = String(antigravityState.nativeConversationId || antigravityState.antigravitySessionId || '');
        if (!visible()) {
            if (document.hidden || !isAntigravitySession() || !view.classList.contains('active') || chat.style.display === 'none') reset();
            else if (current) { clearTimeout(current.timer); current.timer = null; }
            return;
        }
        if (!uuid.test(parent)) { if (current) reset(); return; }
        if (current?.session !== activeSessionId || current?.parent !== parent) {
            reset();
            const state = { session: activeSessionId, parent, controller: new AbortController(), timer: null, busy: false, items: [], warnings: [], cards: new Map(), revision: '' };
            current = state; ensureHost(); void poll(state);
        } else if (!document.getElementById('antigravity-subagents')) renderDirectory(current);
    }
    function refresh() {
        sync();
        if (current && !current.busy) { clearTimeout(current.timer); void poll(current); }
    }
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('glad:view-visible', refresh);
    document.addEventListener('glad:view-hidden', () => { if (current) { clearTimeout(current.timer); current.timer = null; } });
    window.addEventListener('pagehide', reset);
    new MutationObserver(sync).observe(chat, { attributes: true, attributeFilter: ['style'] });
    new MutationObserver(sync).observe(view, { attributes: true, attributeFilter: ['class'] });
    window.gladAntigravitySubagents = Object.freeze({ sync, reset, refresh });
})();
