(() => {
    const parser = window.markdownit({ html: false, linkify: true, breaks: true });
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
        if (!env.sessionId || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\/api\/|\/vendor\/)/i.test(destination)) return destination;
        const path = destination.split(/[?#]/, 1)[0];
        try {
            return `/api/sessions/${encodeURIComponent(env.sessionId)}/workspace-resource?path=${encodeURIComponent(decodeURIComponent(path))}`;
        } catch (_) {
            return destination;
        }
    }

    parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        const href = token.attrGet('href') || '';
        if (href.startsWith('#')) {
            try { token.attrSet('data-markdown-anchor', decodeURIComponent(href.slice(1))); } catch (_) {}
        } else {
            token.attrSet('href', workspaceURL(href, env));
            token.attrSet('target', '_blank');
            token.attrSet('rel', 'noopener noreferrer');
        }
        return renderer.renderToken(tokens, index, options);
    };

    const renderImage = parser.renderer.rules.image;
    parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        token.attrSet('src', workspaceURL(token.attrGet('src') || '', env));
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
        const env = { sessionId: options.sessionId ?? activeSessionId, headingCounts: new Map() };
        return `<div class="claude-md markdown-document">${parser.render(String(markdown || ''), env)}</div>`;
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
