        let currentSocket = null, term = null, fitAddon = null, activeSessionId = null, activeToolKey = null;
        let appConfig = null;
        let sessionPollTimer = null;
        let lobbyTab = 'sessions';
        let scheduleTools = [];
        let editingScheduleId = null;
        let editingSteps = [];
        let selectedWeekdays = [1, 2, 3, 4, 5];
        let timedSendRefreshTimer = null;
        let timedTagTimer = null;
        let editingTimedInputId = null;
        let claudeMessages = [];
        let claudePendingPermissions = [];
        let claudeStatus = 'idle';
        let claudeRuntimeConfig = null;
        let claudePickerOpen = null;
        let claudeUsagePending = false;
        let claudeContextPending = false;
        let claudeState = {
            permissionMode: 'default',
            model: 'default',
            effort: 'medium',
            claudeSessionId: null,
            resumeSessionId: null,
            canAbort: false,
            pendingPermissionCount: 0
        };
        let claudeResumePanelOpen = false;
        let claudeForkPanelOpen = false;
        let claudeResumeItemsLoaded = false;
        let claudeRenderFrame = null;
        let claudeApprovalJumpIndex = 0;
        let codexMessages = [];
        let codexPendingPermissions = [];
        let codexState = { permissionMode: 'default', sandboxMode: 'default', effectivePermissionMode: null, effectiveSandboxMode: null, model: null, effort: null, status: 'idle', threadId: null, presentation: 'structured', models: [], canAbort: false, canCompact: false, compacting: false, canSwitchToTerminal: false, canSwitchToStructured: false };
        let codexModelPanelOpen = false;
        let codexModelCandidate = null;
        let codexResumePanelOpen = false;
        let codexForkPanelOpen = false;
        let codexPromptPanelOpen = false;
        let codexPromptItems = [];
        let codexPromptNextOffset = 0;
        let codexPromptHasMore = false;
        let codexPromptTotal = 0;
        let codexPromptLoading = false;
        let codexExpandedPrompts = new Set();
        let codexSkillPanelOpen = false;
        let codexSkillItems = [];
        let codexSkillLoading = false;
        let selectedCodexSkill = null;
        let codexRenderFrame = null;
        let codexApprovalJumpIndex = 0;
        const modifiers = { ctrl: false };

        function log(msg) {
            const el = document.getElementById('debug-log');
            const entry = document.createElement('div');
            entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            el.appendChild(entry);
            console.log(msg);
        }

        async function fetchWithTimeout(url, options = {}, timeout = 5000) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(id);
                return response;
            } catch (e) {
                clearTimeout(id);
                if (e && e.name === 'AbortError') {
                    throw new Error(`Request timed out after ${Math.round(timeout / 1000)}s`);
                }
                throw e;
            }
        }

        function escapeHtml(value = '') {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function encodePathValue(path = '') {
            return encodeURIComponent(path).replace(/'/g, '%27');
        }

        function decodePathValue(path = '') {
            return decodeURIComponent(path);
        }

        async function copyTextToClipboard(text) {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return;
            }
            const el = document.createElement('textarea');
            el.value = text;
            el.setAttribute('readonly', '');
            el.style.position = 'fixed';
            el.style.opacity = '0';
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        }

        async function copySessionDirectory(directory, event) {
            event.stopPropagation();
            const btn = event.currentTarget;
            try {
                await copyTextToClipboard(directory);
                const oldTitle = btn.title;
                btn.title = 'Copied';
                btn.style.color = '#fff';
                setTimeout(() => {
                    btn.title = oldTitle || 'Copy directory';
                    btn.style.color = '';
                }, 1200);
            } catch (e) {
                alert('Copy failed');
            }
        }

        function formatWeekdays(days = []) {
            const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            return days.map(day => labels[day]).filter(Boolean).join(', ') || 'No days';
        }

        function formatDateTime(value) {
            return value ? new Date(value).toLocaleString() : 'Not scheduled';
        }

        function switchLobbyTab(tab) {
            lobbyTab = tab;
            document.getElementById('lobby-tab-sessions').classList.toggle('active', tab === 'sessions');
            document.getElementById('lobby-tab-schedules').classList.toggle('active', tab === 'schedules');
            document.getElementById('sessions-list').style.display = tab === 'sessions' ? '' : 'none';
            document.getElementById('schedules-list').style.display = tab === 'schedules' ? '' : 'none';
            if (tab === 'sessions') refreshSessionsNow();
            if (tab === 'schedules') loadSchedules();
        }

        async function loadSchedules() {
            const list = document.getElementById('schedules-list');
            list.innerHTML = '<p style="color:#888; text-align:center; margin-top:50px;">Loading schedules...</p>';
            try {
                await ensureScheduleTools().catch(() => {});
                const res = await fetchWithTimeout('/api/schedules');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const schedules = await res.json();
                if (!schedules.length) {
                    list.innerHTML = '<p style="color:#888; text-align:center; margin-top:50px;">No scheduled tasks</p>';
                    return;
                }

                let html = '';
                schedules.forEach(job => {
                    const encodedId = encodePathValue(job.id);
                    const tool = scheduleTools.find(t => t.key === job.target.toolKey);
                    const statusColor = job.lastRunStatus === 'failed' ? '#ff6b61' : job.running ? '#5ac8fa' : 'var(--text-dim)';
                    html += `<div class="schedule-card">
                        <div class="schedule-row">
                            <div style="flex:1; min-width:0;">
                                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                    <strong>${escapeHtml(job.name)}</strong>
                                    <span style="font-size:11px; color:${job.enabled ? '#34c759' : '#8e8e93'}; border:1px solid currentColor; border-radius:10px; padding:1px 7px;">${job.enabled ? 'ON' : 'OFF'}</span>
                                </div>
                                <div class="schedule-meta">
                                    ${escapeHtml(job.schedule.time)} | ${escapeHtml(formatWeekdays(job.schedule.weekdays))}<br>
                                    ${escapeHtml(tool ? tool.displayName : job.target.toolKey)} | ${escapeHtml(job.target.workingDirectory || 'Default directory')}<br>
                                    Next: ${escapeHtml(formatDateTime(job.nextRunAt))}<br>
                                    <span style="color:${statusColor};">Last: ${escapeHtml(job.lastRunStatus || 'idle')}${job.lastRunMessage ? ' - ' + escapeHtml(job.lastRunMessage) : ''}</span>
                                </div>
                            </div>
                            <div class="schedule-actions">
                                <button class="small-btn primary" onclick="simulateSchedule(decodePathValue('${encodedId}'))">Test</button>
                                <button class="small-btn" onclick="editSchedule(decodePathValue('${encodedId}'))">Edit</button>
                                <button class="small-btn" onclick="duplicateSchedule(decodePathValue('${encodedId}'))">Copy</button>
                                <button class="small-btn" onclick="toggleSchedule(decodePathValue('${encodedId}'), ${job.enabled ? 'false' : 'true'})">${job.enabled ? 'Disable' : 'Enable'}</button>
                                <button class="small-btn danger" onclick="deleteSchedule(decodePathValue('${encodedId}'))">Delete</button>
                            </div>
                        </div>
                    </div>`;
                });
                list.innerHTML = html;
            } catch (e) {
                list.innerHTML = `<div style="color:#ff3b30; text-align:center; margin-top:50px;"><p>Failed to load: ${escapeHtml(e.message)}</p><button class="btn-retry" onclick="loadSchedules()">Retry</button></div>`;
            }
        }

        async function loadSessions() {
            log('Loading sessions...');
            const list = document.getElementById('sessions-list');
            try {
                const res = await fetchWithTimeout('/api/sessions');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const sessions = await res.json();
                if (!sessions || sessions.length === 0) {
                    list.innerHTML = '<p style="color:#888; text-align:center; margin-top:50px;">No active sessions</p>';
                    return;
                }

                let html = '';
                sessions.forEach(s => {
                    const workingDirectory = s.workingDirectory || 'Unknown directory';
                    const encodedName = encodePathValue(s.name);
                    const encodedDir = encodePathValue(workingDirectory);
                    const timedInputCount = Number(s.timedInputCount) || 0;
                    const timerBadge = timedInputCount > 0
                        ? `<span class="timer-count-badge" title="${timedInputCount} scheduled timer${timedInputCount > 1 ? 's' : ''}">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
                            ${timedInputCount}
                        </span>`
                        : '';
                    html += `<div class="session-card">
                        <div class="session-info">
                            <h3>${escapeHtml(s.name)}${s.hasUnreadCompletion ? '<span class="completion-dot" title="Completed"></span>' : ''}${timerBadge} <button class="icon-btn" onclick="renameSession('${s.id}', decodePathValue('${encodedName}'), event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></h3>
                            <p>${escapeHtml(s.tool)}</p>
                            <p>${new Date(s.startTime).toLocaleTimeString()}</p>
                            <div class="session-dir-row">
                                <button class="copy-dir-btn" title="Copy directory" onclick="copySessionDirectory(decodePathValue('${encodedDir}'), event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                </button>
                                <p title="${escapeHtml(workingDirectory)}">${escapeHtml(workingDirectory)}</p>
                            </div>
                        </div>
                        <div class="session-actions">
                            <button class="btn-join" onclick="joinSession('${s.id}', decodePathValue('${encodedName}'), '${escapeHtml(s.toolKey || '')}')">Connect</button>
                            <button class="icon-btn btn-delete" onclick="deleteSession('${s.id}', event)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </div>
                    </div>`;
                });
                list.innerHTML = html;
            } catch (e) {
                list.innerHTML = `<div style="color:#ff3b30; text-align:center; margin-top:50px;"><p>Failed to load: ${e.message}</p><button class="btn-retry" onclick="loadSessions()">Retry</button></div>`;
            }
        }

        async function renameSession(id, oldName, e) {
            e.stopPropagation();
            const newName = prompt('Rename session', oldName);
            if (newName && newName !== oldName) {
                try {
                    await fetchWithTimeout('/api/sessions/' + id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName })
                    });
                    refreshSessionsNow();
                } catch (e) { alert('Rename failed'); }
            }
        }

        async function showToolModal() {
            document.getElementById('modal-overlay').style.display = 'flex';
            const list = document.getElementById('tools-list');
            loadAppConfig();
            try {
                const res = await fetchWithTimeout('/api/tools');
                const tools = await res.json();

                let html = '';
                tools.forEach(t => {
                    const versionLabel = t.version && t.version !== 'unknown' ? `v${t.version}` : 'version unknown';
                    html += `<div class="tool-item" onclick='createSession(${JSON.stringify(t.key)}, ${JSON.stringify(t.displayName)})'>
                        <div class="tool-icon">${t.displayName[0]}</div>
                        <div>
                            <div style="font-weight:600">${t.displayName}</div>
                            <div style="font-size:12px; color:#888">${versionLabel}</div>
                        </div>
                    </div>`;
                });
                list.innerHTML = html;
            } catch (e) {
                list.innerHTML = `<p style="color:#ff3b30">Detection failed: ${e.message}</p>`;
            }
        }

        async function loadAppConfig() {
            if (appConfig) {
                document.getElementById('default-cwd').textContent = appConfig.defaultWorkingDirectory || 'Current folder';
                return;
            }
            try {
                const res = await fetchWithTimeout('/api/config');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                appConfig = await res.json();
                document.getElementById('default-cwd').textContent = appConfig.defaultWorkingDirectory || 'Current folder';
            } catch (e) {
                document.getElementById('default-cwd').textContent = 'Current folder';
            }
        }

        function closeToolModal(e) {
            if (e.target.id === 'modal-overlay') document.getElementById('modal-overlay').style.display = 'none';
        }

        function isLobbyVisible() {
            return document.getElementById('lobby-view').classList.contains('active');
        }

        function scheduleSessionPolling() {
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            if (!isLobbyVisible()) return;

            const delay = document.hidden ? 30000 : 10000;
            sessionPollTimer = setTimeout(async () => {
                await loadSessions();
                scheduleSessionPolling();
            }, delay);
        }

        async function refreshSessionsNow() {
            clearTimeout(sessionPollTimer);
            sessionPollTimer = null;
            if (!isLobbyVisible()) return;
            if (lobbyTab === 'schedules') {
                await loadSchedules();
                scheduleSessionPolling();
                return;
            }
            await loadSessions();
            scheduleSessionPolling();
        }

        async function markCompletionRead(id) {
            try {
                await fetchWithTimeout('/api/sessions/' + id + '/completion/read', { method: 'POST' });
            } catch (e) {
                log('Failed to mark completion read: ' + e.message);
            }
        }
