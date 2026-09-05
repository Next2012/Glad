        let currentSocket = null, term = null, fitAddon = null, activeSessionId = null, activeToolKey = null, activeSessionHydrated = false;
        let appConfig = null;
        let sessionPollTimer = null;
        let sessionListRevision = 0;
        let lobbyTab = 'sessions';
        let scheduleTools = [];
        let editingScheduleId = null;
        let editingSteps = [];
        let selectedWeekdays = [1, 2, 3, 4, 5];
        let timedSendRefreshTimer = null;
        let timedTagTimer = null;
        let editingTimedInputId = null;
        function setActionButtonLabel(button, label) {
            if (!button) return;
            const labelNode = button.querySelector('.action-label');
            if (labelNode) {
                labelNode.textContent = label;
                return;
            }
            button.textContent = label;
        }
        function renderSessionAttention(parts = []) {
            const strip = document.getElementById('session-status-strip');
            const rail = document.getElementById('session-attention-rail');
            if (!strip || !rail) return;
            rail.innerHTML = parts.join('');
            strip.style.display = parts.length ? 'block' : 'none';
        }
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
        function createDefaultCodexState() {
            return {
                permissionMode: 'default', sandboxMode: 'default',
                effectivePermissionMode: null, effectiveSandboxMode: null,
                model: null, effort: null, status: 'idle', threadId: null,
                models: [], aborting: false, resuming: false, forking: false,
                canAbort: false, canCompact: false, compacting: false
            };
        }
        let codexMessages = [];
        let codexPendingPermissions = [];
        let codexState = createDefaultCodexState();
        let codexModelPanelOpen = false;
        let codexModelCandidate = null;
        let codexResumePanelOpen = false;
        let codexResumeInFlight = false;
        let codexForkInFlight = false;
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
        let codexSkillQuery = '';
        let codexSkillError = '';
        let selectedCodexSkill = null;
        let codexRenderFrame = null;
        let codexApprovalJumpIndex = 0;
        let codexDetailRequestSeq = 0;
        let codexDetailRequests = new Map();
        let codexDetailRevisions = new Map();
        let codexDetailRefreshTimer = null;
        let codexDetailRefreshIds = new Set();
        let codexStatusPending = false;
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

        function renderSessionCard(session) {
            const workingDirectory = session.workingDirectory || 'Unknown directory';
            const encodedId = encodePathValue(session.id);
            const encodedName = encodePathValue(session.name);
            const encodedDir = encodePathValue(workingDirectory);
            const encodedToolKey = encodePathValue(session.toolKey || '');
            const timedInputCount = Number(session.timedInputCount) || 0;
            const timerBadge = timedInputCount > 0
                ? `<span class="timer-count-badge" title="${timedInputCount} scheduled timer${timedInputCount > 1 ? 's' : ''}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
                    ${timedInputCount}
                </span>`
                : '';
            return `<div class="session-card${session.id === activeSessionId ? ' selected' : ''}" data-session-id="${escapeHtml(session.id)}" title="Hold for 3 seconds to reorder">
                <span class="active-session-dot" title="Current session" aria-label="Current session"></span>
                <div class="session-info">
                    <h3><span class="session-name" title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</span>${session.hasUnreadCompletion ? '<span class="completion-dot" title="Completed"></span>' : ''}${timerBadge} <button type="button" class="icon-btn session-edit-btn" title="Rename session" aria-label="Rename session" onclick="renameSession(decodePathValue('${encodedId}'), decodePathValue('${encodedName}'), event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></h3>
                    <p>${escapeHtml(session.tool)}</p>
                    <p>${new Date(session.startTime).toLocaleTimeString()}</p>
                </div>
                <div class="session-actions">
                    ${renderServerChanSessionAction(session)}
                    <button class="btn-join" onclick="joinSession(decodePathValue('${encodedId}'), decodePathValue('${encodedName}'), decodePathValue('${encodedToolKey}'))">Connect</button>
                    <button type="button" class="icon-btn btn-delete session-delete-btn" title="Delete session" aria-label="Delete session" onclick="deleteSession(decodePathValue('${encodedId}'), event)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                </div>
                <div class="session-dir-row">
                    <button class="copy-dir-btn" title="Copy directory" onclick="copySessionDirectory(decodePathValue('${encodedDir}'), event)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <p title="${escapeHtml(workingDirectory)}">${escapeHtml(workingDirectory)}</p>
                </div>
            </div>`;
        }

        function renderSessionList(sessions) {
            document.getElementById('sessions-list').innerHTML = sessions.length
                ? sessions.map(renderSessionCard).join('')
                : '<p style="color:#888; text-align:center; margin-top:50px;">No active sessions</p>';
        }

        async function loadSessions() {
            log('Loading sessions...');
            const list = document.getElementById('sessions-list');
            const revision = ++sessionListRevision;
            try {
                const res = await fetchWithTimeout('/api/sessions');
                if (revision !== sessionListRevision) return;
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                if (revision !== sessionListRevision) return;
                if (window.gladSessionOrder.deferRefresh(data)) return;
                const sessions = window.gladSessionOrder.sort(data);
                if (window.gladWorkspace) window.gladWorkspace.refreshTiledSessionsFromList(sessions);
                renderSessionList(sessions);
            } catch (e) {
                if (revision !== sessionListRevision) return;
                if (window.gladSessionOrder.isInteracting()) return;
                list.innerHTML = `<div style="color:#ff3b30; text-align:center; margin-top:50px;"><p>Failed to load: ${e.message}</p><button class="btn-retry" onclick="loadSessions()">Retry</button></div>`;
            }
        }

        async function renameSession(id, oldName, e) {
            e.stopPropagation();
            const newName = prompt('Rename session', oldName);
            if (newName && newName !== oldName) {
                try {
                    const response = await fetchWithTimeout('/api/sessions/' + id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName })
                    }, 35000);
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.error || 'Rename failed');
                    applySessionName(id, data.name);
                    if (data.warning) alert(data.warning);
                    refreshSessionsNow();
                } catch (e) { alert('Rename failed'); }
            }
        }

        async function showToolModal(skill = null) {
            window.pendingSkillHubSkill = skill || null;
            document.getElementById('modal-overlay').style.display = 'flex';
            const list = document.getElementById('tools-list');
            const title = document.getElementById('tool-modal-title');
            const skillLabel = document.getElementById('tool-modal-skill');
            if (title) title.textContent = skill ? 'Start Skill Session' : 'Create Session';
            if (skillLabel) skillLabel.textContent = skill ? String(skill.displayName || skill.name || '') : '';
            loadAppConfig();
            try {
                const res = await fetchWithTimeout('/api/tools');
                let tools = await res.json();
                if (skill) tools = tools.filter(tool => tool.key === 'codex');

                let html = '';
                const installedCount = tools.filter(tool => tool.installed === true).length;
                if (installedCount === 0) {
                    html += `<div class="tool-empty-state" role="status">${skill
                        ? 'Codex is required to start a Skill session. Install it, then reopen this menu.'
                        : 'No supported AI CLI is installed. Install Codex or Claude, then reopen this menu.'}</div>`;
                }
                tools.forEach(t => {
                    const installed = t.installed === true;
                    const versionLabel = installed && t.version && t.version !== 'unknown' ? `v${t.version}`
                        : installed ? 'version unknown' : 'Not installed';
                    const activation = installed
                        ? ` role="button" tabindex="0" onclick='activateToolItem(event, ${JSON.stringify(t.key)}, ${JSON.stringify(t.displayName)})' onkeydown='activateToolItem(event, ${JSON.stringify(t.key)}, ${JSON.stringify(t.displayName)})'`
                        : ' role="button" tabindex="-1" aria-disabled="true"';
                    const installLink = !installed && t.website
                        ? `<a class="tool-install-link" href="${escapeHtml(t.website)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">Install guide</a>`
                        : '';
                    html += `<div class="tool-item${installed ? '' : ' unavailable'}"${activation}>
                        <div class="tool-icon">${t.displayName[0]}</div>
                        <div class="tool-item-content">
                            <div style="font-weight:600">${t.displayName}</div>
                            <div class="tool-version">${escapeHtml(versionLabel)}</div>
                        </div>
                        ${installLink}
                    </div>`;
                });
                list.innerHTML = html;
            } catch (e) {
                list.innerHTML = `<p style="color:#ff3b30">Detection failed: ${e.message}</p>`;
            }
        }

        function activateToolItem(event, toolKey, displayName) {
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            createSession(toolKey, displayName);
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
            if (!e || e.target.id === 'modal-overlay') {
                document.getElementById('modal-overlay').style.display = 'none';
                window.pendingSkillHubSkill = null;
            }
        }

        function isLobbyVisible() {
            return document.getElementById('lobby-view').classList.contains('active')
                || (typeof isSplitLayout === 'function' && isSplitLayout());
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
