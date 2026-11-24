// Each mounted conversation keeps its own existing renderer, draft, uploads and
// transport. Switching tabs never re-enters joinSession/openRoom or replays history.
(() => {
    const embedded = document.documentElement.classList.contains('glad-embed');
    const query = new URLSearchParams(location.search);
    const hosted = embedded && query.get('workspaceTab') === '1';
    const ownKind = query.has('embedRoom') ? 'room' : 'session';
    const ownId = query.get(ownKind === 'room' ? 'embedRoom' : 'embedSession');
    let host = null;
    if (hosted && parent !== window) {
        try { if (parent.location.origin === location.origin) host = parent.gladTabs; } catch (_) {}
    }
    const media = matchMedia(window.gladLayout.splitQuery);
    const workspace = document.getElementById('desktop-workspace');
    const list = document.getElementById('workspace-tab-list');
    const panels = document.getElementById('workspace-tab-panels');
    const tabs = new Map();
    let selected = null;
    let sequence = 0;
    let retirementTimer = null;
    let collapsed = false;
    try { collapsed = localStorage.getItem('glad-sidebar-collapsed') === 'true'; } catch (_) {}
    const keyOf = (kind, id) => `${kind}:${id}`;
    const enabled = () => !embedded && media.matches;
    const openTabs = () => Array.from(list.children, item => tabs.get(item.dataset.tabKey));

    function syncSidebar() {
        document.body.classList.toggle('sidebar-collapsed', enabled() && collapsed);
        const button = document.getElementById('lobby-collapse-button');
        const title = collapsed ? 'Expand session list' : 'Collapse session list';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('aria-expanded', String(!collapsed));
        button.querySelector('use').setAttribute('href', collapsed ? '#icon-chevron-right' : '#icon-chevron-left');
    }

    function visible(kind, id) {
        if (host) return host.visible(kind, id);
        if (embedded) return kind === ownKind && id === ownId && !document.hidden;
        return enabled() && !document.hidden && selected === keyOf(kind, id)
            && workspace.classList.contains('active') && !tabs.get(selected)?.closed;
    }

    function syncSelection() {
        for (const tab of tabs.values()) {
            const active = !tab.closed && tab.key === selected;
            tab.button.setAttribute('aria-selected', String(active));
            tab.button.tabIndex = active ? 0 : -1;
            tab.panel.classList.toggle('selected', active);
            tab.panel.setAttribute('aria-hidden', String(!active));
            tab.panel.inert = !active;
        }
        document.querySelectorAll('.session-card[data-session-id], .session-card[data-room-id]').forEach(card => {
            const key = card.dataset.roomId ? keyOf('room', card.dataset.roomId) : keyOf('session', card.dataset.sessionId);
            card.classList.toggle('selected', key === selected && workspace.classList.contains('active'));
        });
    }

    function child(tab) { return tab?.frame.contentWindow?.gladTabView; }

    function activate(key, focus = false) {
        const tab = tabs.get(key);
        if (!tab || tab.closed) return;
        if (selected === key && workspace.classList.contains('active')) {
            tab.item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            if (focus) tab.button.focus({ preventScroll: true });
            return;
        }
        if (selected !== key) child(tabs.get(selected))?.capture();
        selected = key;
        document.querySelectorAll('#detail-pane > .view').forEach(view => view.classList.remove('active'));
        document.body.classList.remove('room-open', 'room-session-open');
        workspace.classList.add('active');
        syncSelection();
        tab.item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        child(tab)?.activate();
        if (focus) tab.button.focus({ preventScroll: true });
    }

    function update(kind, id, state) {
        if (host) { host.update(kind, id, state); return; }
        const tab = tabs.get(keyOf(kind, id));
        if (!tab) return;
        if (state.name) {
            tab.label.textContent = state.name;
            tab.button.title = state.name;
            tab.frame.title = state.name;
            tab.closeButton.setAttribute('aria-label', `Close ${state.name} tab`);
        }
        if (state.status !== undefined) {
            tab.indicator.dataset.status = state.status;
            tab.indicator.title = tileStatusLabel(state.status);
            tab.indicator.setAttribute('aria-label', tileStatusLabel(state.status));
        }
        if (state.unread !== undefined) tab.indicator.classList.toggle('unread', Boolean(state.unread));
    }

    function open(kind, id, name, toolKey, completionRevision = null) {
        const key = keyOf(kind, id);
        let tab = tabs.get(key);
        if (tab) {
            if (tab.closed) { tab.closed = false; list.appendChild(tab.item); }
            activate(key);
            return;
        }
        const serial = ++sequence;
        const item = document.createElement('div'); item.className = 'workspace-tab-item';
        item.dataset.tabKey = key;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'workspace-tab';
        button.id = `workspace-tab-${serial}`; button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `workspace-panel-${serial}`);
        const svgNamespace = 'http://www.w3.org/2000/svg';
        const icon = document.createElementNS(svgNamespace, 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('class', 'workspace-tab-icon'); icon.setAttribute('aria-hidden', 'true');
        const iconUse = document.createElementNS(svgNamespace, 'use');
        iconUse.setAttribute('href', kind === 'room' ? '#icon-tab-group' : '#icon-tab-conversation');
        icon.appendChild(iconUse);
        const label = document.createElement('span'); label.className = 'workspace-tab-label';
        const indicator = document.createElement('span'); indicator.className = 'workspace-tab-status';
        indicator.setAttribute('role', 'img');
        const closeButton = document.createElement('button'); closeButton.type = 'button';
        closeButton.className = 'workspace-tab-close'; closeButton.title = 'Close tab';
        const closeIcon = document.createElementNS(svgNamespace, 'svg');
        closeIcon.setAttribute('viewBox', '0 0 16 16'); closeIcon.setAttribute('aria-hidden', 'true');
        const closePath = document.createElementNS(svgNamespace, 'path');
        closePath.setAttribute('d', 'm4.5 4.5 7 7m0-7-7 7');
        closeIcon.appendChild(closePath); closeButton.appendChild(closeIcon);
        const panel = document.createElement('div'); panel.className = 'workspace-tab-panel'; panel.id = `workspace-panel-${serial}`;
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
        panel.dataset.kind = kind; panel.dataset.targetId = id;
        const frame = document.createElement('iframe'); frame.className = 'workspace-conversation';
        const url = new URL(location.pathname, location.origin);
        url.search = new URLSearchParams({ embed: '1', workspaceTab: '1', [kind === 'room' ? 'embedRoom' : 'embedSession']: id });
        if (completionRevision !== null) url.searchParams.set('completionRevision', String(completionRevision));
        frame.src = url.href;
        button.append(icon, label, indicator); item.append(button, closeButton); panel.appendChild(frame);
        tab = { key, kind, id, item, button, label, indicator, closeButton, panel, frame, closed: false };
        tabs.set(key, tab); list.appendChild(item); panels.appendChild(panel);
        button.addEventListener('click', () => activate(key));
        closeButton.addEventListener('click', () => close(kind, id));
        frame.addEventListener('load', () => { if (visible(kind, id)) child(tab)?.activate(); });
        update(kind, id, { name: name || (kind === 'room' ? 'Group' : 'Session'), status: 'connecting' });
        activate(key);
    }

    function dispose(tab) {
        // Cleanup only view-owned drafts. Never call session deletion or abort.
        const cleanup = child(tab)?.dispose();
        tab.item.remove(); tabs.delete(tab.key);
        Promise.resolve(cleanup).catch(() => {}).finally(() => tab.panel.remove());
    }

    function retireClosed() {
        let pending = false;
        for (const tab of tabs.values()) {
            if (!tab.closed) continue;
            if (child(tab)?.busy()) pending = true;
            else dispose(tab);
        }
        if (!pending) { clearInterval(retirementTimer); retirementTimer = null; }
    }

    function close(kind, id) {
        if (host) { host.close(kind, id); return; }
        const key = keyOf(kind, id), tab = tabs.get(key);
        if (!tab || tab.closed) return;
        const items = openTabs();
        const index = items.indexOf(tab);
        const next = items[index + 1] || items[index - 1];
        child(tab)?.capture(); tab.closed = true; tab.item.remove();
        if (selected === key) {
            selected = null;
            if (next) activate(next.key, true);
            else { workspace.classList.remove('active'); document.getElementById('lobby-view').classList.add('active'); }
        }
        syncSelection(); retireClosed();
        if ([...tabs.values()].some(value => value.closed) && !retirementTimer) retirementTimer = setInterval(retireClosed, 250);
    }

    function navigate(kind, id, name, toolKey, revision) {
        if (host) {
            if (kind === ownKind && id === ownId) return false;
            host.open(kind, id, name, toolKey, revision); return true;
        }
        if (!enabled() || window.gladWorkspace?.isTiledMode()) return false;
        if (kind === 'room' && !name) name = sessionListRooms.find(room => room.id === id)?.name;
        open(kind, id, name, toolKey, revision); return true;
    }

    function toggleSidebar() {
        if (!enabled()) return;
        const view = child(tabs.get(selected)); view?.capture();
        collapsed = !collapsed;
        try { localStorage.setItem('glad-sidebar-collapsed', String(collapsed)); } catch (_) {}
        syncSidebar();
        requestAnimationFrame(() => view?.restore());
    }

    function attention(member) {
        if (host) { host.attention(member); return; }
        open('session', member.sessionId, member.displayName, member.toolKey);
        const deadline = Date.now() + 6000;
        const focus = () => {
            if (!visible('session', member.sessionId)) return;
            const view = child(tabs.get(keyOf('session', member.sessionId)));
            if (view?.focusAttention()) return;
            if (Date.now() < deadline) setTimeout(focus, 50);
        };
        focus();
    }

    list.addEventListener('keydown', event => {
        const button = event.target.closest('[role="tab"]');
        if (!button) return;
        const items = openTabs();
        const index = items.findIndex(tab => tab.button === button);
        let next;
        if (event.key === 'ArrowRight') next = items[(index + 1) % items.length];
        if (event.key === 'ArrowLeft') next = items[(index + items.length - 1) % items.length];
        if (event.key === 'Home') next = items[0];
        if (event.key === 'End') next = items[items.length - 1];
        if (next) { event.preventDefault(); activate(next.key, true); }
        if (event.key === 'Delete') { event.preventDefault(); const tab = items[index]; close(tab.kind, tab.id); }
    });
    media.addEventListener('change', () => {
        if (embedded) return;
        child(tabs.get(selected))?.capture();
        syncSidebar();
        if (enabled() && selected) activate(selected);
        else if (!enabled()) { workspace.classList.remove('active'); document.getElementById('lobby-view').classList.add('active'); }
    });
    window.addEventListener('storage', event => {
        if (event.key !== 'glad-sidebar-collapsed' || embedded) return;
        collapsed = event.newValue === 'true'; syncSidebar();
    });
    document.addEventListener('visibilitychange', () => {
        const tab = tabs.get(selected);
        if (!tab) return;
        if (document.hidden) child(tab)?.capture();
        else if (visible(tab.kind, tab.id)) child(tab)?.activate();
    });
    document.addEventListener('DOMContentLoaded', () => { if (!embedded) syncSidebar(); });
    window.gladTabs = Object.freeze({ navigate, open, close, update, visible, toggleSidebar, syncSelection, attention,
        isHosted: () => Boolean(host), ownKind, ownId });
})();
