(() => {
    const splitQuery = '(min-width: 920px)';
    const sidebarStorageKey = 'glad-sidebar-width';

    function clampSidebarWidth(value) {
        const max = Math.max(300, Math.min(480, window.innerWidth - 484));
        return Math.min(max, Math.max(300, Number(value) || 348));
    }

    function applySidebarWidth(value) {
        const width = clampSidebarWidth(value);
        document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
        return width;
    }

    window.gladLayout = Object.freeze({
        splitQuery,
        sidebarStorageKey,
        clampSidebarWidth,
        applySidebarWidth
    });

    const storedTheme = localStorage.getItem('glad-theme');
    const theme = storedTheme === 'light' || storedTheme === 'dark'
        ? storedTheme
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.backgroundColor = theme === 'dark' ? '#000000' : '#f5f6f8';

    const storedSidebarWidth = Number(localStorage.getItem(sidebarStorageKey));
    if (Number.isFinite(storedSidebarWidth) && storedSidebarWidth > 0) {
        applySidebarWidth(storedSidebarWidth);
    }
})();
