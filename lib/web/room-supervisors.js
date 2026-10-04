let supervisorTasks = [];
let supervisorPanelRoomId = null;
let supervisorPoll = null;
let supervisorLoading = false;
let supervisorView = 'list';
let supervisorEditingId = null;
let supervisorDetailId = null;
let supervisorHistoryCursor = '';
let supervisorHistoryItems = [];
let supervisorClockOffset = 0;
let supervisorNavigation = 0;
let supervisorListSignature = '';

async function supervisorRequest(path = '', options = {}) {
    const started = Date.now();
    const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(supervisorPanelRoomId)}/supervisors${path}`, options, 35000);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.serverNow) supervisorClockOffset = Number(data.serverNow) - (started + Date.now()) / 2;
    return data;
}
function supervisorError(error) {
    const element = document.getElementById('supervisor-error');
    element.textContent = error?.message || ''; element.hidden = !error;
}
function setSupervisorView(view) {
    supervisorView = view; supervisorNavigation++;
    for (const name of ['list', 'editor', 'detail']) document.getElementById(`supervisor-${name}-view`).hidden = name !== view;
    document.getElementById('supervisor-back').hidden = view === 'list';
    document.getElementById('supervisor-new').hidden = view !== 'list';
    document.getElementById('room-supervisor-title').textContent = view === 'list' ? 'Supervisors' : view === 'detail' ? 'Supervisor details' : supervisorEditingId ? 'Edit supervisor' : 'New supervisor';
    supervisorError(null);
}
async function openSupervisorPanel() {
    if (!activeRoom) return;
    supervisorPanelRoomId = activeRoomId; supervisorListSignature = '';
    setSupervisorView('list');
    document.getElementById('room-supervisor-overlay').classList.add('active');
    clearInterval(supervisorPoll);
    await loadSupervisorTasks();
    supervisorPoll = setInterval(() => {
        if (supervisorPanelRoomId !== activeRoomId) { closeSupervisorPanel(); return; }
        if (supervisorView !== 'editor') void loadSupervisorTasks();
        updateSupervisorCountdowns();
    }, 2000);
}
function closeSupervisorPanel(event) {
    if (event && event.target.id !== 'room-supervisor-overlay') return;
    document.getElementById('room-supervisor-overlay').classList.remove('active');
    clearInterval(supervisorPoll); supervisorPoll = null; supervisorNavigation++;
}
function supervisorBack() { setSupervisorView('list'); void loadSupervisorTasks(); }
function supervisorMemberName(id) { return activeRoom?.members.find(member => member.id === id)?.displayName || 'Unavailable'; }
function supervisorTime(seconds) {
    if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
    return `${Math.max(0, seconds)}s`;
}
function supervisorStatus(task) {
    if (task.status === 'stopping') return 'Stopping this run…';
    if (task.status === 'running') return task.enabled ? 'Checking sessions' : 'Checking sessions · pauses after this run';
    if (task.status === 'waiting_executor') return task.runOnce ? 'Run once · waiting for executor' : 'Waiting for executor';
    if (task.status === 'needs_attention') return 'Needs attention';
    if (task.status === 'failed') return 'Check failed';
    if (!task.enabled && !task.runOnce) return 'Paused';
    if (task.runOnce) return 'Run once · queued';
    if (task.nextAt) return `Checks in ${supervisorTime(Math.ceil((task.nextAt - Date.now() - supervisorClockOffset) / 1000))}`;
    return 'Monitoring enabled';
}
function supervisorRunStatus(status) {
    return ({ completed: 'Completed', stopped: 'Stopped', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted', running: 'Running' })[status] || status;
}
function supervisorTaskCard(task) {
    const active = task.lastRun && !task.lastRun.endedAt;
    return `<article class="supervisor-task" data-supervisor-id="${escapeHtml(task.id)}">
        <div class="supervisor-card-top"><button type="button" class="supervisor-card-open" onclick="openSupervisorDetails('${escapeHtml(task.id)}')"><strong>${escapeHtml(supervisorMemberName(task.executorMemberId))} → ${task.targetMemberIds.map(id => escapeHtml(supervisorMemberName(id))).join(', ')}</strong><span>${escapeHtml(task.promptSummary)}</span></button><label class="supervisor-toggle"><input type="checkbox" aria-label="Enable monitoring" ${task.enabled ? 'checked' : ''} onchange="supervisorAction('${escapeHtml(task.id)}',this.checked?'resume':'pause')"><span>${task.enabled ? 'On' : 'Off'}</span></label></div>
        <div class="supervisor-card-bottom"><span data-supervisor-status="${escapeHtml(task.id)}">${escapeHtml(supervisorStatus(task))}</span>${active ? `<button class="small-btn" type="button" onclick="supervisorAction('${escapeHtml(task.id)}','stop')"${task.status === 'stopping' ? ' disabled' : ''}>Stop run</button>` : ''}<details class="supervisor-menu"><summary aria-label="More supervisor actions">⋯</summary><div><button type="button" onclick="supervisorAction('${escapeHtml(task.id)}','trigger')"${active ? ' disabled' : ''}>Run once now</button><button type="button" onclick="editSupervisorTask('${escapeHtml(task.id)}')">Edit</button><button type="button" onclick="openSupervisorDetails('${escapeHtml(task.id)}')">History</button><button type="button" class="danger" onclick="supervisorAction('${escapeHtml(task.id)}','delete')">Delete</button></div></details></div>
        ${task.lastError ? `<p class="supervisor-task-error">${escapeHtml(task.lastError)}</p>` : ''}
    </article>`;
}
async function loadSupervisorTasks() {
    if (supervisorLoading) return;
    supervisorLoading = true;
    const roomId = supervisorPanelRoomId;
    try {
        const data = await supervisorRequest();
        if (roomId !== activeRoomId || roomId !== supervisorPanelRoomId || supervisorView === 'editor') return;
        supervisorTasks = data.tasks;
        const warning = document.getElementById('supervisor-load-warning');
        warning.hidden = !data.loadErrorCount;
        warning.textContent = data.loadErrorCount ? `${data.loadErrorCount} tasks or audit files could not be fully loaded. Original files have been kept.` : '';
        const signature = JSON.stringify([data.tasks, activeRoom.members.map(member => [member.id, member.displayName])]);
        if (signature !== supervisorListSignature) {
            supervisorListSignature = signature;
            document.getElementById('room-supervisor-list').innerHTML = supervisorTasks.map(supervisorTaskCard).join('') || '<div class="supervisor-empty"><p>No supervisors yet.</p><button type="button" class="small-btn primary" onclick="editSupervisorTask()">Create your first supervisor</button></div>';
        }
        updateSupervisorCountdowns();
    } catch (error) { supervisorError(error); } finally { supervisorLoading = false; }
}
function updateSupervisorCountdowns() {
    document.querySelectorAll('[data-supervisor-status]').forEach(element => {
        const task = supervisorTasks.find(item => item.id === element.dataset.supervisorStatus);
        if (task) element.textContent = supervisorStatus(task);
    });
}
function renderSupervisorTargets(targets = []) {
    const members = activeRoom.members.filter(member => !member.leftAt);
    document.getElementById('supervisor-targets').innerHTML = members.map(member => {
        const target = targets.find(item => item.memberId === member.id);
        return `<div class="supervisor-target" data-member-id="${escapeHtml(member.id)}"><label class="supervisor-check"><input type="checkbox" class="supervisor-target-enabled"${target ? ' checked' : ''}>${escapeHtml(member.displayName)}</label><details class="supervisor-permission-settings"><summary>Permissions: <span class="supervisor-permission-summary">All</span></summary><div class="supervisor-permissions">${[['read', 'Read output and history'], ['stop', 'Stop session'], ['send', 'Send command']].map(([key, label]) => `<label class="supervisor-check"><input type="checkbox" data-permission="${key}"${!target || target[key] ? ' checked' : ''}>${label}</label>`).join('')}</div></details></div>`;
    }).join('');
    syncSupervisorTargets();
}
function syncSupervisorTargets() {
    const executor = document.getElementById('supervisor-executor').value;
    document.querySelectorAll('#supervisor-targets .supervisor-target').forEach(row => {
        const self = row.dataset.memberId === executor;
        row.hidden = self;
        const selected = row.querySelector('.supervisor-target-enabled');
        if (self) selected.checked = false;
        row.querySelectorAll('input').forEach(input => { input.disabled = self; });
        row.querySelector('details').hidden = !selected.checked;
        const allowed = [...row.querySelectorAll('[data-permission]')].filter(input => input.checked).map(input => ({ read: 'Read', stop: 'Stop', send: 'Send' })[input.dataset.permission]);
        row.querySelector('.supervisor-permission-summary').textContent = allowed.length === 3 ? 'All' : allowed.join(', ') || 'None';
    });
}
function setSupervisorInterval(seconds) {
    const preset = [60, 120, 300, 900].includes(seconds) ? String(seconds) : 'custom';
    document.querySelectorAll('[data-supervisor-interval]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.supervisorInterval === preset)); });
    document.getElementById('supervisor-custom-interval').hidden = preset !== 'custom';
    document.getElementById('supervisor-interval').value = seconds;
    document.getElementById('supervisor-custom-minutes').value = seconds / 60;
}
async function editSupervisorTask(id = null) {
    supervisorEditingId = id;
    setSupervisorView('editor');
    const navigation = supervisorNavigation;
    const members = activeRoom.members.filter(member => !member.leftAt);
    document.getElementById('supervisor-executor').innerHTML = members.map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.displayName)}</option>`).join('');
    document.getElementById('supervisor-prompt').value = '';
    document.getElementById('supervisor-skip').checked = false;
    document.getElementById('supervisor-save').textContent = id ? 'Save changes' : 'Save & start';
    setSupervisorInterval(120); renderSupervisorTargets();
    if (!id) return;
    const save = document.getElementById('supervisor-save'); save.disabled = true;
    try {
        const data = await supervisorRequest(`/${encodeURIComponent(id)}`);
        if (navigation !== supervisorNavigation) return;
        const task = data.task;
        document.getElementById('supervisor-executor').value = task.executorMemberId;
        document.getElementById('supervisor-prompt').value = task.prompt;
        document.getElementById('supervisor-skip').checked = task.skipUnchanged;
        setSupervisorInterval(task.intervalSeconds); renderSupervisorTargets(task.targets);
    } catch (error) { supervisorError(error); } finally { save.disabled = false; }
}
async function saveSupervisorTask() {
    const targets = [...document.querySelectorAll('#supervisor-targets .supervisor-target')].filter(row => !row.hidden && row.querySelector('.supervisor-target-enabled').checked).map(row => {
        const target = { memberId: row.dataset.memberId };
        row.querySelectorAll('[data-permission]').forEach(input => { target[input.dataset.permission] = input.checked; }); return target;
    });
    const button = document.getElementById('supervisor-save'); button.disabled = true;
    try {
        await supervisorRequest(supervisorEditingId ? `/${encodeURIComponent(supervisorEditingId)}` : '', {
            method: supervisorEditingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ executorMemberId: document.getElementById('supervisor-executor').value, targets, intervalSeconds: Number(document.getElementById('supervisor-interval').value), prompt: document.getElementById('supervisor-prompt').value, skipUnchanged: document.getElementById('supervisor-skip').checked })
        });
        setSupervisorView('list'); supervisorListSignature = ''; await loadSupervisorTasks();
    } catch (error) { supervisorError(error); } finally { button.disabled = false; }
}
async function supervisorAction(id, action) {
    try {
        await supervisorRequest(`/${encodeURIComponent(id)}${action === 'delete' ? '' : '/' + action}`, { method: action === 'delete' ? 'DELETE' : 'POST' });
        document.querySelectorAll('.supervisor-menu[open]').forEach(menu => { menu.open = false; });
        if (action === 'delete' && supervisorDetailId === id) setSupervisorView('list');
        supervisorListSignature = ''; await loadSupervisorTasks();
    } catch (error) { supervisorError(error); }
}
async function openSupervisorDetails(id) {
    supervisorDetailId = id; supervisorHistoryItems = []; supervisorHistoryCursor = '';
    setSupervisorView('detail');
    const task = supervisorTasks.find(item => item.id === id);
    document.getElementById('supervisor-detail-summary').innerHTML = task ? `<strong>${escapeHtml(supervisorMemberName(task.executorMemberId))} → ${task.targetMemberIds.map(member => escapeHtml(supervisorMemberName(member))).join(', ')}</strong><p data-supervisor-status="${escapeHtml(id)}">${escapeHtml(supervisorStatus(task))}</p><p>${escapeHtml(task.lastRun?.summary || 'No completed checks yet.')}</p><button type="button" class="small-btn" onclick="editSupervisorTask('${escapeHtml(id)}')">Edit configuration</button>` : '';
    document.getElementById('supervisor-history').innerHTML = '';
    await loadSupervisorHistory();
}
async function loadSupervisorHistory(append = false) {
    const id = supervisorDetailId, navigation = supervisorNavigation;
    try {
        const data = await supervisorRequest(`/${encodeURIComponent(id)}/history?limit=20${append && supervisorHistoryCursor ? '&before=' + encodeURIComponent(supervisorHistoryCursor) : ''}`);
        if (navigation !== supervisorNavigation || supervisorView !== 'detail') return;
        supervisorHistoryItems = append && !data.reset ? [...supervisorHistoryItems, ...data.items] : data.items;
        supervisorHistoryCursor = data.nextCursor;
        const list = document.getElementById('supervisor-history');
        const newItems = append && !data.reset ? data.items : supervisorHistoryItems;
        const html = newItems.map(run => `<details class="supervisor-history-row" data-invocation-id="${escapeHtml(run.id)}"><summary><span>${escapeHtml(new Date(run.startedAt).toLocaleString())} · ${escapeHtml(supervisorRunStatus(run.status))}</span><small>${escapeHtml(run.summary || 'In progress')}</small></summary><div class="supervisor-run-content">Select to load calls.</div></details>`).join('') || '<p>No checks yet.</p>';
        if (append && !data.reset) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html;
        list.querySelectorAll('.supervisor-history-row').forEach(element => { if (element.dataset.bound) return; element.dataset.bound = 'true'; element.addEventListener('toggle', () => { if (element.open && !element.dataset.loaded) void loadSupervisorRun(element, id, element.dataset.invocationId); }); });
        document.getElementById('supervisor-history-more').hidden = !data.hasMore;
    } catch (error) { supervisorError(error); }
}
async function loadSupervisorRun(element, taskId, invocationId) {
    if (element.dataset.loading) return;
    element.dataset.loading = 'true';
    try {
        const data = await supervisorRequest(`/${encodeURIComponent(taskId)}/history/${encodeURIComponent(invocationId)}`);
        if (!element.isConnected) return;
        const run = data.invocation;
        element.querySelector('.supervisor-run-content').innerHTML = `${run.calls.map(call => `<details><summary>${escapeHtml(call.tool)} · ${call.success ? 'Success' : 'Failed'} · ${escapeHtml(supervisorMemberName(call.memberId))}</summary><pre>${escapeHtml(call.summary)}</pre></details>`).join('') || '<p>No tool calls recorded.</p>'}<details><summary>More details</summary><p>Prompt</p><pre>${escapeHtml(run.prompt)}</pre><p>Usage</p><pre>${escapeHtml(Object.keys(run.usage || {}).length ? JSON.stringify(run.usage, null, 2) : 'Not provided')}</pre></details>`;
        element.dataset.loaded = 'true';
    } catch (error) { element.querySelector('.supervisor-run-content').textContent = error.message; } finally { delete element.dataset.loading; }
}
document.getElementById('supervisor-executor').addEventListener('change', syncSupervisorTargets);
document.getElementById('supervisor-targets').addEventListener('change', syncSupervisorTargets);
document.querySelectorAll('[data-supervisor-interval]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.supervisorInterval === 'custom') {
        document.getElementById('supervisor-custom-interval').hidden = false;
        document.querySelectorAll('[data-supervisor-interval]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    } else setSupervisorInterval(Number(button.dataset.supervisorInterval));
}));
document.getElementById('supervisor-custom-minutes').addEventListener('input', event => { document.getElementById('supervisor-interval').value = Math.round(Number(event.target.value) * 60); });
