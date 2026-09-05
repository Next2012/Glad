        const TILE_COLUMNS_KEY = 'glad-tile-columns';
        const TILE_ROWS_KEY = 'glad-tile-rows';

        const tiledWorkspace = {
            mode: 'normal',
            columns: Number(localStorage.getItem(TILE_COLUMNS_KEY)) || 2,
            rows: Number(localStorage.getItem(TILE_ROWS_KEY)) || 2,
            page: 0,
            sessions: [],
            previousSessionId: null,
            focusedSessionId: null,
            previewSockets: new Map(),
            previewStates: new Map(),
            renderFrames: new Map(),
            timedRenderTimer: null
        };

        function isTiledMode() {
            return tiledWorkspace.mode !== 'normal';
        }

        function tileCapacity() {
            return Math.max(1, tiledWorkspace.columns * tiledWorkspace.rows);
        }

        function visibleTiledSessions() {
            const start = tiledWorkspace.page * tileCapacity();
            return tiledWorkspace.sessions.slice(start, start + tileCapacity());
        }

        function clampTileLayout() {
            const maxColumns = Math.max(1, Math.min(4, Math.floor((window.innerWidth - 24) / 380)));
            const maxRows = Math.max(1, Math.min(3, Math.floor((window.innerHeight - 54) / 260)));
            tiledWorkspace.columns = Math.max(1, Math.min(maxColumns, tiledWorkspace.columns));
            tiledWorkspace.rows = Math.max(1, Math.min(maxRows, tiledWorkspace.rows));
            const columns = document.getElementById('tile-columns-range');
            const rows = document.getElementById('tile-rows-range');
            if (columns) {
                columns.max = String(maxColumns);
                columns.value = String(tiledWorkspace.columns);
            }
            if (rows) {
                rows.max = String(maxRows);
                rows.value = String(tiledWorkspace.rows);
            }
            document.getElementById('tile-columns-output').textContent = String(tiledWorkspace.columns);
            document.getElementById('tile-rows-output').textContent = String(tiledWorkspace.rows);
        }

        function tileStatusLabel(status) {
            const labels = {
                idle: 'Idle', thinking: 'Running', running: 'Running',
                waiting_approval: 'Waiting', error: 'Error'
            };
            return labels[status] || String(status || 'Idle');
        }

        function tilePendingPermissions(preview) {
            return (preview?.permissions || []).filter(item => item?.status === 'pending');
        }

        function createTilePreviewState(session) {
            return {
                sessionId: session.id,
                toolKey: session.toolKey,
                messages: [],
                permissions: [],
                timedInputs: [],
                timedInputsLoaded: false,
                timedInputsLoadedAt: 0,
                state: { status: session.status || 'idle' },
                status: session.status || 'idle',
                connected: false,
                hydrated: false,
                view: { scrollTop: 0, stickToBottom: true, openDetailKeys: [] }
            };
        }

        function tileConversationHtml(session, preview) {
            if (!preview || !preview.hydrated) {
                return '<div class="tile-loading-state">Connecting…</div>';
            }
            if (session.toolKey === 'claude-code') {
                return buildClaudeConversationHtml(preview.messages, preview.permissions, preview.status);
            }
            if (session.toolKey === 'codex') {
                return buildCodexConversationHtml(preview.messages, preview.permissions, preview.state);
            }
            return '<div class="tile-loading-state">Unsupported session</div>';
        }

        function renderTileConversation(sessionId) {
            if (!isTiledMode()) return;
            const session = tiledWorkspace.sessions.find(item => item.id === sessionId);
            const container = document.querySelector(`.tile-session-window[data-session-id="${CSS.escape(String(sessionId))}"] .tile-chat-surface`);
            if (!session || !container) return;
            const preview = tiledWorkspace.previewStates.get(sessionId);
            if (!preview) return;
            if (tilePendingPermissions(preview).length) preview.status = 'waiting_approval';
            if (container.firstElementChild) captureTileSurfaceState(container, preview);
            container.innerHTML = tileConversationHtml(session, preview);
            makeTileConversationReadOnly(container);
            restoreTileSurfaceState(container, preview);
            const badge = document.querySelector(`.tile-session-window[data-session-id="${CSS.escape(String(sessionId))}"] .tile-status`);
            if (badge && preview) {
                badge.dataset.status = preview.status || preview.state?.status || 'idle';
                badge.textContent = tileStatusLabel(badge.dataset.status);
            }
            const heading = container.closest('.tile-session-window')?.querySelector('.tile-session-title-row');
            const pending = tilePendingPermissions(preview);
            let alert = heading?.querySelector('.tile-approval-alert');
            if (!pending.length) alert?.remove();
            else if (heading) {
                if (!alert) {
                    alert = document.createElement('button');
                    alert.className = 'tile-approval-alert';
                    alert.type = 'button';
                    heading.insertBefore(alert, heading.querySelector('strong'));
                }
                alert.textContent = `! ${pending.length}`;
                alert.title = 'Open pending approval';
                alert.setAttribute('aria-label', `Open ${pending.length} pending approval${pending.length === 1 ? '' : 's'} in ${session.name}`);
                alert.onclick = () => openTileApprovalDialog(session.id, session.name, session.toolKey, String(pending[0].id));
            }
        }

        function makeTileConversationReadOnly(container) {
            if (!container) return;
            for (const element of container.querySelectorAll('button, a, input, select, textarea, summary, [contenteditable], [tabindex]')) {
                element.removeAttribute('onclick');
                element.tabIndex = -1;
                element.setAttribute('aria-disabled', 'true');
                if ('disabled' in element) element.disabled = true;
                if (element.tagName === 'A') element.removeAttribute('href');
                if (element.hasAttribute('contenteditable')) element.setAttribute('contenteditable', 'false');
            }
        }

        function setTiledWorkspaceObscured(obscured) {
            const workspace = document.getElementById('tile-workspace');
            const collapseButton = document.getElementById('lobby-collapse-button');
            if (workspace) {
                workspace.toggleAttribute('inert', Boolean(obscured));
                if (obscured) workspace.setAttribute('aria-hidden', 'true');
                else workspace.removeAttribute('aria-hidden');
            }
            collapseButton?.toggleAttribute('inert', Boolean(obscured));
        }

        function tileDetailKey(element) {
            return element?.getAttribute('data-codex-key') || element?.getAttribute('data-claude-key') || '';
        }

        function captureTileSurfaceState(container, preview) {
            if (!container || !preview) return;
            preview.view = {
                scrollTop: container.scrollTop,
                stickToBottom: container.scrollHeight - container.clientHeight - container.scrollTop <= 64,
                openDetailKeys: Array.from(container.querySelectorAll('details[open]')).map(tileDetailKey).filter(Boolean)
            };
        }

        function restoreTileSurfaceState(container, preview) {
            if (!container || !preview) return;
            const view = preview.view || {};
            const openKeys = new Set(view.openDetailKeys || []);
            for (const details of container.querySelectorAll('details')) {
                const key = tileDetailKey(details);
                if (key && openKeys.has(key)) details.open = true;
            }
            if (view.stickToBottom !== false) container.scrollTop = container.scrollHeight;
            else container.scrollTop = Math.min(Number(view.scrollTop) || 0, Math.max(0, container.scrollHeight - container.clientHeight));
        }

        function captureAllTileSurfaceStates() {
            for (const windowElement of document.querySelectorAll('.tile-session-window[data-session-id]')) {
                const preview = tiledWorkspace.previewStates.get(windowElement.dataset.sessionId);
                const container = windowElement.querySelector('.tile-chat-surface');
                if (preview && container) captureTileSurfaceState(container, preview);
            }
        }

        function scheduleTileConversationRender(sessionId) {
            if (tiledWorkspace.renderFrames.has(sessionId)) return;
            const frame = requestAnimationFrame(() => {
                tiledWorkspace.renderFrames.delete(sessionId);
                renderTileConversation(sessionId);
            });
            tiledWorkspace.renderFrames.set(sessionId, frame);
        }

        function tileTimedTagsHtml(preview) {
            const now = Date.now();
            return (preview?.timedInputs || [])
                .filter(item => item.sendAt > now || item.status === 'failed')
                .map(item => {
                    const failed = item.status === 'failed';
                    const title = failed ? `${item.text}\nFailed: ${item.error || 'Provider rejected the message'}` : item.text;
                    return `<span class="timed-tag${failed ? ' failed' : ''}" title="${escapeHtml(title || '')}">${failed ? 'Failed' : escapeHtml(formatCountdown(item.sendAt))}</span>`;
                }).join('');
        }

        function renderTileTimedTags(sessionId) {
            const container = document.querySelector(`.tile-session-window[data-session-id="${CSS.escape(String(sessionId))}"] .tile-timed-tags`);
            if (container) container.innerHTML = tileTimedTagsHtml(tiledWorkspace.previewStates.get(sessionId));
        }

        function renderAllTileTimedTags() {
            if (!isTiledMode()) return;
            for (const session of visibleTiledSessions()) renderTileTimedTags(session.id);
        }

        async function loadTileTimedInputs(session) {
            const preview = tiledWorkspace.previewStates.get(session.id);
            if (!preview || !(Number(session.timedInputCount) > 0)) return;
            if (preview.timedInputsLoaded && Date.now() - preview.timedInputsLoadedAt < 15000) return;
            preview.timedInputsLoaded = true;
            preview.timedInputsLoadedAt = Date.now();
            try {
                const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(session.id)}/timed-inputs`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                preview.timedInputs = data.items || [];
                renderTileTimedTags(session.id);
            } catch (_) {
                preview.timedInputsLoaded = false;
                preview.timedInputsLoadedAt = 0;
            }
        }

        function applyTileEvent(sessionId, event) {
            const preview = tiledWorkspace.previewStates.get(sessionId);
            if (!preview || !event) return;
            if (event.type === 'message' && event.message) preview.messages.push(event.message);
            else if (event.type === 'message-updated' && event.message) {
                const index = preview.messages.findIndex(item => item.id === event.message.id);
                if (index >= 0) preview.messages[index] = { ...preview.messages[index], ...event.message };
                else preview.messages.push(event.message);
            }
            else if (event.type === 'history-reset') preview.messages = event.messages || [];
            else if (event.type === 'permission-request' && event.request) {
                preview.permissions = [...preview.permissions.filter(item => item.id !== event.request.id), event.request];
            }
            else if (event.type === 'permission-updated' && event.request) {
                preview.permissions = preview.permissions.map(item => item.id === event.request.id ? event.request : item);
            }
            else if (event.type === 'status') preview.status = event.status || 'idle';
            if (event.state) preview.state = { ...preview.state, ...event.state };
            if (event.type === 'state' && event.state) preview.state = { ...preview.state, ...event.state };
            preview.status = event.state?.status || event.status || preview.state.status || preview.status;
            if (event.type === 'permission-request' || event.type === 'permission-updated') {
                const pending = tilePendingPermissions(preview).length;
                preview.state.pendingPermissionCount = pending;
                if (event.type === 'permission-request' && pending > 0) {
                    preview.state.status = 'waiting_approval';
                    preview.status = 'waiting_approval';
                } else if (pending === 0 && (preview.status === 'waiting_approval' || preview.state.status === 'waiting_approval')) {
                    preview.state.status = 'running';
                    preview.status = 'running';
                }
            }
            scheduleTileConversationRender(sessionId);
        }

        function connectTilePreview(session) {
            if (!isTiledMode() || tiledWorkspace.previewSockets.has(session.id)) return;
            const preview = tiledWorkspace.previewStates.get(session.id) || createTilePreviewState(session);
            tiledWorkspace.previewStates.set(session.id, preview);
            const socket = new WebSocket(sessionWebSocketUrl(session.id));
            tiledWorkspace.previewSockets.set(session.id, socket);
            socket.onmessage = message => {
                let payload;
                try { payload = JSON.parse(message.data); } catch (_) { return; }
                if ((payload.type === 'claude-snapshot' || payload.type === 'codex-snapshot') && payload.snapshot) {
                    applySessionName(session.id, payload.snapshot.name);
                    preview.messages = payload.snapshot.messages || [];
                    preview.permissions = payload.snapshot.pendingPermissions || [];
                    preview.state = payload.snapshot.state || { status: payload.snapshot.status || 'idle' };
                    preview.status = payload.snapshot.status || preview.state.status || 'idle';
                    preview.connected = true;
                    preview.hydrated = true;
                    scheduleTileConversationRender(session.id);
                }
                if ((payload.type === 'claude-event' || payload.type === 'codex-event') && payload.event) {
                    if (payload.event.type === 'session-renamed') applySessionName(session.id, payload.event.name);
                    applyTileEvent(session.id, payload.event);
                }
            };
            socket.onclose = () => {
                if (tiledWorkspace.previewSockets.get(session.id) !== socket) return;
                tiledWorkspace.previewSockets.delete(session.id);
                preview.connected = false;
                scheduleTileConversationRender(session.id);
                setTimeout(() => {
                    if (isTiledMode() && visibleTiledSessions().some(item => item.id === session.id)) {
                        connectTilePreview(session);
                    }
                }, 1500);
            };
        }

        function disconnectTilePreview(sessionId) {
            const socket = tiledWorkspace.previewSockets.get(sessionId);
            if (socket) socket.close();
            tiledWorkspace.previewSockets.delete(sessionId);
        }

        function syncVisibleTileConnections() {
            const visibleIds = new Set(visibleTiledSessions().map(session => session.id));
            for (const id of tiledWorkspace.previewSockets.keys()) {
                if (!visibleIds.has(id)) disconnectTilePreview(id);
            }
            for (const session of visibleTiledSessions()) {
                connectTilePreview(session);
                void loadTileTimedInputs(session);
            }
        }

        function renderTilePagination() {
            const pagination = document.getElementById('tile-pagination');
            const pages = Math.max(1, Math.ceil(tiledWorkspace.sessions.length / tileCapacity()));
            tiledWorkspace.page = Math.max(0, Math.min(pages - 1, tiledWorkspace.page));
            if (pages <= 1) {
                pagination.innerHTML = '';
                return;
            }
            pagination.innerHTML = `<button type="button" aria-label="Previous session page" onclick="changeTilePage(-1)"${tiledWorkspace.page === 0 ? ' disabled' : ''}>‹</button><span>${tiledWorkspace.page + 1} / ${pages}</span><button type="button" aria-label="Next session page" onclick="changeTilePage(1)"${tiledWorkspace.page === pages - 1 ? ' disabled' : ''}>›</button>`;
        }

        function renderTileGrid() {
            if (!isTiledMode()) return;
            clampTileLayout();
            const grid = document.getElementById('tile-grid');
            captureAllTileSurfaceStates();
            grid.style.setProperty('--tile-columns', String(tiledWorkspace.columns));
            grid.style.setProperty('--tile-rows', String(tiledWorkspace.rows));
            renderTilePagination();
            const sessions = visibleTiledSessions();
            if (!sessions.length) {
                grid.innerHTML = '<div class="tile-empty-state"><strong>No active sessions</strong><span>Restore the lobby to create a session.</span></div>';
                syncVisibleTileConnections();
                return;
            }
            grid.innerHTML = sessions.map(session => {
                const encodedId = encodePathValue(session.id);
                const encodedName = encodePathValue(session.name);
                const encodedTool = encodePathValue(session.toolKey || '');
                const preview = tiledWorkspace.previewStates.get(session.id) || createTilePreviewState(session);
                tiledWorkspace.previewStates.set(session.id, preview);
                const status = preview.status || preview.state?.status || session.status || 'idle';
                return `<article class="tile-session-window" data-session-id="${escapeHtml(session.id)}">
                    <header class="tile-session-header">
                        <div class="tile-session-heading">
                            <div class="tile-session-title-row"><span class="tile-status" data-status="${escapeHtml(status)}">${escapeHtml(tileStatusLabel(status))}</span><strong title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</strong></div>
                            <div class="tile-session-meta"><span class="tile-provider">${escapeHtml(session.tool || session.toolKey || '')}</span><span class="tile-session-path" title="${escapeHtml(session.workingDirectory || '')}">${escapeHtml(session.workingDirectory || '')}</span></div>
                        </div>
                        <div class="tile-session-actions">
                            ${renderServerChanSessionAction(session)}
                            <button class="btn-join tile-connect-button" type="button" onclick="openTileDialog(decodePathValue('${encodedId}'), decodePathValue('${encodedName}'), decodePathValue('${encodedTool}'))">Connect</button>
                            <button type="button" class="icon-btn btn-delete tile-delete-button" title="Delete session" aria-label="Delete ${escapeHtml(session.name)} session" onclick="deleteSession(decodePathValue('${encodedId}'), event)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </div>
                    </header>
                    <div class="tile-timed-tags">${tileTimedTagsHtml(preview)}</div>
                    <div class="tile-chat-surface"></div>
                </article>`;
            }).join('');
            syncVisibleTileConnections();
            for (const session of sessions) scheduleTileConversationRender(session.id);
        }

        async function loadTiledSessions() {
            try {
                const response = await fetchWithTimeout('/api/sessions');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                refreshTiledSessionsFromList(await response.json());
            } catch (error) {
                document.getElementById('tile-grid').innerHTML = `<div class="tile-empty-state"><strong>Unable to load sessions</strong><span>${escapeHtml(error.message)}</span></div>`;
            }
        }

        function refreshTiledSessionsFromList(sessions) {
            if (!Array.isArray(sessions)) return;
            const previousCounts = new Map(tiledWorkspace.sessions.map(session => [session.id, Number(session.timedInputCount) || 0]));
            tiledWorkspace.sessions = sessions;
            const liveIds = new Set(sessions.map(session => session.id));
            for (const id of tiledWorkspace.previewSockets.keys()) if (!liveIds.has(id)) disconnectTilePreview(id);
            for (const id of tiledWorkspace.previewStates.keys()) if (!liveIds.has(id)) tiledWorkspace.previewStates.delete(id);
            for (const session of sessions) {
                const preview = tiledWorkspace.previewStates.get(session.id);
                if (!preview) continue;
                const count = Number(session.timedInputCount) || 0;
                if (previousCounts.get(session.id) !== count) {
                    preview.timedInputsLoaded = false;
                    preview.timedInputsLoadedAt = 0;
                }
                if (!count) preview.timedInputs = [];
            }
            if (isTiledMode()) renderTileGrid();
        }

        function enterTiledMode() {
            if (!isSplitLayout()) return;
            tiledWorkspace.previousSessionId = activeSessionId || tiledWorkspace.previousSessionId;
            tiledWorkspace.focusedSessionId = null;
            syncActiveSessionToTilePreview();
            tiledWorkspace.mode = 'tiled';
            if (currentSocket) { currentSocket.close(); currentSocket = null; }
            stopTimedInputTimers();
            activeSessionId = null;
            window.activeSessionId = null;
            document.body.classList.add('tile-mode');
            document.body.classList.remove('tile-focus-open');
            setTiledWorkspaceObscured(false);
            syncLobbyCollapseButton();
            document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
            document.getElementById('tile-workspace').classList.add('active');
            clearInterval(tiledWorkspace.timedRenderTimer);
            tiledWorkspace.timedRenderTimer = setInterval(renderAllTileTimedTags, 1000);
            loadTiledSessions();
            scheduleSessionPolling();
        }

        function exitTiledMode() {
            if (!isTiledMode()) return;
            const restore = tiledWorkspace.sessions.find(session => session.id === tiledWorkspace.focusedSessionId)
                || tiledWorkspace.sessions.find(session => session.id === tiledWorkspace.previousSessionId);
            returnToTiles({ refresh: false });
            tiledWorkspace.mode = 'normal';
            tiledWorkspace.focusedSessionId = null;
            document.body.classList.remove('tile-mode', 'tile-focus-open');
            setTiledWorkspaceObscured(false);
            syncLobbyCollapseButton();
            for (const id of Array.from(tiledWorkspace.previewSockets.keys())) disconnectTilePreview(id);
            clearInterval(tiledWorkspace.timedRenderTimer);
            tiledWorkspace.timedRenderTimer = null;
            setTileLayoutMenuOpen(false);
            if (restore) joinSession(restore.id, restore.name, restore.toolKey);
            else showLobby();
        }

        function openTileDialog(id, name, toolKey) {
            if (!isTiledMode()) return;
            tiledWorkspace.focusedSessionId = id;
            tiledWorkspace.mode = 'focused';
            document.body.classList.add('tile-focus-open');
            setTileLayoutMenuOpen(false);
            joinSession(id, name, toolKey);
            requestAnimationFrame(() => {
                resetTileDialogPosition();
                syncTileReturnButton();
                document.getElementById('cmd-input')?.focus();
            });
        }

        function openTileApprovalDialog(id, name, toolKey, permissionId) {
            openTileDialog(id, name, toolKey);
            const deadline = Date.now() + 5000;
            const focusWhenReady = () => {
                if (tiledWorkspace.focusedSessionId !== id || !document.body.classList.contains('tile-focus-open')) return;
                if (activeSessionId === id && activeSessionHydrated) {
                    if (toolKey === 'claude-code') {
                        requestAnimationFrame(() => {
                            if (activeSessionId === id) focusClaudeApproval(permissionId);
                        });
                    } else {
                        const request = codexPendingPermissions.find(item => String(item.id) === permissionId && item.status === 'pending');
                        if (request) void loadAndFocusCodexApproval(request);
                    }
                    return;
                }
                if (Date.now() < deadline) setTimeout(focusWhenReady, 50);
            };
            setTimeout(focusWhenReady, 0);
        }

        function toggleTiledMode() {
            if (isTiledMode()) exitTiledMode();
            else enterTiledMode();
        }

        function syncLobbyCollapseButton() {
            const button = document.getElementById('lobby-collapse-button');
            if (!button) return;
            const tiled = isTiledMode();
            const title = tiled ? 'Restore lobby' : 'Collapse lobby and tile sessions';
            button.title = title;
            button.setAttribute('aria-label', title);
            button.querySelector('use')?.setAttribute('href', tiled ? '#icon-chevron-right' : '#icon-chevron-left');
        }

        function returnToTiles(options = {}) {
            if (!isTiledMode()) return;
            syncActiveSessionToTilePreview();
            if (currentSocket) { currentSocket.close(); currentSocket = null; }
            closeTimedSendPanel();
            stopTimedInputTimers();
            if (typeof resetComposerSendState === 'function') resetComposerSendState();
            tiledWorkspace.mode = 'tiled';
            activeSessionId = null;
            window.activeSessionId = null;
            activeToolKey = null;
            document.body.classList.remove('tile-focus-open');
            setTiledWorkspaceObscured(false);
            for (const id of ['terminal-view', 'history-view', 'git-view']) document.getElementById(id)?.classList.remove('active', 'tile-dialog-positioned');
            document.getElementById('tile-workspace').classList.add('active');
            renderTileGrid();
            if (options.refresh !== false) {
                void loadTiledSessions();
                scheduleSessionPolling();
            }
        }

        function syncActiveSessionToTilePreview() {
            if (!activeSessionId || !activeToolKey || !activeSessionHydrated) return;
            const session = tiledWorkspace.sessions.find(item => item.id === activeSessionId) || {
                id: activeSessionId,
                toolKey: activeToolKey,
                status: activeToolKey === 'codex' ? codexState.status : claudeStatus
            };
            const preview = tiledWorkspace.previewStates.get(activeSessionId) || createTilePreviewState(session);
            if (activeToolKey === 'codex') {
                preview.messages = codexMessages.map(item => ({ ...item }));
                preview.permissions = codexPendingPermissions.map(item => ({ ...item }));
                preview.state = { ...codexState };
                preview.status = codexState.status || preview.status;
            } else if (activeToolKey === 'claude-code') {
                preview.messages = claudeMessages.map(item => ({ ...item }));
                preview.permissions = claudePendingPermissions.map(item => ({ ...item }));
                preview.state = { ...claudeState };
                preview.status = claudeStatus || claudeState.status || preview.status;
            } else return;
            preview.hydrated = true;
            tiledWorkspace.previewStates.set(activeSessionId, preview);
        }

        function prepareTiledDialogView(viewId) {
            document.querySelectorAll('#detail-pane > .view').forEach(view => {
                if (view.id !== 'tile-workspace') view.classList.remove('active', 'tile-dialog-positioned');
            });
            document.getElementById('tile-workspace').classList.add('active');
            document.getElementById(viewId).classList.add('active');
            document.body.classList.add('tile-focus-open');
            setTiledWorkspaceObscured(true);
            requestAnimationFrame(syncTileReturnButton);
        }

        function setTileColumns(value) {
            tiledWorkspace.columns = Math.max(1, Number(value) || 1);
            tiledWorkspace.page = 0;
            localStorage.setItem(TILE_COLUMNS_KEY, String(tiledWorkspace.columns));
            renderTileGrid();
        }

        function setTileRows(value) {
            tiledWorkspace.rows = Math.max(1, Number(value) || 1);
            tiledWorkspace.page = 0;
            localStorage.setItem(TILE_ROWS_KEY, String(tiledWorkspace.rows));
            renderTileGrid();
        }

        function changeTilePage(delta) {
            tiledWorkspace.page += Number(delta) || 0;
            renderTileGrid();
        }

        function toggleTileLayoutMenu(event) {
            event?.stopPropagation();
            const menu = document.getElementById('tile-layout-popover');
            setTileLayoutMenuOpen(!menu.classList.contains('active'));
        }

        function setTileLayoutMenuOpen(active) {
            const menu = document.getElementById('tile-layout-popover');
            const button = document.getElementById('tile-layout-trigger');
            menu?.classList.toggle('active', Boolean(active));
            button?.setAttribute('aria-expanded', String(Boolean(active)));
            button?.querySelector('use')?.setAttribute('href', active ? '#icon-chevron-up' : '#icon-chevron-down');
        }

        function activeTileDialogView() {
            return ['terminal-view', 'history-view', 'git-view']
                .map(id => document.getElementById(id))
                .find(view => view?.classList.contains('active')) || null;
        }

        function resetTileDialogPosition() {
            const view = activeTileDialogView();
            if (!view) return;
            view.classList.remove('tile-dialog-positioned');
            view.style.removeProperty('left');
            view.style.removeProperty('top');
        }

        function syncTileReturnButton() {
            if (!document.body.classList.contains('tile-focus-open')) return;
            const view = activeTileDialogView();
            const button = document.getElementById('tile-return-button');
            if (!view || !button) return;
            const bounds = view.getBoundingClientRect();
            button.style.left = `${bounds.left + 10}px`;
            button.style.top = `${bounds.top + 8}px`;
        }

        function installTileDialogDragging() {
            const headers = [document.getElementById('nav-bar'), ...document.querySelectorAll('.subview-nav-row')];
            for (const header of headers) {
                if (!header || header.dataset.tileDrag === 'true') continue;
                header.dataset.tileDrag = 'true';
                header.addEventListener('pointerdown', event => {
                    if (!document.body.classList.contains('tile-focus-open') || event.button !== 0 || event.target.closest('button')) return;
                    const view = activeTileDialogView();
                    if (!view) return;
                    const bounds = view.getBoundingClientRect();
                    const offsetX = event.clientX - bounds.left;
                    const offsetY = event.clientY - bounds.top;
                    view.classList.add('tile-dialog-positioned');
                    view.style.left = `${bounds.left}px`;
                    view.style.top = `${bounds.top}px`;
                    header.setPointerCapture?.(event.pointerId);
                    const move = moveEvent => {
                        const width = view.offsetWidth;
                        const height = view.offsetHeight;
                        const left = Math.max(0, Math.min(window.innerWidth - width, moveEvent.clientX - offsetX));
                        const top = Math.max(0, Math.min(window.innerHeight - height, moveEvent.clientY - offsetY));
                        view.style.left = `${left}px`;
                        view.style.top = `${top}px`;
                        syncTileReturnButton();
                    };
                    const stop = () => {
                        header.removeEventListener('pointermove', move);
                        header.removeEventListener('pointerup', stop);
                        header.removeEventListener('pointercancel', stop);
                    };
                    header.addEventListener('pointermove', move);
                    header.addEventListener('pointerup', stop);
                    header.addEventListener('pointercancel', stop);
                    event.preventDefault();
                });
                header.addEventListener('dblclick', event => {
                    if (!document.body.classList.contains('tile-focus-open') || event.target.closest('button')) return;
                    resetTileDialogPosition();
                    requestAnimationFrame(syncTileReturnButton);
                });
            }
        }

        document.addEventListener('click', event => {
            if (!event.target.closest('#tile-layout-popover, #tile-layout-trigger')) {
                setTileLayoutMenuOpen(false);
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && document.body.classList.contains('tile-focus-open')) {
                event.preventDefault();
                returnToTiles();
            }
        });

        const tiledLayoutMedia = window.matchMedia(window.gladLayout?.splitQuery || '(min-width: 920px)');
        tiledLayoutMedia.addEventListener('change', event => {
            if (!event.matches && isTiledMode()) exitTiledMode();
        });

        window.addEventListener('resize', () => {
            if (isTiledMode()) renderTileGrid();
            if (document.body.classList.contains('tile-focus-open')) {
                resetTileDialogPosition();
                requestAnimationFrame(syncTileReturnButton);
            }
        });

        document.addEventListener('DOMContentLoaded', () => {
            clampTileLayout();
            syncLobbyCollapseButton();
            installTileDialogDragging();
        });

        window.gladWorkspace = {
            isTiledMode,
            prepareTiledDialogView,
            refreshTiledSessionsFromList
        };
