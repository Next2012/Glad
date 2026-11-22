(() => {
    const base = new URL('.', document.currentScript.src);
    const scripts = new Map();
    const styles = new Map();
    function loadScript(path) {
        const url = new URL(path, base).href;
        if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = () => { scripts.delete(url); script.remove(); reject(new Error('Unable to load preview component. Please retry.')); };
            document.head.appendChild(script);
        }));
        return scripts.get(url);
    }
    function loadStyle(path) {
        const url = new URL(path, base).href;
        if (!styles.has(url)) styles.set(url, new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet'; link.href = url;
            link.onload = resolve;
            link.onerror = () => { styles.delete(url); link.remove(); reject(new Error('Unable to load preview styles. Please retry.')); };
            document.head.appendChild(link);
        }));
        return styles.get(url);
    }
    async function loadTerminal() {
        await Promise.all([loadStyle('vendor/xterm.css'), loadScript('vendor/xterm.js'), loadScript('vendor/xterm-addon-fit.js')]);
    }
    async function openDocument(options) {
        await Promise.all([loadStyle('document-preview.css'), loadScript('document-preview.js')]);
        return window.gladDocumentPreview.open(options);
    }
    window.gladAssets = Object.freeze({ loadScript, loadStyle, loadTerminal, openDocument });

    function isResource(value) {
        try {
            const url = new URL(value, location.href);
            return url.origin === location.origin && /\/api\/sessions\/[^/]+\/(?:workspace-resource|mcp-resource)$/.test(url.pathname);
        } catch (_) { return false; }
    }
    document.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest?.('a[href]');
        const image = link ? null : event.target.closest?.('.markdown-document img[src]');
        const target = link || image;
        const url = link?.href || image?.src;
        if (!target || target.hasAttribute('download') || !isResource(url)) return;
        event.preventDefault();
        target.setAttribute('aria-busy', 'true');
        if (!window.gladDocumentPreview && typeof showAppToast === 'function') showAppToast('Opening preview…');
        void openDocument({ url, name: image?.alt || undefined, trigger: target }).catch(error => {
            alert(error.message);
        }).finally(() => target.removeAttribute('aria-busy'));
    });
})();
