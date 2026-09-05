        function joinSession(id, sessionName, toolKey = null) {
            if (id !== activeSessionId && typeof composerSendInFlight === 'function' && composerSendInFlight()) {
                alert('Wait for the current message to be accepted before switching sessions.');
                return;
            }
            if (typeof clearComposerAttachments === 'function' && (selectedImageAttachments.length || selectedFileAttachments.length)) {
                void clearComposerAttachments();
            }
            stopTimedInputTimers();
            activeSessionId = id;
            window.activeSessionId = id;
            activeToolKey = toolKey;
            if (typeof resetComposerSendState === 'function') resetComposerSendState();
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            markCompletionRead(id);
            loadTimedInputs();
            document.getElementById('session-title').innerText = sessionName;
            updateToolShortcuts(activeToolKey);
            if (window.gladWorkspace?.isTiledMode()) {
                window.gladWorkspace.prepareTiledDialogView('terminal-view');
            } else {
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('terminal-view').classList.add('active');
            }
            setClaudeModeEnabled(isClaudeSession());
            if (currentSocket) { currentSocket.close(); currentSocket = null; }
            initTerminal(id);
            if (typeof isSplitLayout === 'function' && isSplitLayout()) refreshSessionsNow();
        }

        function sessionWebSocketUrl(sessionId) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const query = new URLSearchParams({ sessionId: String(sessionId) });
            return `${protocol}//${window.location.host}/ws?${query}`;
        }

        function initTerminal(sessionId) {
            if (isClaudeSession()) {
                initClaudeSession(sessionId);
                return;
            }
            if (isCodexSession()) {
                initCodexSession(sessionId);
                return;
            }
            if (typeof Terminal === 'undefined') {
                alert('Terminal library not loaded yet.');
                showLobby();
                return;
            }
            function isTerminalAutoResponse(data) {
                return /^\x1b\[\?[\d;]*c$/.test(data) || /^\x1b\[>[\d;]*c$/.test(data);
            }
            if (!term) {
                term = new Terminal({ theme: typeof getGladTerminalTheme === 'function' ? getGladTerminalTheme() : { background: '#000', foreground: '#fff', cursor: '#0f0' }, cursorBlink: true, fontSize: 14, cursorStyle: 'bar', scrollback: 10000 });
                fitAddon = new FitAddon.FitAddon();
                term.loadAddon(fitAddon);
                term.open(document.getElementById('terminal'));
                term.onData(data => {
                    if (isTerminalAutoResponse(data)) return;
                    let finalData = data;
                    if (modifiers.ctrl && data.length === 1) {
                        const code = data.toLowerCase().charCodeAt(0);
                        if (code >= 97 && code <= 122) finalData = String.fromCharCode(code - 96);
                    }
                    sendWS(finalData);
                });
            } else { term.clear(); }
            currentSocket = new WebSocket(sessionWebSocketUrl(sessionId));
            currentSocket.onopen = () => {
                syncLayout();
                setTimeout(() => logViewSnapshot('ws-open'), 300);
            };
            currentSocket.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'output') term.write(msg.data);
                if (msg.type === 'reset') term.reset();
                if (msg.type === 'exit') showLobby();
            };
        }

        async function initClaudeSession(sessionId) {
            activeSessionHydrated = false;
            claudeMessages = [];
            claudePendingPermissions = [];
            claudeStatus = 'idle';
            const runtimeConfig = await refreshClaudeRuntimeConfig();
            claudeState = {
                permissionMode: 'default',
                model: (runtimeConfig && runtimeConfig.defaultModel) || 'default',
                effort: (runtimeConfig && runtimeConfig.defaultEffort) || 'medium',
                claudeSessionId: null,
                resumeSessionId: null,
                canAbort: false,
                pendingPermissionCount: 0
            };
            claudeResumePanelOpen = false;
            claudeForkPanelOpen = false;
            claudePickerOpen = null;
            claudeUsagePending = false;
            claudeContextPending = false;
            claudeResumeItemsLoaded = false;
            document.getElementById('claude-resume-panel').classList.remove('active');
            document.getElementById('claude-resume-panel').innerHTML = '';
            document.getElementById('claude-fork-panel').classList.remove('active');
            document.getElementById('claude-fork-panel').innerHTML = '';
            closeClaudePicker();
            updateTerminalControlsHeight();
            applyClaudeRuntimeConfig(runtimeConfig);
            applyClaudeState(claudeState);
            renderClaudeChat();
            currentSocket = new WebSocket(sessionWebSocketUrl(sessionId));
            const socket = currentSocket;
            socket.onopen = () => {
                handleComposerSocketOpen();
                logViewSnapshot('claude-ws-open');
            };
            socket.onclose = () => {
                if (currentSocket === socket) handleComposerSocketClose();
            };
            socket.onerror = () => {
                if (currentSocket === socket) syncComposerSendState();
            };
            socket.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'send-result') handleComposerSendResult(msg);
                if (msg.type === 'claude-snapshot' && msg.snapshot) {
                    claudeMessages = msg.snapshot.messages || [];
                    claudePendingPermissions = msg.snapshot.pendingPermissions || [];
                    claudeStatus = msg.snapshot.status || 'idle';
                    applyClaudeState(msg.snapshot.state || {
                        status: claudeStatus,
                        pendingPermissionCount: claudePendingPermissions.filter(item => item.status === 'pending').length,
                        canAbort: claudeStatus === 'thinking'
                    }, { providerStateReceived: true });
                    activeSessionHydrated = true;
                    renderClaudeChat();
                }
                if (msg.type === 'claude-event') applyClaudeEvent(msg.event);
                if (msg.type === 'exit') showLobby();
            };
        }

        function initCodexSession(sessionId) {
            activeSessionHydrated = false;
            codexMessages = [];
            codexPendingPermissions = [];
            codexModelPanelOpen = false;
            codexModelCandidate = null;
            codexResumePanelOpen = false;
            codexForkPanelOpen = false;
            codexPromptPanelOpen = false;
            codexPromptItems = [];
            codexPromptNextOffset = 0;
            codexPromptHasMore = false;
            codexPromptTotal = 0;
            codexPromptLoading = false;
            codexExpandedPrompts = new Set();
            codexSkillPanelOpen = false;
            codexSkillItems = [];
            codexSkillLoading = false;
            codexSkillQuery = '';
            codexSkillError = '';
            selectedCodexSkill = null;
            codexDetailRequestSeq = 0;
            codexDetailRequests = new Map();
            codexDetailRevisions = new Map();
            clearTimeout(codexDetailRefreshTimer);
            codexDetailRefreshTimer = null;
            codexDetailRefreshIds = new Set();
            codexStatusPending = false;
            document.getElementById('codex-model-panel').classList.remove('active');
            document.getElementById('codex-resume-panel').classList.remove('active');
            document.getElementById('codex-fork-panel').classList.remove('active');
            document.getElementById('codex-prompt-panel').classList.remove('active');
            document.getElementById('codex-skill-panel').classList.remove('active');
            document.getElementById('codex-control-rail').scrollLeft = 0;
            codexState = createDefaultCodexState();
            setClaudeModeEnabled(false);
            applyCodexState(codexState);
            installCodexLazyDetailHandler();
            currentSocket = new WebSocket(sessionWebSocketUrl(sessionId));
            const socket = currentSocket;
            socket.onopen = () => {
                handleComposerSocketOpen();
                flushPendingCodexStatus(socket);
            };
            socket.onclose = () => {
                if (currentSocket === socket) handleComposerSocketClose();
            };
            socket.onerror = () => {
                if (currentSocket === socket) syncComposerSendState();
            };
            socket.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'send-result') handleComposerSendResult(msg);
                if (msg.type === 'codex-snapshot' && msg.snapshot) {
                    codexMessages = msg.snapshot.messages || [];
                    codexPendingPermissions = msg.snapshot.pendingPermissions || [];
                    applyCodexState(msg.snapshot.state || {}, { providerStateReceived: true });
                    activeSessionHydrated = true;
                }
                if (msg.type === 'codex-detail-response' && msg.detail) applyCodexDetailResponse(msg);
                if (msg.type === 'codex-event') applyCodexEvent(msg.event);
                if (msg.type === 'exit') showLobby();
            };
        }

        function sendWS(data) {
            if (currentSocket && currentSocket.readyState === 1) currentSocket.send(JSON.stringify({ type: 'input', data }));
        }

        let layoutTimer = null;
        let layoutKeepAtBottom = false;

        function isTerminalAtBottom() {
            if (!term || !term.buffer || !term.buffer.active) return true;
            const active = term.buffer.active;
            return active.viewportY >= active.baseY - 1;
        }

        function scrollTerminalViewportToBottom() {
            if (!term) return;
            term.scrollToBottom();
            const viewport = document.querySelector('#terminal .xterm-viewport');
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
        }

        function restoreTerminalBottomSoon() {
            scrollTerminalViewportToBottom();
            requestAnimationFrame(() => {
                scrollTerminalViewportToBottom();
                requestAnimationFrame(scrollTerminalViewportToBottom);
            });
            setTimeout(scrollTerminalViewportToBottom, 120);
        }

        function syncLayout(options = {}) {
            if (!fitAddon || !currentSocket) return;
            const keepAtBottom = typeof options.keepAtBottom === 'boolean' ? options.keepAtBottom : isTerminalAtBottom();
            layoutKeepAtBottom = layoutKeepAtBottom || keepAtBottom;
            clearTimeout(layoutTimer);
            layoutTimer = setTimeout(() => {
                const shouldRestoreBottom = layoutKeepAtBottom;
                layoutKeepAtBottom = false;
                fitAddon.fit();
                if (shouldRestoreBottom) restoreTerminalBottomSoon();
                if (currentSocket.readyState === 1) currentSocket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }, 50);
        }

        function previewText(text, maxChars = 320) {
            if (!text) return '';
            const normalized = String(text)
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
                .replace(/\t/g, '\\t')
                .replace(/\x1b/g, '\\x1b');
            return normalized.length > maxChars ? normalized.slice(-maxChars) : normalized;
        }

        async function logClientDebug(event, payload) {
            try {
                await fetch('/api/debug/client-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: activeSessionId, event, payload })
                });
            } catch (_) {}
        }

        function snapshotTerminalBuffer(maxLines = 12) {
            if (!term || !term.buffer || !term.buffer.active) return null;
            const active = term.buffer.active;
            const totalLines = active.length || 0;
            const start = Math.max(0, totalLines - maxLines);
            const tailLines = [];
            for (let i = start; i < totalLines; i++) {
                const line = active.getLine(i);
                if (!line) continue;
                tailLines.push(line.translateToString(true));
            }
            return {
                cols: term.cols,
                rows: term.rows,
                baseY: active.baseY,
                viewportY: active.viewportY,
                cursorX: active.cursorX,
                cursorY: active.cursorY,
                totalLines,
                tailPreview: previewText(tailLines.join('\n'))
            };
        }

        function logViewSnapshot(event) {
            logClientDebug(event, {
                sessionId: activeSessionId,
                terminalSnapshot: snapshotTerminalBuffer()
            });
        }

        // Navigation
        function showTerminal() {
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            if (window.gladWorkspace?.isTiledMode()) window.gladWorkspace.prepareTiledDialogView('terminal-view');
            else {
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('terminal-view').classList.add('active');
            }
            logViewSnapshot('show-terminal');
            syncLayout();
        }

        function showGitPreview() {
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            if (window.gladWorkspace?.isTiledMode()) window.gladWorkspace.prepareTiledDialogView('git-view');
            else {
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('git-view').classList.add('active');
            }
            switchGitTab('changes');
        }

        let historyWrapEnabled = true;

        function showHistory() {
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            if (window.gladWorkspace?.isTiledMode()) window.gladWorkspace.prepareTiledDialogView('history-view');
            else {
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('history-view').classList.add('active');
            }
            logViewSnapshot('show-history-before-load');
            loadHistory();
        }

        function toggleHistoryWrap() {
            historyWrapEnabled = !historyWrapEnabled;
            const contentEl = document.getElementById('history-content');
            contentEl.classList.toggle('nowrap', !historyWrapEnabled);
            document.getElementById('history-wrap-btn').style.color = historyWrapEnabled ? 'var(--primary)' : 'var(--text-dim)';
        }

        async function loadHistory() {
            const contentEl = document.getElementById('history-content');
            const metaEl = document.getElementById('history-meta');
            if (!activeSessionId) {
                metaEl.textContent = 'No active session.';
                contentEl.textContent = '';
                return;
            }

            metaEl.textContent = 'Loading...';
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/history`, {}, 30000);
                const data = await res.json();
                if (!data.success) throw new Error(data.error || 'Failed to load history');

                const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : 'unknown';
                const size = typeof data.bytes === 'number' ? `${Math.round(data.bytes / 1024)} KB` : 'unknown size';
                const truncated = data.truncated ? ' | truncated' : '';
                metaEl.textContent = `${data.tool || 'Session'} | ${data.lines || 0} lines | ${size} | updated ${updatedAt}${truncated}`;
                contentEl.textContent = data.text || 'No readable history yet.';
                contentEl.classList.toggle('nowrap', !historyWrapEnabled);
                document.getElementById('history-wrap-btn').style.color = historyWrapEnabled ? 'var(--primary)' : 'var(--text-dim)';
                logClientDebug('history-loaded', {
                    meta: metaEl.textContent,
                    historyLines: data.lines || 0,
                    historyBytes: data.bytes || 0,
                    historyTail: previewText(data.text || '')
                });
                requestAnimationFrame(() => {
                    contentEl.scrollTop = contentEl.scrollHeight;
                });
            } catch (e) {
                metaEl.textContent = 'Failed to load history.';
                contentEl.textContent = e.message;
                logClientDebug('history-load-failed', { message: e.message });
            }
        }

        async function copyHistoryContent() {
            const contentEl = document.getElementById('history-content');
            const text = contentEl.textContent || '';
            if (!text || text === 'Loading...' || text === 'No readable history yet.') {
                alert('No history to copy.');
                return;
            }

            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const range = document.createRange();
                    range.selectNode(contentEl);
                    window.getSelection().removeAllRanges();
                    window.getSelection().addRange(range);
                    document.execCommand('copy');
                    window.getSelection().removeAllRanges();
                }
                alert('History copied.');
            } catch (e) {
                alert('Copy failed. You can select the history text manually.');
            }
        }
