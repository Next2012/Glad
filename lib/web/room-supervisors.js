let supervisorTasks = [];
let supervisorPanelRoomId = null;
let supervisorPoll = null;
let supervisorLoading = false;
let supervisorView = 'list';
let supervisorPermissionMemberId = null;
let supervisorEditingId = null;
let supervisorDetailId = null;
let supervisorHistoryCursor = '';
let supervisorHistoryItems = [];
let supervisorClockOffset = 0;
let supervisorNavigation = 0;
let supervisorListSignature = '';
let supervisorRunId = null;
let supervisorRunConfiguredPrompt = '';
const supervisorRunDrafts = new Map();

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
    for (const name of ['list', 'editor', 'detail', 'picker', 'permissions', 'run']) document.getElementById(`supervisor-${name}-view`).hidden = name !== view;
    document.getElementById('supervisor-back').hidden = view === 'list';
    document.getElementById('supervisor-new').hidden = view !== 'list';
    document.getElementById('supervisor-close').hidden = view !== 'list';
    document.getElementById('supervisor-back').setAttribute('aria-label', ['picker', 'permissions'].includes(view) ? 'Back to editor' : 'Back to supervisors');
    document.querySelector('.room-supervisor-modal').dataset.view = view;
    document.getElementById('room-supervisor-title').textContent = view === 'list' ? 'Supervisors' : view === 'detail' ? 'Supervisor details' : view === 'picker' ? 'Supervisor session' : view === 'permissions' ? 'Permissions' : view === 'run' ? 'Run once now' : supervisorEditingId ? 'Edit supervisor' : 'New supervisor';
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
        if (['list', 'detail'].includes(supervisorView)) void loadSupervisorTasks();
        updateSupervisorCountdowns();
    }, 2000);
}
function closeSupervisorPanel(event) {
    if (event && event.target.id !== 'room-supervisor-overlay') return;
    document.getElementById('room-supervisor-overlay').classList.remove('active');
    clearInterval(supervisorPoll); supervisorPoll = null; supervisorNavigation++;
}
function supervisorBack() {
    if (['picker', 'permissions'].includes(supervisorView)) { setSupervisorView('editor'); growSupervisorPrompt(); return; }
    setSupervisorView('list'); void loadSupervisorTasks();
}
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
        <div class="supervisor-card-bottom"><span data-supervisor-status="${escapeHtml(task.id)}">${escapeHtml(supervisorStatus(task))}</span>${active ? `<button class="small-btn" type="button" onclick="supervisorAction('${escapeHtml(task.id)}','stop')"${task.status === 'stopping' ? ' disabled' : ''}>Stop run</button>` : ''}<details class="supervisor-menu"><summary aria-label="More supervisor actions">⋯</summary><div><button type="button" onclick="openSupervisorRun('${escapeHtml(task.id)}')"${active || task.runOnce ? ' disabled' : ''}>Run once now</button><button type="button" onclick="editSupervisorTask('${escapeHtml(task.id)}')">Edit</button><button type="button" onclick="openSupervisorDetails('${escapeHtml(task.id)}')">History</button><button type="button" class="danger" onclick="supervisorAction('${escapeHtml(task.id)}','delete')">Delete</button></div></details></div>
        ${task.lastError ? `<p class="supervisor-task-error">${escapeHtml(task.lastError)}</p>` : ''}
    </article>`;
}
async function loadSupervisorTasks() {
    if (supervisorLoading) return;
    supervisorLoading = true;
    const roomId = supervisorPanelRoomId;
    try {
        const data = await supervisorRequest();
        if (roomId !== activeRoomId || roomId !== supervisorPanelRoomId || !['list', 'detail'].includes(supervisorView)) return;
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
        return `<div class="supervisor-target" data-member-id="${escapeHtml(member.id)}"><label class="supervisor-switch-row"><span>${escapeHtml(member.displayName)}</span><input type="checkbox" class="supervisor-target-enabled"${target ? ' checked' : ''}></label><button type="button" class="supervisor-setting-row supervisor-permission-open" data-open-permissions="${escapeHtml(member.id)}"><span class="supervisor-permission-summary">Full control</span><span aria-hidden="true">›</span></button><div class="supervisor-permissions" hidden>${['read', 'stop', 'send'].map(key => `<input type="checkbox" data-permission="${key}"${!target || target[key] ? ' checked' : ''}>`).join('')}</div></div>`;
    }).join('');
    syncSupervisorTargets();
}
function syncSupervisorTargets() {
    const executor = document.getElementById('supervisor-executor').value;
    document.getElementById('supervisor-executor-name').textContent = supervisorMemberName(executor);
    document.querySelectorAll('#supervisor-targets .supervisor-target').forEach(row => {
        const self = row.dataset.memberId === executor;
        row.hidden = self;
        const selected = row.querySelector('.supervisor-target-enabled');
        if (self) selected.checked = false;
        row.querySelectorAll('input').forEach(input => { input.disabled = self; });
        row.querySelector('.supervisor-permission-open').hidden = !selected.checked;
        const allowed = [...row.querySelectorAll('[data-permission]')].filter(input => input.checked).map(input => ({ read: 'Read', stop: 'Stop', send: 'Send' })[input.dataset.permission]);
        row.querySelector('.supervisor-permission-summary').textContent = allowed.length === 3 ? 'Full control' : allowed.join(' + ') || 'No permissions';
    });
}
function openSupervisorSessionPicker() {
    const executor = document.getElementById('supervisor-executor').value;
    const list = document.getElementById('supervisor-session-options');
    list.innerHTML = activeRoom.members.filter(member => !member.leftAt).map(member => `<button type="button" class="supervisor-setting-row" data-choose-executor="${escapeHtml(member.id)}" aria-pressed="${member.id === executor}"><span>${escapeHtml(member.displayName)}</span><span>${member.id === executor ? '✓' : ''}</span></button>`).join('');
    setSupervisorView('picker');
}
function openSupervisorPermissions(memberId) {
    const row = [...document.querySelectorAll('#supervisor-targets .supervisor-target')].find(row => row.dataset.memberId === memberId);
    if (!row || row.hidden || !row.querySelector('.supervisor-target-enabled').checked) return;
    supervisorPermissionMemberId = memberId;
    for (const input of document.querySelectorAll('[data-edit-permission]')) input.checked = row.querySelector(`[data-permission="${input.dataset.editPermission}"]`).checked;
    document.getElementById('supervisor-permissions-member').textContent = supervisorMemberName(memberId);
    document.getElementById('supervisor-permission-help').textContent = 'Stopping requires Read permission to obtain the current turn ID.';
    setSupervisorView('permissions');
}
function updateSupervisorPermission(event) {
    const row = [...document.querySelectorAll('#supervisor-targets .supervisor-target')].find(row => row.dataset.memberId === supervisorPermissionMemberId);
    if (!row) return;
    const read = document.getElementById('supervisor-permission-read'), stop = document.getElementById('supervisor-permission-stop');
    let explanation = 'Stopping requires Read permission to obtain the current turn ID.';
    if (event.target === stop && stop.checked && !read.checked) { read.checked = true; explanation = 'Read enabled: stopping needs the current turn ID.'; }
    if (event.target === read && !read.checked && stop.checked) { stop.checked = false; explanation = 'Stop disabled: stopping requires Read permission.'; }
    for (const input of document.querySelectorAll('[data-edit-permission]')) row.querySelector(`[data-permission="${input.dataset.editPermission}"]`).checked = input.checked;
    document.getElementById('supervisor-permission-help').textContent = explanation;
    syncSupervisorTargets();
}
function growSupervisorPrompt() {
    const prompt = document.getElementById('supervisor-prompt');
    if (supervisorView !== 'editor') return;
    prompt.style.height = 'auto'; prompt.style.height = Math.max(128, prompt.scrollHeight) + 'px';
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
    setSupervisorInterval(120); renderSupervisorTargets(); growSupervisorPrompt();
    if (!id) return;
    const save = document.getElementById('supervisor-save'); save.disabled = true;
    try {
        const data = await supervisorRequest(`/${encodeURIComponent(id)}`);
        if (navigation !== supervisorNavigation) return;
        const task = data.task;
        document.getElementById('supervisor-executor').value = task.executorMemberId;
        document.getElementById('supervisor-prompt').value = task.prompt;
        document.getElementById('supervisor-skip').checked = task.skipUnchanged;
        setSupervisorInterval(task.intervalSeconds); renderSupervisorTargets(task.targets); growSupervisorPrompt();
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
        if (['pause', 'delete'].includes(action)) supervisorRunDrafts.delete(`${supervisorPanelRoomId}:${id}`);
        document.querySelectorAll('.supervisor-menu[open]').forEach(menu => { menu.open = false; });
        if (action === 'delete' && supervisorDetailId === id) setSupervisorView('list');
        supervisorListSignature = ''; await loadSupervisorTasks();
    } catch (error) { supervisorError(error); }
}
function saveSupervisorRunDraft() {
    if (!supervisorRunId || supervisorView !== 'run') return;
    const key = `${supervisorPanelRoomId}:${supervisorRunId}`;
    const draft = supervisorRunDrafts.get(key) || { text: supervisorRunConfiguredPrompt };
    draft.mode = document.querySelector('[name="supervisor-run-mode"]:checked').value;
    if (draft.mode === 'custom') draft.text = document.getElementById('supervisor-run-prompt').value;
    supervisorRunDrafts.set(key, draft);
}
function syncSupervisorRunMode() {
    const mode = document.querySelector('[name="supervisor-run-mode"]:checked').value;
    const prompt = document.getElementById('supervisor-run-prompt');
    prompt.readOnly = mode !== 'custom';
    const draft = supervisorRunDrafts.get(`${supervisorPanelRoomId}:${supervisorRunId}`);
    prompt.value = mode === 'custom' ? draft?.text ?? supervisorRunConfiguredPrompt : supervisorRunConfiguredPrompt;
    document.getElementById('supervisor-run-help').textContent = mode === 'custom'
        ? 'Only this check uses your message. Saved settings and recurring monitoring stay unchanged. Ending supervision ends only this check’s tool access.'
        : 'Uses the saved prompt. Ending supervision disables future monitoring.';
    saveSupervisorRunDraft();
}
async function openSupervisorRun(id) {
    supervisorRunId = id;
    setSupervisorView('run');
    document.querySelectorAll('.supervisor-menu[open]').forEach(menu => { menu.open = false; });
    const navigation = supervisorNavigation;
    const submit = document.getElementById('supervisor-run-submit'); submit.disabled = true;
    const prompt = document.getElementById('supervisor-run-prompt'); prompt.value = ''; prompt.readOnly = true;
    const modes = document.querySelectorAll('[name="supervisor-run-mode"]');
    modes.forEach(input => { input.disabled = true; });
    try {
        const data = await supervisorRequest(`/${encodeURIComponent(id)}`);
        if (navigation !== supervisorNavigation) return;
        supervisorRunConfiguredPrompt = data.task.prompt;
        const draft = supervisorRunDrafts.get(`${supervisorPanelRoomId}:${id}`);
        document.querySelector(`[name="supervisor-run-mode"][value="${draft?.mode || 'configured'}"]`).checked = true;
        syncSupervisorRunMode();
        modes.forEach(input => { input.disabled = false; });
        submit.disabled = false;
    } catch (error) { if (navigation === supervisorNavigation) supervisorError(error); }
}
async function submitSupervisorRun() {
    const id = supervisorRunId, roomId = supervisorPanelRoomId, navigation = supervisorNavigation;
    const submit = document.getElementById('supervisor-run-submit');
    if (submit.disabled) return;
    saveSupervisorRunDraft();
    const mode = document.querySelector('[name="supervisor-run-mode"]:checked').value;
    const body = { mode };
    if (mode === 'custom') body.prompt = document.getElementById('supervisor-run-prompt').value;
    submit.disabled = true; supervisorError(null);
    try {
        await supervisorRequest(`/${encodeURIComponent(id)}/trigger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        supervisorRunDrafts.delete(`${roomId}:${id}`);
        if (navigation !== supervisorNavigation) return;
        setSupervisorView('list'); supervisorListSignature = ''; await loadSupervisorTasks();
    } catch (error) { if (navigation === supervisorNavigation) supervisorError(error); }
    finally { if (navigation === supervisorNavigation) submit.disabled = false; }
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
        const html = newItems.map(run => `<details class="supervisor-history-row" data-invocation-id="${escapeHtml(run.id)}"><summary><span>${escapeHtml(new Date(run.startedAt).toLocaleString())} · ${run.kind === 'custom' ? 'Custom · ' : ''}${escapeHtml(supervisorRunStatus(run.status))}</span><small>${escapeHtml(run.summary || 'In progress')}</small></summary><div class="supervisor-run-content">Select to load calls.</div></details>`).join('') || '<p>No checks yet.</p>';
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

document.getElementById('supervisor-targets').addEventListener('click', event => {
    const button = event.target.closest('[data-open-permissions]');
    if (button) openSupervisorPermissions(button.dataset.openPermissions);
});
document.getElementById('supervisor-session-options').addEventListener('click', event => {
    const button = event.target.closest('[data-choose-executor]');
    if (!button) return;
    document.getElementById('supervisor-executor').value = button.dataset.chooseExecutor;
    syncSupervisorTargets(); supervisorBack();
});
document.querySelectorAll('[data-edit-permission]').forEach(input => input.addEventListener('change', updateSupervisorPermission));
document.getElementById('supervisor-prompt').addEventListener('input', growSupervisorPrompt);
document.getElementById('supervisor-run-prompt').addEventListener('input', saveSupervisorRunDraft);
document.querySelectorAll('[name="supervisor-run-mode"]').forEach(input => input.addEventListener('change', syncSupervisorRunMode));
