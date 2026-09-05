// Session ordering is a browser layout preference, shared by lobby and tiles.
// Reorder DOM nodes during a drag: do not rebuild cards or reconnect previews.
(() => {
    const STORAGE_KEY = 'glad-session-order';
    const HOLD_MS = 3000;
    const MOVE_THRESHOLD = 8;
    const CONTROL_SELECTOR = 'button, a, input, select, textarea, [contenteditable="true"]';
    let order = readOrder();
    let latestSessions = [];
    let interaction = null;
    let deferredRefresh = false;
    let suppressClickUntil = 0;

    function readOrder() {
        try {
            const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
        } catch (_) { return []; }
    }

    function sort(sessions) {
        latestSessions = sessions;
        const rank = new Map(order.map((id, index) => [id, index]));
        return [...sessions].sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size));
    }

    function refreshViews() {
        const sessions = sort(latestSessions);
        if (typeof renderSessionList === 'function') renderSessionList(sessions);
        window.gladWorkspace?.refreshTiledSessionsFromList(sessions);
    }

    function deferRefresh(sessions) {
        latestSessions = sessions;
        if (!interaction) return false;
        deferredRefresh = true;
        if (!sessions.some(session => session.id === interaction.id)) {
            finish(false, false);
            return false;
        }
        return true;
    }

    function announce(message) {
        document.getElementById('session-reorder-status').textContent = message;
    }

    function eligible(target) {
        if (!(target instanceof Element) || target.closest(CONTROL_SELECTOR)) return null;
        const lobbyCard = target.closest('#sessions-list .session-card');
        if (lobbyCard) return { card: lobbyCard, kind: 'lobby', container: lobbyCard.parentElement };
        const header = target.closest('#tile-grid .tile-session-header');
        if (header && !document.body.classList.contains('tile-focus-open')) {
            return { card: header.closest('.tile-session-window'), kind: 'tiles', container: document.getElementById('tile-grid') };
        }
        return null;
    }

    function start(target, x, y, input, pointerId) {
        if (interaction) finish(false);
        suppressClickUntil = 0;
        const candidate = eligible(target);
        if (!candidate) return;
        const { card, kind, container } = candidate;
        const scroller = kind === 'lobby' ? document.getElementById('lobby') : null;
        interaction = { card, kind, container, scroller, id: card.dataset.sessionId,
            input, pointerId, startX: x, startY: y, x, y, active: false,
            startScroll: scroller?.scrollTop || 0, frame: null, timer: null,
            originalIds: Array.from(container.children).map(node => node.dataset.sessionId).filter(Boolean) };
        if (kind === 'lobby') {
            card.classList.add('reorder-pressing');
            interaction.timer = setTimeout(beginDrag, HOLD_MS);
        }
    }

    function beginDrag() {
        const drag = interaction;
        if (!drag || !drag.card.isConnected || !drag.container.getClientRects().length) return finish(false);
        clearTimeout(drag.timer);
        drag.active = true;
        drag.card.classList.remove('reorder-pressing');
        drag.card.classList.add('reorder-source');
        document.body.classList.add('session-reordering');
        const ghost = document.createElement('div');
        ghost.className = 'session-reorder-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.textContent = drag.card.querySelector('.session-name, .tile-session-title-row strong')?.textContent || 'Session';
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        if (drag.input === 'pointer') {
            try { document.body.setPointerCapture(drag.pointerId); } catch (_) {}
        }
        announce('Reordering session. Drag to a new position; release to save or press Escape to cancel.');
        drag.frame = requestAnimationFrame(tick);
    }

    function move(x, y) {
        const drag = interaction;
        if (!drag) return;
        drag.x = x;
        drag.y = y;
        if (!drag.active && Math.hypot(x - drag.startX, y - drag.startY) > MOVE_THRESHOLD) {
            if (drag.kind === 'tiles') beginDrag();
            else finish(false); // moving before the hold finishes is normal scrolling
        }
    }

    function tick(timestamp) {
        const drag = interaction;
        if (!drag?.active) return;
        if (!drag.card.isConnected || !drag.container.getClientRects().length) return finish(false);
        const elapsed = Math.min(32, timestamp - (drag.lastFrame ?? timestamp));
        drag.lastFrame = timestamp;
        const bounds = (drag.scroller || drag.container).getBoundingClientRect();
        if (drag.scroller && drag.x >= bounds.left - 24 && drag.x <= bounds.right + 24) {
            const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
            const edge = Math.min(72, (bottom - top) / 4);
            const velocity = drag.y < top + edge ? -Math.min(1, (top + edge - drag.y) / edge)
                : drag.y > bottom - edge ? Math.min(1, (drag.y - bottom + edge) / edge) : 0;
            drag.scroller.scrollTop += velocity * elapsed * 0.7;
        }
        const ghostWidth = drag.ghost.offsetWidth;
        drag.ghost.style.transform = `translate(${Math.max(8, Math.min(innerWidth - ghostWidth - 8, drag.x + 14))}px, ${Math.max(8, Math.min(innerHeight - 64, drag.y + 14))}px)`;
        if (drag.x >= bounds.left - 24 && drag.x <= bounds.right + 24) updateInsertion(drag);
        drag.frame = requestAnimationFrame(tick);
    }

    function updateInsertion(drag) {
        const children = Array.from(drag.container.children).filter(node => node.dataset.sessionId);
        if (drag.kind === 'tiles') {
            const target = document.elementFromPoint(drag.x, drag.y)?.closest('#tile-grid > .tile-session-window');
            if (target && target !== drag.card) {
                const after = children.indexOf(drag.card) < children.indexOf(target);
                drag.container.insertBefore(drag.card, after ? target.nextElementSibling : target);
            }
            return;
        }
        const before = children.filter(card => card !== drag.card).find(card => {
            const box = card.getBoundingClientRect();
            return drag.y < box.top + box.height / 2;
        }) || null;
        if (drag.card.nextElementSibling !== before) drag.container.insertBefore(drag.card, before);
    }

    function finish(commit, refresh = true) {
        const drag = interaction;
        if (!drag) return;
        interaction = null;
        clearTimeout(drag.timer);
        cancelAnimationFrame(drag.frame);
        drag.card.classList.remove('reorder-pressing', 'reorder-source');
        drag.ghost?.remove();
        document.body.classList.remove('session-reordering');
        if (drag.input === 'pointer') {
            try { document.body.releasePointerCapture(drag.pointerId); } catch (_) {}
        }
        if (drag.active) {
            suppressClickUntil = Date.now() + 400;
            if (commit) {
                const alive = new Set(latestSessions.map(session => session.id));
                const movedIds = Array.from(drag.container.children).map(node => node.dataset.sessionId).filter(id => alive.has(id));
                const visible = new Set(drag.originalIds);
                const sorted = sort(latestSessions);
                let index = 0;
                // Tiles only replace their own page's positions in the full order.
                order = sorted.map(session => visible.has(session.id) ? movedIds[index++] : session.id).filter(Boolean);
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); announce('Session order saved.'); }
                catch (_) { announce('Session order updated, but this browser could not save it.'); }
            } else announce('Session reordering cancelled.');
        }
        const needsRefresh = drag.active || deferredRefresh;
        deferredRefresh = false;
        if (refresh && needsRefresh) refreshViews();
    }

    document.addEventListener('pointerdown', event => {
        // Lobby touch uses cancelable touchmove so scrolling remains available
        // before the hold, but cannot steal the gesture after drag activation.
        if (event.pointerType === 'touch' && event.target.closest('#sessions-list')) return;
        if (event.button !== 0 || !event.isPrimary) return;
        start(event.target, event.clientX, event.clientY, 'pointer', event.pointerId);
    });
    document.addEventListener('pointermove', event => {
        if (interaction?.input !== 'pointer' || event.pointerId !== interaction.pointerId) return;
        move(event.clientX, event.clientY);
        if (interaction?.active) event.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerup', event => {
        if (interaction?.input === 'pointer' && event.pointerId === interaction.pointerId) finish(true);
    });
    document.addEventListener('pointercancel', event => {
        if (interaction?.input === 'pointer' && event.pointerId === interaction.pointerId) finish(false);
    });
    document.addEventListener('touchstart', event => {
        if (event.touches.length !== 1) { finish(false); return; }
        if (!event.target.closest('#sessions-list')) return;
        const touch = event.touches[0];
        start(event.target, touch.clientX, touch.clientY, 'touch', touch.identifier);
    }, { passive: true });
    document.addEventListener('touchmove', event => {
        if (interaction?.input !== 'touch') return;
        if (event.touches.length !== 1) { finish(false); return; }
        const touch = Array.from(event.touches).find(touch => touch.identifier === interaction.pointerId);
        if (!touch) return;
        move(touch.clientX, touch.clientY);
        if (interaction?.active) event.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', event => {
        if (interaction?.input === 'touch' && Array.from(event.changedTouches).some(touch => touch.identifier === interaction.pointerId)) finish(true);
    });
    document.addEventListener('touchcancel', () => { if (interaction?.input === 'touch') finish(false); });
    document.addEventListener('scroll', () => {
        if (interaction?.scroller && !interaction.active && interaction.scroller.scrollTop !== interaction.startScroll) finish(false);
    }, true);
    document.addEventListener('contextmenu', event => { if (interaction) event.preventDefault(); });
    document.addEventListener('click', event => {
        if (interaction?.active || (Date.now() < suppressClickUntil && event.target.closest('#sessions-list, #tile-grid'))) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && interaction) { event.preventDefault(); finish(false); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
    window.addEventListener('blur', () => finish(false));
    window.addEventListener('resize', () => finish(false));
    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY) return;
        order = readOrder();
        if (!interaction) refreshViews();
    });

    window.gladSessionOrder = Object.freeze({ sort, deferRefresh, isInteracting: () => Boolean(interaction) });
})();
