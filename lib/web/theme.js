        const GLAD_THEME_KEY = 'glad-theme';

        function getGladTheme() {
            const stored = localStorage.getItem(GLAD_THEME_KEY);
            if (stored === 'light' || stored === 'dark') return stored;
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }

        function getGladTerminalTheme(theme = getGladTheme()) {
            return theme === 'light'
                ? {
                    background: '#ffffff', foreground: '#172033', cursor: '#007aff',
                    selectionBackground: 'rgba(0, 122, 255, 0.22)', black: '#172033', white: '#f5f6f8',
                    brightBlack: '#667085', brightWhite: '#ffffff'
                }
                : {
                    background: '#000000', foreground: '#ffffff', cursor: '#34c759',
                    selectionBackground: 'rgba(0, 122, 255, 0.32)'
                };
        }

        function syncGladThemeControls(theme = getGladTheme()) {
            ['light', 'dark'].forEach(value => {
                const button = document.getElementById(`theme-${value}-btn`);
                if (button) button.setAttribute('aria-pressed', String(value === theme));
            });
        }

        function applyGladTheme(theme, options = {}) {
            const resolved = theme === 'light' ? 'light' : 'dark';
            document.documentElement.dataset.theme = resolved;
            document.documentElement.style.removeProperty('background-color');
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.content = resolved === 'light' ? '#f5f6f8' : '#000000';
            syncGladThemeControls(resolved);
            try {
                if (typeof term !== 'undefined' && term) {
                    term.options.theme = getGladTerminalTheme(resolved);
                    term.refresh(0, Math.max(0, term.rows - 1));
                }
            } catch (_) {}
            if (!options.silent) window.dispatchEvent(new CustomEvent('glad-theme-change', { detail: resolved }));
        }

        function setGladTheme(theme) {
            if (theme !== 'light' && theme !== 'dark') return;
            localStorage.setItem(GLAD_THEME_KEY, theme);
            applyGladTheme(theme);
        }

        applyGladTheme(getGladTheme(), { silent: true });

        const gladSystemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        gladSystemTheme.addEventListener('change', () => {
            if (!localStorage.getItem(GLAD_THEME_KEY)) applyGladTheme(getGladTheme());
        });
        window.addEventListener('storage', event => {
            if (event.key === GLAD_THEME_KEY) applyGladTheme(getGladTheme());
        });
        document.addEventListener('DOMContentLoaded', () => syncGladThemeControls());
