(() => {
    const mathCache = new Map();
    const diagramCache = new Map();
    const diagramJobs = new WeakMap();
    let mermaidLoading;
    let renderQueue = Promise.resolve();
    let diagramSequence = 0;
    let instanceSequence = 0;

    function remember(cache, key, value, limit) {
        cache.set(key, value);
        if (cache.size > limit) cache.delete(cache.keys().next().value);
        return value;
    }

    function math(source, display, original = source) {
        const key = `${display}:${source}`;
        if (mathCache.has(key)) return mathCache.get(key);
        try {
            if (source.length > 10000 || !window.katex) throw new Error('Math unavailable');
            const html = katex.renderToString(source, {
                displayMode: display, throwOnError: true, trust: false,
                strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: {}
            });
            return remember(mathCache, key, `<span class="markdown-math${display ? ' display' : ''}">${html.replaceAll('\n', '&#10;')}</span>`, 256);
        } catch (_) {
            return `<code class="markdown-math-fallback">${escapeHtml(original)}</code>`;
        }
    }

    function diagram(source) {
        return `<div class="markdown-diagram" data-diagram-source="${escapeHtml(source)}"><pre><code>${escapeHtml(source)}</code></pre></div>`;
    }

    function preserveDiagram(current, next) {
        return current.classList?.contains('markdown-diagram')
            && next.classList?.contains('markdown-diagram')
            && current.dataset.diagramSource === next.dataset.diagramSource;
    }

    function loadMermaid() {
        if (!mermaidLoading) {
            mermaidLoading = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'vendor/mermaid.min.js';
                script.onload = () => resolve(window.mermaid);
                script.onerror = () => reject(new Error('Diagram renderer unavailable'));
                document.head.appendChild(script);
            });
        }
        return mermaidLoading;
    }

    function diagramResult(source, theme) {
        const key = `${theme}:${source}`;
        if (diagramCache.has(key)) return diagramCache.get(key);
        // Mermaid has global configuration and a shared parser. Serialize work
        // so simultaneous messages and theme changes cannot race each other.
        const result = renderQueue.then(async () => {
            if (source.length > 50000) throw new Error('Diagram is too large');
            const mermaid = await loadMermaid();
            mermaid.initialize({
                startOnLoad: false, securityLevel: 'strict',
                theme: theme === 'dark' ? 'dark' : 'default',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                htmlLabels: false, flowchart: { htmlLabels: false },
                maxTextSize: 50000, maxEdges: 500, suppressErrorRendering: true,
                secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
                    'suppressErrorRendering', 'htmlLabels', 'flowchart']
            });
            const id = `glad-diagram-${++diagramSequence}`;
            const scratch = document.createElement('div');
            scratch.className = 'markdown-diagram-scratch';
            scratch.setAttribute('aria-hidden', 'true');
            document.body.appendChild(scratch);
            try {
                const { svg } = await mermaid.render(id, source, scratch);
                return { svg, id };
            } finally {
                scratch.remove();
            }
        });
        renderQueue = result.catch(() => {});
        return remember(diagramCache, key, result, 32);
    }

    function updateDiagram(element, update) {
        const scroller = element.closest('#codex-chat-container, #claude-chat-container, .tile-chat-surface');
        const previousTop = scroller?.scrollTop || 0;
        const atBottom = scroller && scroller.scrollHeight - scroller.clientHeight - previousTop <= 64;
        update();
        if (scroller) scroller.scrollTop = atBottom ? scroller.scrollHeight : previousTop;
    }

    function renderDiagrams(container) {
        const theme = document.documentElement.dataset.theme || 'dark';
        for (const element of container.querySelectorAll('.markdown-diagram')) {
            const source = element.dataset.diagramSource;
            const key = `${theme}:${source}`;
            if (diagramJobs.get(element)?.key === key) continue;
            const job = { key };
            diagramJobs.set(element, job);
            const isCurrent = () => element.isConnected && diagramJobs.get(element) === job
                && element.dataset.diagramSource === source
                && (document.documentElement.dataset.theme || 'dark') === theme;
            diagramResult(source, theme).then(({ svg, id }) => {
                if (!isCurrent()) return;
                updateDiagram(element, () => {
                    const output = document.createElement('div');
                    output.className = 'markdown-diagram-output';
                    // Cached SVGs need unique IDs in each message/tile, including
                    // the scoped stylesheet, marker URLs and accessibility IDs.
                    output.innerHTML = svg.replaceAll(id, `${id}-view-${++instanceSequence}`);
                    const details = document.createElement('details');
                    details.className = 'markdown-diagram-source';
                    details.innerHTML = `<summary>Source</summary><pre><code>${escapeHtml(source)}</code></pre>`;
                    element.replaceChildren(output, details);
                    element.dataset.diagramTheme = theme;
                });
            }).catch(() => {
                if (!isCurrent()) return;
                updateDiagram(element, () => {
                    element.innerHTML = `<div class="markdown-diagram-error">Diagram unavailable — source shown below.</div><pre><code>${escapeHtml(source)}</code></pre>`;
                });
            });
        }
    }

    window.gladMarkdownRich = Object.freeze({ math, diagram, preserveDiagram, renderDiagrams });
    window.addEventListener('glad-theme-change', () => renderDiagrams(document));
})();
