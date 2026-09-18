        const GLAD_SPLIT_QUERY = window.gladLayout.splitQuery;
        const GLAD_SIDEBAR_KEY = window.gladLayout.sidebarStorageKey;

        function isSplitLayout() {
            return window.matchMedia(GLAD_SPLIT_QUERY).matches;
        }

        function clampSidebarWidth(value) {
            return window.gladLayout.clampSidebarWidth(value);
        }

        function applySidebarWidth(value) {
            return window.gladLayout.applySidebarWidth(value);
        }

        function initializeIosViewport() {
            const root = document.documentElement;
            const viewport = window.visualViewport;
            if (!root.classList.contains('ios-standalone') || !viewport) return;

            let frame = null;
            let chatAnchor = null;
            const captureChatAnchor = () => {
                const container = ['codex-chat-container', 'claude-chat-container']
                    .map(id => document.getElementById(id))
                    .find(element => element && element.getClientRects().length
                        && getComputedStyle(element).display !== 'none');
                if (!container) return null;
                return {
                    container,
                    scrollTop: container.scrollTop,
                    stickToBottom: container.scrollHeight - container.clientHeight - container.scrollTop <= 64
                };
            };
            const restoreChatAnchor = anchor => {
                if (!anchor?.container?.isConnected) return;
                anchor.container.scrollTop = anchor.stickToBottom
                    ? anchor.container.scrollHeight
                    : anchor.scrollTop;
            };
            const syncViewport = () => {
                frame = null;
                // A keyboard can shrink/pan the visual viewport while 100dvh
                // and window.innerHeight still describe the full layout viewport.
                // Leave pinch zoom to the browser rather than relaying it out.
                if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
                root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
                root.style.setProperty('--app-viewport-top', `${Math.max(0, viewport.offsetTop)}px`);
                const anchor = chatAnchor;
                chatAnchor = null;
                // Reading scrollHeight after updating the viewport variables
                // flushes the new layout, so restoration cannot race a user
                // scroll in the following animation frame.
                restoreChatAnchor(anchor);
                requestAnimationFrame(() => window.gladWorkspace?.syncTileReturnButton?.());
            };
            const scheduleViewportSync = () => {
                if (frame !== null) return;
                chatAnchor = captureChatAnchor();
                frame = requestAnimationFrame(syncViewport);
            };
            viewport.addEventListener('resize', scheduleViewportSync);
            viewport.addEventListener('scroll', scheduleViewportSync);
            window.addEventListener('resize', scheduleViewportSync);
            window.addEventListener('pageshow', scheduleViewportSync);
            document.addEventListener('visibilitychange', scheduleViewportSync);
            document.addEventListener('focusin', scheduleViewportSync);
            document.addEventListener('focusout', scheduleViewportSync);
            syncViewport();
        }

        function initializeResponsiveLayout() {
            initializeIosViewport();
            const storedWidth = Number(localStorage.getItem(GLAD_SIDEBAR_KEY));
            applySidebarWidth(storedWidth || 348);

            const handle = document.getElementById('sidebar-resizer');
            if (handle) {
                let dragging = false;
                const onPointerMove = event => {
                    if (!dragging) return;
                    applySidebarWidth(event.clientX);
                    if (typeof syncLayout === 'function') syncLayout({ keepAtBottom: false });
                };
                const stopDragging = () => {
                    if (!dragging) return;
                    dragging = false;
                    handle.classList.remove('dragging');
                    document.body.style.removeProperty('cursor');
                    document.body.style.removeProperty('user-select');
                    const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
                    localStorage.setItem(GLAD_SIDEBAR_KEY, String(clampSidebarWidth(width)));
                };
                handle.addEventListener('pointerdown', event => {
                    if (!isSplitLayout()) return;
                    dragging = true;
                    handle.classList.add('dragging');
                    handle.setPointerCapture?.(event.pointerId);
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                    event.preventDefault();
                });
                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', stopDragging);
                window.addEventListener('pointercancel', stopDragging);
            }

            const media = window.matchMedia(GLAD_SPLIT_QUERY);
            media.addEventListener('change', () => {
                applySidebarWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
                if (isSplitLayout()) scheduleSessionPolling();
                if (typeof syncLayout === 'function') requestAnimationFrame(() => syncLayout({ keepAtBottom: false }));
            });

            const controls = document.getElementById('terminal-controls');
            if (controls && typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(() => {
                    if (typeof syncLayout === 'function') syncLayout();
                }).observe(controls);
            }
        }

        window.addEventListener('resize', () => {
            if (isSplitLayout()) applySidebarWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
        });
        document.addEventListener('DOMContentLoaded', initializeResponsiveLayout);
