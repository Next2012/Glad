        const GLAD_SPLIT_QUERY = '(min-width: 920px)';
        const GLAD_SIDEBAR_KEY = 'glad-sidebar-width';

        function isSplitLayout() {
            return window.matchMedia(GLAD_SPLIT_QUERY).matches;
        }

        function clampSidebarWidth(value) {
            const max = Math.max(300, Math.min(480, window.innerWidth - 484));
            return Math.min(max, Math.max(300, Number(value) || 348));
        }

        function applySidebarWidth(value) {
            const width = clampSidebarWidth(value);
            document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
            return width;
        }

        function initializeResponsiveLayout() {
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
