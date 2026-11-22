(() => {
    const renderedCache = new Map();
    let renderedCacheBytes = 0;
    let cachedResourceMapper = window.gladWorkbenchResourceURL;
    const parser = window.markdownit({ html: false, linkify: true, breaks: true });
    function localFileURL(destination) {
        if (!/^file:\/\/(?:\/|localhost\/)/i.test(destination)
            || /[\u0000-\u001f\u007f\\]/.test(destination)
            || /%(?![a-f\d]{2})/i.test(destination)) return null;
        try {
            const url = new URL(destination);
            if (url.protocol !== 'file:' || url.username || url.password || url.port
                || (url.hostname && url.hostname.toLowerCase() !== 'localhost')) return null;
            let path = decodeURIComponent(url.pathname);
            if (!path.startsWith('/') || path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(path)) return null;
            if (/^\/[a-z]:/i.test(path)) {
                if (!/^\/[a-z]:\//i.test(path)) return null;
                path = path.slice(1);
            }
            return { path, hash: url.hash };
        } catch (_) {
            return null;
        }
    }
    const validateLink = parser.validateLink.bind(parser);
    parser.validateLink = destination => {
        if (/^file:/i.test(destination)) return Boolean(localFileURL(destination));
        return validateLink(destination);
    };
    parser.use(window.markdownitTaskLists, { enabled: false, label: true });
    parser.use(texmath, {
        delimiters: ['brackets', 'dollars'],
        engine: { renderToString: (source, options) => gladMarkdownRich.math(source, options.displayMode) }
    });
    // texmath handles standalone bracket blocks and single-line inline math.
    // Preserve the chat renderer's inline \[...\] and multiline \(...\) forms.
    parser.inline.ruler.before('escape', 'glad_bracket_math', (state, silent) => {
        const opening = state.src.slice(state.pos, state.pos + 2);
        if (opening !== '\\[' && opening !== '\\(') return false;
        const closing = opening === '\\[' ? '\\]' : '\\)';
        const end = state.src.indexOf(closing, state.pos + 2);
        if (end < 0 || end + 2 > state.posMax) return false;
        if (!silent) {
            const token = state.push('glad_bracket_math', 'math', 0);
            token.content = state.src.slice(state.pos + 2, end);
            token.meta = { display: opening === '\\[', original: state.src.slice(state.pos, end + 2) };
        }
        state.pos = end + 2;
        return true;
    });
    parser.renderer.rules.glad_bracket_math = (tokens, index) => {
        const token = tokens[index];
        return gladMarkdownRich.math(token.content, token.meta.display, token.meta.original);
    };
    // Keep the existing math markup, error fallback and cache when the plugin
    // recognizes formulas inside lists, blockquotes, links and table cells.
    for (const type of ['math_inline', 'math_inline_double', 'math_block', 'math_block_eqno']) {
        parser.renderer.rules[type] = (tokens, index) => {
            const token = tokens[index];
            const formula = gladMarkdownRich.math(token.content, type !== 'math_inline');
            return type === 'math_block_eqno'
                ? `${formula}<span class="markdown-equation-label">(${escapeHtml(token.info)})</span>`
                : formula;
        };
    }

    parser.renderer.rules.fence = (tokens, index) => {
        const token = tokens[index];
        const language = token.info.trim().split(/\s+/, 1)[0];
        // The token's source range includes a closing fence only when there are
        // two extra lines beyond its content. This also works in nested blocks.
        const contentLines = token.content ? token.content.split('\n').length - Number(token.content.endsWith('\n')) : 0;
        const closed = token.map && token.map[1] - token.map[0] === contentLines + 2;
        if (closed && language.toLowerCase() === 'mermaid') return gladMarkdownRich.diagram(token.content.trimEnd());
        if (closed && /^(math|latex|tex)$/i.test(language)) return gladMarkdownRich.math(token.content, true);
        const label = language ? `<div class="claude-tool-section-title">${escapeHtml(language)}</div>` : '';
        return `<pre>${label}<code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(token.content)}</code></pre>`;
    };

    function workspaceURL(destination, env) {
        const resourceURL = window.gladWorkbenchResourceURL || (value => value);
        if (/^file:/i.test(destination)) {
            const file = localFileURL(destination);
            if (!env.sessionId || !file) return null;
            return resourceURL(`/api/sessions/${encodeURIComponent(env.sessionId)}/workspace-resource?path=${encodeURIComponent(file.path)}${file.hash}`);
        }
        if (env.basePath?.startsWith('botlink-hub://resource/') && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) {
            try { destination = new URL(destination, env.basePath).href; } catch (_) { return null; }
        }
        // MCP resources retain their session identity; fragments stay in the UI.
        if (env.sessionId && destination.startsWith('botlink-hub://resource/')) {
            const split = destination.indexOf('#');
            const uri = split < 0 ? destination : destination.slice(0, split);
            const hash = split < 0 ? '' : destination.slice(split);
            return resourceURL(`/api/sessions/${encodeURIComponent(env.sessionId)}/mcp-resource?uri=${encodeURIComponent(uri)}${hash}`);
        }
        if (!env.sessionId || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\/api\/|\/vendor\/)/i.test(destination)) return resourceURL(destination);
        const rawPath = destination.split(/[?#]/, 1)[0];
        const split = destination.indexOf('#');
        const hash = split < 0 ? '' : destination.slice(split);
        try {
            let path = decodeURIComponent(rawPath);
            if (env.basePath && !/^(?:\/|[a-z]:[\\/])/i.test(path)) {
                const base = env.basePath.replace(/\\/g, '/');
                path = path ? base.slice(0, base.lastIndexOf('/') + 1) + path : base;
            }
            return resourceURL(`/api/sessions/${encodeURIComponent(env.sessionId)}/workspace-resource?path=${encodeURIComponent(path)}${hash}`);
        } catch (_) {
            return destination;
        }
    }

    function removeAttribute(token, name) {
        const index = token.attrIndex(name);
        if (index >= 0) token.attrs.splice(index, 1);
    }

    function markDocument(token, destination, env) {
        try {
            const url = new URL(destination, document.baseURI);
            if (url.origin !== location.origin || !/\/api\/sessions\/[^/]+\/(?:workspace-resource|mcp-resource)$/.test(url.pathname)) return;
            token.attrSet('data-glad-document', 'true');
            if (env.sessionId) token.attrSet('data-document-session', env.sessionId);
            token.attrSet('data-document-path', url.searchParams.get('path') || url.searchParams.get('uri') || '');
        } catch (_) {}
    }

    parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        const href = token.attrGet('href') || '';
        if (href.startsWith('#')) {
            try { token.attrSet('data-markdown-anchor', decodeURIComponent(href.slice(1))); } catch (_) {}
        } else {
            const destination = workspaceURL(href, env);
            if (destination == null) removeAttribute(token, 'href');
            else {
                token.attrSet('href', destination);
                markDocument(token, destination, env);
                token.attrSet('target', '_blank');
                token.attrSet('rel', 'noopener noreferrer');
            }
        }
        return renderer.renderToken(tokens, index, options);
    };

    const renderImage = parser.renderer.rules.image;
    parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        const destination = workspaceURL(token.attrGet('src') || '', env);
        if (destination == null) removeAttribute(token, 'src');
        else { token.attrSet('src', destination); markDocument(token, destination, env); }
        return renderImage(tokens, index, options, env, renderer);
    };

    parser.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
        const text = (tokens[index + 1]?.children || []).map(token => token.content).join('');
        const slug = text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s/g, '-');
        const count = env.headingCounts.get(slug) || 0;
        env.headingCounts.set(slug, count + 1);
        tokens[index].attrSet('data-markdown-heading', `${slug}${count ? `-${count}` : ''}`);
        return renderer.renderToken(tokens, index, options);
    };

    window.renderMarkdown = (markdown, options = {}) => {
        if (cachedResourceMapper !== window.gladWorkbenchResourceURL) {
            renderedCache.clear(); renderedCacheBytes = 0;
            cachedResourceMapper = window.gladWorkbenchResourceURL;
        }
        const env = { sessionId: options.sessionId ?? activeSessionId, basePath: options.basePath || '', headingCounts: new Map() };
        const source = String(markdown || '');
        // Parsing completed messages on every stream frame is expensive even
        // when the provider's DOM patch preserves their existing elements.
        const key = source.length <= 256 * 1024 ? `${env.sessionId || ''}\u0000${env.basePath}\u0000${source}` : null;
        const cached = key != null ? renderedCache.get(key) : null;
        if (cached) { renderedCache.delete(key); renderedCache.set(key, cached); return cached.html; }
        const html = `<div class="claude-md markdown-document">${parser.render(source, env)}</div>`;
        const bytes = key == null ? 0 : (key.length + html.length) * 2;
        if (key != null && bytes <= 1024 * 1024) {
            while (renderedCache.size && (renderedCache.size >= 256 || renderedCacheBytes + bytes > 4 * 1024 * 1024)) {
                const oldest = renderedCache.keys().next().value;
                renderedCacheBytes -= renderedCache.get(oldest).bytes; renderedCache.delete(oldest);
            }
            renderedCache.set(key, { html, bytes }); renderedCacheBytes += bytes;
        }
        return html;
    };

    document.addEventListener('click', event => {
        const link = event.target.closest?.('a[data-markdown-anchor]');
        if (!link) return;
        const documentElement = link.closest('.markdown-document');
        const target = Array.from(documentElement?.querySelectorAll('[data-markdown-heading]') || [])
            .find(heading => heading.dataset.markdownHeading === link.dataset.markdownAnchor);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ block: 'start' });
    });
})();
