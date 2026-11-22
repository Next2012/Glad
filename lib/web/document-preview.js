(() => {
    const assetBase = new URL('.', document.currentScript.src);
    const MAX_TEXT_BYTES = 1024 * 1024;
    const MAX_HIGHLIGHT_BYTES = 200 * 1024;
    const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;
    const LINE_HEIGHT = 20;
    const languages = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', css: 'css', json: 'json', xml: 'xml', html: 'xml', htm: 'xml', sh: 'bash', bash: 'bash', zsh: 'bash', yaml: 'yaml', yml: 'yaml', sql: 'sql', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', ini: 'ini', toml: 'ini', diff: 'diff', patch: 'diff' };
    let dialog, body, status, title, download, toolbar, pageLabel;
    let active = null, pdfLibrary = null;

    function resourceInfo(value, image = false) {
        const url = new URL(value, document.baseURI);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) throw new Error('Only local session documents can be previewed.');
        const match = url.pathname.match(/\/api\/sessions\/([^/]+)\/(workspace-resource|mcp-resource)$/);
        if (!match && !image) throw new Error('This link is not a session document.');
        const path = url.searchParams.get('path') || url.searchParams.get('uri') || url.pathname;
        const name = path.split(/[\/\\]/).pop() || 'Document';
        return { url, path, name, sessionId: match ? decodeURIComponent(match[1]) : '' };
    }
    function isCurrent(state) { return Boolean(state) && active === state && !state.controller.signal.aborted && dialog.open; }
    function setStatus(message) { status.textContent = message; status.hidden = !message; }
    function dispose(state) {
        if (!state) return;
        state.controller.abort();
        state.pdfRender?.cancel();
        const destruction = state.pdfLoading && !state.pdfLoading.destroyed ? state.pdfLoading.destroy() : null;
        destruction?.catch?.(() => {});
        state.viewer?.destroy();
        if (state.image) state.image.removeAttribute('src');
        if (state.canvas) { state.canvas.width = 0; state.canvas.height = 0; }
    }
    function close() {
        const previous = active;
        active = null;
        dispose(previous);
        if (dialog?.open) dialog.close();
        body?.replaceChildren();
        if (previous?.trigger?.isConnected) previous.trigger.focus({ preventScroll: true });
    }
    function button(label, action, text = label) {
        const element = document.createElement('button');
        element.type = 'button'; element.setAttribute('aria-label', label); element.textContent = text;
        element.addEventListener('click', action);
        return element;
    }
    function ensureDialog() {
        if (dialog) return;
        dialog = document.createElement('dialog');
        dialog.id = 'glad-document-preview';
        dialog.className = 'document-preview';
        dialog.setAttribute('aria-label', 'Document preview');
        const header = document.createElement('header'); header.className = 'document-preview-header';
        title = document.createElement('h2'); title.className = 'document-preview-title';
        download = document.createElement('a'); download.className = 'document-preview-download'; download.textContent = 'Download';
        const closeButton = button('Close document preview', close, '×'); closeButton.className = 'document-preview-close';
        header.append(title, download, closeButton);
        toolbar = document.createElement('div'); toolbar.className = 'document-preview-toolbar'; toolbar.hidden = true;
        toolbar.append(button('Previous page', () => changePage(-1), '‹'));
        pageLabel = document.createElement('span'); pageLabel.className = 'document-preview-page'; pageLabel.setAttribute('aria-live', 'polite');
        toolbar.append(pageLabel, button('Next page', () => changePage(1), '›'), button('Zoom out', () => changeZoom(0.8), '−'), button('Zoom in', () => changeZoom(1.25), '+'), button('Fit page width', () => { const state = active; if (state?.pdf) { state.zoom = 1; void drawPDF(state).catch(error => fail(state, error)); } }, 'Fit width'));
        status = document.createElement('div'); status.className = 'document-preview-status'; status.setAttribute('role', 'status');
        body = document.createElement('div'); body.className = 'document-preview-body'; body.tabIndex = 0;
        dialog.append(header, toolbar, status, body);
        document.body.appendChild(dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('close', () => { if (!dialog.open && active) close(); });
        dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
    }
    function fail(state, error) {
        if (!isCurrent(state)) return;
        setStatus(''); toolbar.hidden = true;
        const message = document.createElement('p'); message.className = 'document-preview-error'; message.setAttribute('role', 'alert');
        message.textContent = error?.message || 'Unable to preview this document. You can download it instead.';
        body.replaceChildren(message);
    }
    async function readPrefix(response, limit) {
        const reader = response.body?.getReader();
        if (!reader) {
            const rawLength = response.headers.get('content-length');
            const length = rawLength == null ? NaN : Number(rawLength);
            if (!Number.isFinite(length) || length > limit) throw new Error('This browser cannot preview a large file safely. Download it instead.');
            return new Uint8Array(await response.arrayBuffer());
        }
        const chunks = []; let length = 0;
        while (length < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            const piece = value.subarray(0, limit - length); chunks.push(piece); length += piece.length;
            if (piece.length < value.length || length === limit) { await reader.cancel(); break; }
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
    }
    async function responseError(state, code) {
        let detail = '';
        try {
            const response = await fetch(state.fetchURL, { headers: { Range: 'bytes=0-4095' }, signal: state.controller.signal, redirect: 'error' });
            if (!response.ok) detail = new TextDecoder().decode(await readPrefix(response, 4096)).trim().slice(0, 300);
            else void response.body?.cancel().catch(() => {});
        } catch (_) {}
        return new Error(`Unable to open document (HTTP ${code})${detail ? ': ' + detail : '.'}`);
    }
    function responseFilename(disposition) {
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (encoded) { try { return decodeURIComponent(encoded[1].trim()); } catch (_) {} }
        const quoted = disposition.match(/filename="((?:\\.|[^"\\])*)"/i);
        if (quoted) return quoted[1].replace(/\\(["\\])/g, '$1');
        return disposition.match(/filename=([^;]+)/i)?.[1]?.trim() || '';
    }
    async function metadata(state) {
        let response = await fetch(state.fetchURL, { method: 'HEAD', signal: state.controller.signal, redirect: 'error' });
        if ([400, 405, 501].includes(response.status)) {
            response = await fetch(state.fetchURL, { headers: { Range: 'bytes=0-1023' }, signal: state.controller.signal, redirect: 'error' });
            void response.body?.cancel().catch(() => {});
        }
        if (!response.ok) throw await responseError(state, response.status);
        const range = response.headers.get('content-range');
        const size = range?.match(/\/(\d+)$/)?.[1] || response.headers.get('content-length');
        return { type: (response.headers.get('content-type') || '').split(';', 1)[0].trim(), size: size == null ? null : Number(size), disposition: response.headers.get('content-disposition') || '' };
    }
    async function readText(state) {
        const response = await fetch(state.fetchURL, { headers: { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` }, signal: state.controller.signal, redirect: 'error' });
        if (!response.ok) throw await responseError(state, response.status);
        const bytes = await readPrefix(response, MAX_TEXT_BYTES);
        state.previewBytes = bytes.length;
        state.truncated = Number.isFinite(state.size) ? state.size > MAX_TEXT_BYTES : bytes.length >= MAX_TEXT_BYTES;
        return new TextDecoder('utf-8').decode(bytes);
    }
    async function highlightStyle() {
        const theme = document.documentElement.dataset.theme === 'dark' ? 'github-dark' : 'github';
        await window.gladAssets.loadStyle(`vendor/highlight/styles/${theme}.min.css`);
        if (theme !== (document.documentElement.dataset.theme === 'dark' ? 'github-dark' : 'github')) return highlightStyle();
        const expected = new URL(`vendor/highlight/styles/${theme}.min.css`, assetBase).href;
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
            if (/\/vendor\/highlight\/styles\/github(?:-dark)?\.min\.css$/.test(link.href)) link.disabled = link.href !== expected;
        }
    }
    function fragmentTarget(state) {
        let hash;
        try { hash = decodeURIComponent(state.url.hash.slice(1)); } catch (_) { return; }
        const line = hash.match(/^L(\d+)(?:-L?(\d+))?$/i);
        if (line && state.lineCount) {
            const start = Math.max(1, Math.min(state.lineCount, Number(line[1])));
            const end = Math.max(start, Math.min(state.lineCount, Number(line[2] || line[1])));
            const highlight = body.querySelector('.document-preview-line-highlight');
            if (highlight) { highlight.hidden = false; highlight.style.top = `${(start - 1) * LINE_HEIGHT}px`; highlight.style.height = `${(end - start + 1) * LINE_HEIGHT}px`; highlight.dataset.startLine = String(start); highlight.dataset.endLine = String(end); }
            body.scrollTop = Math.max(0, (start - 1) * LINE_HEIGHT - body.clientHeight / 3);
        } else if (hash && state.kind === 'markdown') {
            const target = Array.from(body.querySelectorAll('[data-markdown-heading]')).find(element => element.dataset.markdownHeading === hash);
            target?.scrollIntoView({ block: 'start' });
        }
    }
    function codeView(state, text) {
        state.lineCount = text.split('\n').length;
        const frame = document.createElement('div'); frame.className = 'document-preview-code-frame';
        const gutter = document.createElement('pre'); gutter.className = 'document-preview-line-numbers'; gutter.setAttribute('aria-hidden', 'true');
        gutter.textContent = Array.from({ length: Math.min(state.lineCount, 60000) }, (_, index) => String(index + 1)).join('\n');
        const pre = document.createElement('pre'); pre.className = 'document-preview-code';
        const code = document.createElement('code'); code.textContent = text; pre.appendChild(code);
        const highlight = document.createElement('div'); highlight.className = 'document-preview-line-highlight'; highlight.hidden = true; highlight.setAttribute('aria-hidden', 'true');
        frame.append(gutter, pre, highlight); body.replaceChildren(frame); fragmentTarget(state);
        return code;
    }
    async function showText(state) {
        const text = await readText(state);
        if (!isCurrent(state)) return;
        setStatus(state.truncated ? 'Showing the first 1 MiB. Download the file to read the rest.' : '');
        if (state.kind === 'markdown') {
            const article = document.createElement('article'); article.className = 'document-preview-markdown';
            article.innerHTML = renderMarkdown(text, { sessionId: state.sessionId, basePath: state.path });
            body.replaceChildren(article); gladMarkdownRich.renderDiagrams(article); fragmentTarget(state);
        } else {
            const code = codeView(state, text);
            const language = languages[state.extension];
            if (language && state.previewBytes <= MAX_HIGHLIGHT_BYTES) {
                try {
                    await Promise.all([window.gladAssets.loadScript('vendor/highlight/highlight.min.js'), highlightStyle()]);
                    if (isCurrent(state) && window.hljs?.getLanguage(language)) { code.className = `language-${language}`; window.hljs.highlightElement(code); }
                } catch (_) { if (isCurrent(state)) setStatus(`${state.truncated ? 'Showing the first 1 MiB. ' : ''}Syntax highlighting unavailable; plain text shown.`); }
            }
        }
    }
    async function showImage(state) {
        await Promise.all([window.gladAssets.loadScript('vendor/viewerjs/viewer.min.js'), window.gladAssets.loadStyle('vendor/viewerjs/viewer.min.css')]);
        if (!isCurrent(state)) return;
        const stage = document.createElement('div'); stage.className = 'document-preview-image-stage';
        const image = document.createElement('img'); image.className = 'document-preview-image'; image.alt = state.name;
        state.image = image; stage.appendChild(image); body.replaceChildren(stage);
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = () => reject(new Error('Unable to decode this image. Download it to open it in another app.'));
            state.controller.signal.addEventListener('abort', () => { image.removeAttribute('src'); resolve(); }, { once: true });
            image.src = state.fetchURL;
        });
        if (!isCurrent(state)) return;
        state.viewer = new window.Viewer(image, { inline: true, navbar: false, title: false, button: false, fullscreen: false, keyboard: false, transition: false, tooltip: true, minWidth: 200, minHeight: 200, toolbar: { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1, rotateLeft: 1, rotateRight: 1 } });
        setStatus('');
    }
    async function showPDF(state) {
        pdfLibrary ||= import(new URL('vendor/pdfjs/build/pdf.min.mjs', assetBase).href).catch(error => { pdfLibrary = null; throw error; });
        const library = await pdfLibrary;
        if (!isCurrent(state)) return;
        library.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/build/pdf.worker.min.mjs', assetBase).href;
        state.pdfLoading = library.getDocument({ url: state.fetchURL, cMapUrl: new URL('vendor/pdfjs/cmaps/', assetBase).href, cMapPacked: true, standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', assetBase).href, wasmUrl: new URL('vendor/pdfjs/wasm/', assetBase).href, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536, maxImageSize: 16 * 1024 * 1024, isEvalSupported: false });
        state.pdfLoading.onProgress = progress => { if (isCurrent(state)) setStatus(progress.total > 0 ? `Loading PDF… ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : 'Loading PDF…'); };
        state.pdf = await state.pdfLoading.promise;
        if (!isCurrent(state)) { if (!state.pdfLoading.destroyed) await state.pdfLoading.destroy(); return; }
        state.page = Math.max(1, Math.min(state.pdf.numPages, Number(state.url.hash.match(/page=(\d+)/i)?.[1] || 1))); state.zoom = 1;
        state.canvas = document.createElement('canvas'); state.canvas.className = 'document-preview-canvas';
        body.replaceChildren(state.canvas); toolbar.hidden = false;
        await drawPDF(state);
    }
    async function drawPDF(state) {
        if (!isCurrent(state) || !state.pdf) return;
        const renderSequence = (state.renderSequence || 0) + 1; state.renderSequence = renderSequence;
        state.pdfRender?.cancel();
        try { await state.pdfRender?.promise; } catch (_) {}
        if (!isCurrent(state) || state.renderSequence !== renderSequence) return;
        state.pdfPage?.cleanup();
        const page = await state.pdf.getPage(state.page);
        if (!isCurrent(state) || state.renderSequence !== renderSequence) return;
        state.pdfPage = page;
        const natural = page.getViewport({ scale: 1 });
        if (!(natural.width > 0 && natural.height > 0) || !Number.isFinite(natural.width * natural.height)) throw new Error('This PDF page has invalid dimensions.');
        const scale = Math.min(5, Math.max(0.15, (body.clientWidth - 32) / natural.width * state.zoom));
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2, 4096 / viewport.width, 4096 / viewport.height, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
        const canvas = state.canvas;
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`;
        pageLabel.textContent = `Page ${state.page} of ${state.pdf.numPages}`;
        toolbar.querySelector('[aria-label="Previous page"]').disabled = state.page <= 1;
        toolbar.querySelector('[aria-label="Next page"]').disabled = state.page >= state.pdf.numPages;
        state.pdfRender = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
        try { await state.pdfRender.promise; if (isCurrent(state) && state.renderSequence === renderSequence) setStatus(''); }
        catch (error) { if (error.name !== 'RenderingCancelledException' && isCurrent(state)) fail(state, error); }
    }
    function changePage(delta) { const state = active; if (state?.pdf) { state.page = Math.max(1, Math.min(state.pdf.numPages, state.page + delta)); body.scrollTop = 0; void drawPDF(state).catch(error => fail(state, error)); } }
    function changeZoom(multiplier) { const state = active; if (state?.pdf) { state.zoom = Math.max(0.25, Math.min(4, state.zoom * multiplier)); void drawPDF(state).catch(error => fail(state, error)); } }
    async function open(options) {
        if (typeof options === 'string') options = { url: options };
        options ||= {};
        ensureDialog();
        let info;
        try { info = resourceInfo(options.url, options.image || options.trigger?.tagName === 'IMG'); }
        catch (error) { const state = { controller: new AbortController(), trigger: active?.trigger || options.trigger || document.activeElement }; dispose(active); active = state; title.textContent = 'Document preview'; body.replaceChildren(); download.removeAttribute('href'); download.hidden = true; if (!dialog.open) dialog.showModal(); fail(state, error); return; }
        if (active && dialog.open && active.fetchURL === info.url.href.split('#', 1)[0]) { active.url = info.url; fragmentTarget(active); return; }
        const previous = active;
        const trigger = previous?.trigger || options.trigger || document.activeElement;
        dispose(previous);
        const state = { ...info, name: options.name || info.name, sessionId: options.sessionId || info.sessionId, path: options.basePath || info.path, trigger, controller: new AbortController(), fetchURL: info.url.href.split('#', 1)[0] };
        active = state;
        title.textContent = state.name; body.replaceChildren(); toolbar.hidden = true; setStatus('Loading document…');
        const downloadURL = new URL(state.url); downloadURL.searchParams.set('download', '1'); downloadURL.hash = '';
        download.hidden = false; download.href = downloadURL.href; download.download = state.name;
        if (!dialog.open) dialog.showModal();
        dialog.querySelector('.document-preview-close').focus({ preventScroll: true });
        try {
            const meta = await metadata(state);
            if (!isCurrent(state)) return;
            state.size = meta.size;
            const filename = responseFilename(meta.disposition);
            if (filename) { state.name = filename; title.textContent = filename; download.download = filename; }
            state.extension = state.name.toLowerCase().match(/\.([a-z\d]+)$/)?.[1] || '';
            state.kind = meta.type === 'application/pdf' || state.extension === 'pdf' ? 'pdf'
                : meta.type.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(state.extension) ? 'image'
                    : meta.type === 'text/markdown' || /^(md|markdown|mdown)$/.test(state.extension) ? 'markdown' : 'text';
            body.dataset.kind = state.kind;
            if (state.kind === 'pdf') await showPDF(state);
            else if (state.kind === 'image') await showImage(state);
            else await showText(state);
        } catch (error) { if (error.name !== 'AbortError') fail(state, error); }
    }
    window.addEventListener('glad-theme-change', () => { if (active?.kind === 'text' && languages[active.extension] && window.hljs) void highlightStyle().catch(() => {}); });
    window.gladDocumentPreview = Object.freeze({ open, close });
})();
