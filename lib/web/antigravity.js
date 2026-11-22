// Antigravity owns its ACP state and controls; only presentation primitives are shared.
let antigravityMessages = [];
let antigravityPendingPermissions = [];
let antigravityState = createDefaultAntigravityState();
let antigravityRenderFrame = null;
let antigravitySettingsPending = false;
let antigravitySessionEpoch = 0;
let antigravitySettingsRequestSequence = 0;
let antigravityResumePending = false;
let antigravityPreviewRequestSequence = 0;
const antigravityDetailRequests = new Map();
const antigravityDetailRevisions = new Map();

function createDefaultAntigravityState() {
    return { status: 'connecting', turnId: null, canAbort: false, canSteer: false,
        configOptions: [], modes: null, capabilities: {}, canCompact: false };
}
function isAntigravitySession() { return activeToolKey === 'antigravity'; }
function antigravityReadyForInput() {
    return antigravityState.status === 'idle' && !antigravityState.compacting && !antigravityState.aborting
        && !antigravityState.resuming && !antigravityResumePending && !antigravitySettingsPending;
}
function antigravityCanSteer() {
    return Boolean(antigravityState.canSteer && antigravityState.turnId)
        && !antigravityState.compacting && !antigravityState.aborting && !antigravityState.resuming && !antigravityResumePending
        && !antigravityPendingPermissions.some(item => item.status === 'pending')
        && !antigravityMessages.some(item => item.kind === 'question' && item.questionStatus === 'pending');
}
function antigravitySend(payload) {
    if (!isAntigravitySession() || currentSocket?.readyState !== WebSocket.OPEN) return false;
    currentSocket.send(JSON.stringify(payload));
    return true;
}
function antigravityJson(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value ?? '', null, 2); } catch (_) { return String(value); }
}
function initAntigravitySession(sessionId) {
    window.gladConversationPages?.activate(sessionId, 'antigravity');
    window.gladAntigravitySubagents?.reset();
    antigravitySessionEpoch += 1;
    antigravitySettingsRequestSequence += 1;
    closeCodexQuestionReply();
    activeSessionHydrated = false;
    antigravityMessages = [];
    antigravityPendingPermissions = [];
    antigravityState = createDefaultAntigravityState();
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    antigravityDetailRequests.clear();
    antigravityDetailRevisions.clear();
    closeAntigravityActionPanels();
    document.getElementById('antigravity-chat-container').replaceChildren();
    applyAntigravityState({});
    connectAntigravitySocket(sessionId);
}
function connectAntigravitySocket(sessionId) {
    currentSocket = new WebSocket(sessionWebSocketUrl(sessionId));
    const socket = currentSocket;
    socket.onopen = () => {
        if (currentSocket !== socket) return;
        structuredReconnectDelay = 1000;
        handleComposerSocketOpen();
    };
    socket.onclose = () => {
        if (currentSocket !== socket) return;
        antigravityDetailRequests.clear();
        handleComposerSocketClose();
        reconnectStructuredSession(sessionId, socket, connectAntigravitySocket);
    };
    socket.onerror = () => { if (currentSocket === socket) syncComposerSendState(); };
    socket.onmessage = e => {
        if (currentSocket !== socket || activeSessionId !== sessionId) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.type === 'send-result') handleComposerSendResult(msg);
        if (msg.type === 'antigravity-snapshot' && msg.snapshot) {
            const snapshot = window.gladConversationPages ? window.gladConversationPages.acceptSnapshot(sessionId, msg.snapshot) : msg.snapshot;
            applySessionName(sessionId, snapshot.name);
            antigravityMessages = snapshot.messages || [];
            antigravityPendingPermissions = snapshot.pendingPermissions || [];
            activeSessionHydrated = true;
            applyAntigravityState(snapshot.state || { status: snapshot.status || 'idle' });
            if (snapshot.hasUnreadCompletion) noteSessionCompletion(sessionId, snapshot.completionRevision);
        }
        if (msg.type === 'antigravity-event') {
            applyAntigravityEvent(msg.event);
            if (msg.event?.type === 'completion') noteSessionCompletion(sessionId, msg.event.revision);
        }
        if (msg.type === 'antigravity-detail-response' && msg.detail) {
            if (!antigravityDetailRequests.has(msg.requestId)) return;
            antigravityDetailRequests.delete(msg.requestId);
            for (const message of msg.detail.messages || []) {
                const item = antigravityMessages.find(item => item.id === message.id);
                if (!item) continue;
                const revision = Number(message.detailRevision || message.updatedAt || message.createdAt || 0);
                const currentRevision = Number(item.detailRevision || item.updatedAt || item.createdAt || 0);
                if (revision < currentRevision) { requestAntigravityDetails(item.id); continue; }
                Object.assign(item, message, { detailLoaded: true });
                antigravityDetailRevisions.set(String(message.id), revision);
            }
            renderAntigravityChat();
        }
        if (msg.type === 'error') showAppToast(msg.message || 'Antigravity request failed.');
        if (msg.type === 'exit') showLobby();
    };
}
function applyAntigravityEvent(event) {
    if (window.gladConversationPages) event = window.gladConversationPages.prepareEvent(activeSessionId, event);
    if (!event) return;
    if (event.type === 'session-renamed') { applySessionName(activeSessionId, event.name); return; }
    if ((event.type === 'message' || event.type === 'message-updated') && event.message) {
        const index = antigravityMessages.findIndex(item => item.id === event.message.id);
        if (index < 0) antigravityMessages.push(event.message);
        else antigravityMessages[index] = { ...antigravityMessages[index], ...event.message };
        const updated = antigravityMessages.find(item => item.id === event.message.id);
        if (updated?.hasDetail && Number(updated.detailRevision || 0) > Number(antigravityDetailRevisions.get(String(updated.id)) || 0)) {
            updated.detailLoaded = false;
            const open = Array.from(document.querySelectorAll('#antigravity-chat-container details[open][data-agy-message-id]')).some(details => details.dataset.agyMessageId === String(updated.id));
            if (open) requestAntigravityDetails(updated.id);
        }
    }
    if (event.type === 'history-reset') {
        antigravityMessages = event.messages || [];
        antigravityPendingPermissions = event.pendingPermissions || [];
        antigravityDetailRequests.clear();
        antigravityDetailRevisions.clear();
    }
    if ((event.type === 'permission-request' || event.type === 'permission-updated') && event.request) {
        antigravityPendingPermissions = [...antigravityPendingPermissions.filter(item => item.id !== event.request.id), event.request];
    }
    if (event.message?.kind === 'tool' && /subagent/i.test(event.message.name || event.message.toolName || event.message.title || '')) window.gladAntigravitySubagents?.refresh();
    applyAntigravityState(event.state || {});
}
function applyAntigravityState(state) {
    antigravityState = { ...antigravityState, ...state };
    window.gladAntigravitySubagents?.sync();
    if (!isAntigravitySession()) return;
    if (Object.prototype.hasOwnProperty.call(state, 'lastSpeed')) updateSessionSpeed(activeSessionId, state.lastSpeed);
    const ready = antigravityReadyForInput();
    document.getElementById('antigravity-abort-btn').disabled = !antigravityState.canAbort || Boolean(antigravityState.aborting);
    document.getElementById('antigravity-resume-btn').disabled = !ready;
    document.getElementById('antigravity-resume-btn').hidden = activeSessionHydrated
        && (antigravityState.capabilities?.resume === false || antigravityState.capabilities?.list === false);
    const compact = document.getElementById('antigravity-compact-btn');
    const compactAdvertised = (antigravityState.commands || []).some(command => String(command.name || '').replace(/^\//, '') === 'compact');
    compact.hidden = !(compactAdvertised || antigravityState.canCompact || antigravityState.compacting);
    compact.disabled = !ready || !antigravityState.canCompact || Boolean(antigravityState.compacting);
    setActionButtonLabel(compact, antigravityState.compacting ? 'Compacting' : 'Compact');
    renderAntigravitySettings();
    const pending = antigravityPendingPermissions.filter(item => item.status === 'pending');
    const questions = antigravityMessages.filter(item => item.kind === 'question' && item.questionStatus === 'pending');
    const bar = document.getElementById('antigravity-state-bar');
    const statusLabel = antigravityState.aborting || antigravityState.status === 'stopping' ? 'Stopping…'
        : antigravityState.compacting ? 'Compacting context…'
            : antigravityResumePending || antigravityState.resuming || antigravityState.status === 'resuming' ? 'Restoring conversation…'
                : antigravityState.status === 'connecting' ? 'Connecting…' : '';
    bar.hidden = !statusLabel;
    bar.innerHTML = statusLabel ? `<span class="claude-state-pill">${escapeHtml(statusLabel)}</span>` : '';
    renderSessionAttention([
        ...(pending.length ? [`<button class="session-attention-pill approval" onclick="focusAntigravityApproval()">! ${pending.length} approval${pending.length === 1 ? '' : 's'} ↓</button>`] : []),
        ...(questions.length ? [`<button class="session-attention-pill approval" onclick="focusAntigravityQuestion()">? ${questions.length} awaiting answer ↓</button>`] : [])
    ]);
    syncComposerSendState();
    renderAntigravityChat();
    updateTerminalControlsHeight();
}
function antigravityConfigOptions() {
    const options = Array.isArray(antigravityState.configOptions) ? antigravityState.configOptions : [];
    const result = options.filter(option => option && option.id);
    const modes = antigravityState.modes;
    if (modes?.availableModes?.length && !result.some(option => option.category === 'mode' || option.id === 'mode')) {
        result.push({ id: 'mode', name: 'Mode', currentValue: modes.currentModeId || antigravityState.mode,
            options: modes.availableModes.map(mode => ({ value: mode.id, name: mode.name || mode.id })) });
    }
    return result;
}
function antigravityOptionValues(option) {
    return (option.options || []).flatMap(item => Array.isArray(item.options) ? item.options : [item]);
}
function renderAntigravitySettings() {
    const host = document.getElementById('antigravity-config-controls');
    const options = antigravityConfigOptions().filter(option => antigravityOptionValues(option).length);
    const mode = options.find(option => option.category === 'mode' || option.id === 'mode');
    const settings = options.filter(option => option !== mode);
    // Reuse controls and option buttons so streamed state updates preserve focus.
    for (const section of Array.from(host.children)) {
        if (!settings.some(option => String(option.id) === section.querySelector('select')?.dataset.agyConfig)) section.remove();
    }
    settings.forEach((option, index) => {
        let select = Array.from(host.querySelectorAll('select')).find(item => item.dataset.agyConfig === String(option.id));
        if (!select) {
            const section = document.createElement('section');
            section.className = 'antigravity-config-control';
            section.innerHTML = '<div class="antigravity-picker-title"></div><select hidden></select><div class="antigravity-picker-options" role="group"></div>';
            select = section.querySelector('select');
            select.dataset.agyConfig = String(option.id);
            host.insertBefore(section, host.children[index] || null);
        }
        select.previousElementSibling.textContent = option.name || option.category || option.id;
        syncAntigravityConfigSelect(select, option);
        const choices = select.nextElementSibling;
        choices.setAttribute('aria-label', select.getAttribute('aria-label'));
        const values = antigravityOptionValues(option);
        const signature = JSON.stringify(values);
        if (choices.dataset.optionsSignature !== signature) {
            choices.innerHTML = values.map(value => `<button type="button" class="antigravity-picker-option" data-agy-config-choice="${escapeHtml(option.id)}" data-agy-value="${escapeHtml(value.value ?? value.id)}" aria-pressed="false"><span class="antigravity-picker-option-copy"><strong>${escapeHtml(value.name || value.label || value.value || value.id)}</strong>${value.description ? `<small>${escapeHtml(value.description)}</small>` : ''}</span><svg class="antigravity-picker-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg></button>`).join('');
            choices.dataset.optionsSignature = signature;
        }
        for (const button of choices.children) {
            const selected = button.dataset.agyValue === select.value;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
            button.disabled = select.disabled;
        }
    });
    const modeControl = document.getElementById('antigravity-mode-control');
    modeControl.hidden = !mode;
    if (mode) {
        let select = modeControl.querySelector('select');
        if (!select) {
            select = document.createElement('select');
            select.className = 'codex-select';
            modeControl.appendChild(select);
        }
        syncAntigravityConfigSelect(select, mode);
        modeControl.title = `${mode.name || 'Mode'}: ${select.selectedOptions[0]?.textContent || ''}`;
    }
    document.getElementById('antigravity-model-btn').disabled = !settings.length;
    if (!settings.length && !document.getElementById('antigravity-model-panel').hidden) closeAntigravityActionPanels();
}
function syncAntigravityConfigSelect(select, option) {
    select.dataset.agyConfig = String(option.id);
    select.setAttribute('aria-label', `Antigravity ${option.name || option.category || option.id}`);
    const values = antigravityOptionValues(option);
    const signature = JSON.stringify(values);
    if (select.dataset.optionsSignature !== signature) {
        select.innerHTML = values.map(value => `<option value="${escapeHtml(value.value ?? value.id)}">${escapeHtml(value.name || value.label || value.value || value.id)}</option>`).join('');
        select.dataset.optionsSignature = signature;
    }
    const current = String(option.currentValue ?? '');
    if (select.value !== current) select.value = current;
    select.disabled = !antigravityReadyForInput();
}
function closeAntigravityActionPanels() {
    antigravityPreviewRequestSequence += 1;
    for (const name of ['model', 'resume', 'command']) {
        document.getElementById(`antigravity-${name}-panel`).hidden = true;
        const trigger = document.getElementById(`antigravity-${name === 'command' ? 'commands' : name}-btn`);
        trigger?.setAttribute('aria-expanded', 'false');
        trigger?.classList.remove('active');
    }
    updateTerminalControlsHeight();
}
function toggleAntigravityModelPanel() {
    const panel = document.getElementById('antigravity-model-panel');
    const open = panel.hidden;
    closeAntigravityActionPanels();
    panel.hidden = !open;
    const trigger = document.getElementById('antigravity-model-btn');
    trigger.setAttribute('aria-expanded', String(open));
    trigger.classList.toggle('active', open);
    updateTerminalControlsHeight();
}
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isAntigravitySession()) return;
    const name = ['model', 'resume', 'command'].find(name => !document.getElementById(`antigravity-${name}-panel`).hidden);
    if (!name) return;
    event.preventDefault();
    closeAntigravityActionPanels();
    document.getElementById(`antigravity-${name === 'command' ? 'commands' : name}-btn`)?.focus({ preventScroll: true });
});
document.addEventListener('click', event => {
    const button = event.target.closest('[data-agy-config-choice]');
    if (!button || button.disabled || !isAntigravitySession()) return;
    const select = button.closest('.antigravity-config-control')?.querySelector('select');
    if (!select || select.disabled || select.value === button.dataset.agyValue) return;
    select.value = button.dataset.agyValue;
    select.dispatchEvent(new Event('change', { bubbles: true }));
});
async function antigravityRequest(path, options = {}, sessionId = activeSessionId) {
    const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/antigravity-${path}`, options, 35000);
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}
async function updateAntigravitySetting(id, value) {
    if (!antigravityReadyForInput()) return;
    const sessionId = activeSessionId;
    const sessionEpoch = antigravitySessionEpoch;
    const requestSequence = ++antigravitySettingsRequestSequence;
    const isCurrent = () => isAntigravitySession() && sessionId === activeSessionId
        && sessionEpoch === antigravitySessionEpoch && requestSequence === antigravitySettingsRequestSequence;
    const focused = document.activeElement;
    const restoreFocus = (focused?.dataset.agyConfig || focused?.dataset.agyConfigChoice) === String(id);
    antigravitySettingsPending = true;
    applyAntigravityState({});
    try {
        const data = await antigravityRequest('settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [id]: value }) }, sessionId);
        if (isCurrent() && data.state) applyAntigravityState(data.state);
    } catch (error) { if (isCurrent()) showAppToast(error.message); }
    finally {
        if (isCurrent()) {
            antigravitySettingsPending = false;
            applyAntigravityState({});
            if (restoreFocus && focused.isConnected && !focused.disabled
                && (document.activeElement === document.body || document.activeElement === focused)) focused.focus({ preventScroll: true });
        }
    }
}
function abortAntigravitySession() {
    if (antigravityState.canAbort && antigravitySend({ type: 'antigravity-abort', expectedTurnId: antigravityState.turnId })) applyAntigravityState({ status: 'stopping', canSteer: false, canAbort: false });
}
function requestAntigravityStatus() { antigravitySend({ type: 'antigravity-status' }); }
async function compactAntigravityContext() {
    if (!antigravityReadyForInput() || !antigravityState.canCompact) return;
    const sessionId = activeSessionId;
    document.getElementById('antigravity-compact-btn').disabled = true;
    try { await antigravityRequest('compact', { method: 'POST' }, sessionId); }
    catch (error) { if (sessionId === activeSessionId) showAppToast(error.message); }
    finally { if (sessionId === activeSessionId) applyAntigravityState({}); }
}
function respondAntigravityPermission(id, optionId) {
    const request = antigravityPendingPermissions.find(item => String(item.id) === String(id) && item.status === 'pending');
    if (!request || !(request.options || []).some(option => String(option.optionId ?? option.id) === String(optionId))) return;
    antigravitySend({ type: 'antigravity-permission', id, optionId });
}
function focusAntigravityApproval(id) {
    id = id || antigravityPendingPermissions.find(item => item.status === 'pending')?.id;
    if (!id) return;
    const host = document.getElementById('antigravity-chat-container');
    const target = Array.from(host.querySelectorAll('[data-agy-permission]')).find(item => !id || item.dataset.agyPermission === String(id));
    if (target) {
        for (let ancestor = target; ancestor && ancestor !== host; ancestor = ancestor.parentElement) {
            if (ancestor instanceof HTMLDetailsElement) { ancestor.open = true; rememberAntigravityDisclosure(ancestor, true); }
        }
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.querySelector('button')?.focus({ preventScroll: true });
    }
}
function focusAntigravityQuestion() {
    const target = document.querySelector('#antigravity-chat-container [data-agy-question-status="pending"]');
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.querySelector('input, textarea, button')?.focus({ preventScroll: true });
}
function antigravityContext(state) {
    if (state.context?.remainingTokens !== undefined) return state.context;
    if (Number(state.context?.maxTokens) > 0 && state.context.usedTokens !== undefined) {
        return { ...state.context, remainingTokens: Math.max(0, Number(state.context.maxTokens) - Number(state.context.usedTokens)) };
    }
    const usage = state.usage || {};
    if (Number(usage.size) > 0 && Number.isFinite(Number(usage.used))) {
        return { contextWindow: Number(usage.size), remainingTokens: Math.max(0, Number(usage.size) - Number(usage.used)) };
    }
    return usage;
}
function renderAntigravityStatus(item) {
    const data = item.statusData || {};
    const context = item.context || antigravityContext({ usage: data.context });
    const quota = data.quota;
    const groups = Array.isArray(quota?.groups) ? quota.groups : [];
    const quotaHtml = groups.map(group => `<section class="antigravity-quota-group"><h3>${escapeHtml(group.name || 'Usage')}</h3><div class="antigravity-quota-grid">${(group.buckets || []).map(bucket => {
        const remaining = Number(bucket.remaining_fraction);
        const available = !bucket.disabled && bucket.remaining_fraction != null && Number.isFinite(remaining);
        const percent = available ? Math.max(0, Math.min(100, Math.round(remaining * 100))) : 0;
        const label = bucket.disabled ? 'Unavailable' : bucket.remaining_fraction == null || !Number.isFinite(remaining)
            ? 'Usage unavailable' : `${percent}% remaining`;
        const reset = bucket.reset_time ? new Date(bucket.reset_time) : null;
        const name = bucket.name || bucket.window || 'Quota';
        return `<div class="antigravity-quota-row${available ? '' : ' unavailable'}"><div class="antigravity-quota-label"><span>${escapeHtml(name)}</span><strong>${escapeHtml(label)}</strong></div><div class="antigravity-quota-track"${available ? ` role="progressbar" aria-label="${escapeHtml(name)} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"` : ' aria-hidden="true"'}><span style="width:${percent}%"></span></div>${reset && Number.isFinite(reset.getTime()) ? `<small>Resets <time datetime="${reset.toISOString()}">${escapeHtml(reset.toLocaleString())}</time></small>` : ''}</div>`;
    }).join('') || '<p class="antigravity-status-empty">Usage unavailable</p>'}</div></section>`).join('');
    const contextHtml = renderAgentContextMeter(context);
    return `<details class="codex-status-card antigravity-status" data-agy-key="status-${escapeHtml(item.id)}" open><summary class="antigravity-status-summary"><span class="antigravity-status-icon"><svg class="action-icon" aria-hidden="true"><use href="#icon-usage"></use></svg></span><span class="antigravity-status-heading"><strong>${escapeHtml(item.title || 'Antigravity status')}</strong><small>Usage &amp; context</small></span><span class="antigravity-status-chevron" aria-hidden="true"></span></summary><div class="antigravity-status-body"><section class="antigravity-status-context"><h3>Context</h3>${contextHtml || '<p class="antigravity-status-empty">Available after the first usage update</p>'}</section>${quotaHtml || `<p class="antigravity-status-empty">${escapeHtml(quota?.error || 'Quota information is unavailable.')}</p>`}</div></details>`;
}
function renderAntigravityDiff(text) {
    return `<div class="codex-diff">${String(text || '').split('\n').map(line => `<div class="codex-diff-line ${line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}">${escapeHtml(line || ' ')}</div>`).join('')}</div>`;
}
// Disclosure choices belong to the local view, not the native conversation state.
const antigravityDisclosureChoices = new Map();
function antigravityDisclosureKey(details) {
    return details.dataset.agyKey || details.dataset.agyPermission || details.dataset.codexKey || '';
}
function antigravityDisclosureChoiceKey(details) {
    return `${activeSessionId || ''}:${antigravityState.nativeConversationId || antigravityState.antigravitySessionId || ''}:${antigravityDisclosureKey(details)}`;
}
function rememberAntigravityDisclosure(details, open) {
    if (!antigravityDisclosureKey(details)) return;
    antigravityDisclosureChoices.set(antigravityDisclosureChoiceKey(details), open);
    if (antigravityDisclosureChoices.size > 2000) antigravityDisclosureChoices.delete(antigravityDisclosureChoices.keys().next().value);
}
function renderAntigravityInlinePermission(request, interactive) {
    const pending = request.status === 'pending';
    const result = { approved: 'Approved', approved_for_session: 'Allowed for session', denied: 'Denied', abort: 'Stopped', cancelled: 'Cancelled' };
    const label = pending ? 'Approval required' : result[request.status] || request.decision || request.status || 'Resolved';
    const detail = request.reason || antigravityJson(request.input || '');
    const actions = pending ? `<div class="claude-permission-actions">${(request.options || []).map(option => `<button type="button" class="small-btn${String(option.kind || '').startsWith('reject') ? ' danger' : ' primary'}" data-agy-permission-option="${escapeHtml(option.optionId ?? option.id)}"${interactive ? '' : ' disabled'}>${escapeHtml(option.name || option.label || option.optionId || option.id)}</button>`).join('')}</div>` : `<div class="codex-permission-result">${escapeHtml(label)}</div>`;
    return `<details class="codex-inline-permission antigravity-permission${pending ? '' : ' antigravity-permission-resolved'}" data-agy-key="permission-${escapeHtml(request.id)}" data-agy-permission="${escapeHtml(request.id)}" data-agy-permission-state="${escapeHtml(request.status || '')}"${pending ? ' open' : ''}><summary class="codex-inline-permission-summary"><strong title="${escapeHtml(request.title || request.toolName || 'Tool permission')}">${escapeHtml(request.title || request.toolName || 'Tool permission')}</strong><span class="codex-permission-summary-state">${escapeHtml(label)}</span></summary><div class="codex-inline-permission-body">${detail ? `<pre class="codex-tool-code">${escapeHtml(detail)}</pre>` : ''}${actions}</div></details>`;
}
function renderAntigravityTool(item, interactive = true, permissions = []) {
    const text = item.result ?? item.output ?? item.rawOutput ?? item.text;
    const nativeDiffs = (Array.isArray(item.content) ? item.content : []).filter(content => content.type === 'diff');
    const changes = item.changes || item.input?.changes || nativeDiffs;
    const entries = Array.isArray(changes) ? changes.map(change => [change.path || 'File', change]) : Object.entries(changes || {});
    const content = entries.map(([path, change]) => `<details class="codex-patch-file" data-agy-key="diff-${escapeHtml(item.id)}-${escapeHtml(path)}"><summary><span class="path">${escapeHtml(path)}</span></summary>${renderAntigravityDiff(change.diff || change.unified_diff || `${String(change.oldText || change.oldContent || '').split('\n').map(line => '-' + line).join('\n')}\n${String(change.newText || change.newContent || '').split('\n').map(line => '+' + line).join('\n')}`)}</details>`).join('');
    const pending = permissions.some(request => request.status === 'pending');
    const status = item.toolStatus || item.status || 'running';
    const title = item.title || item.name || item.toolName || 'Tool';
    return `<details class="codex-tool antigravity-tool${['failed', 'denied'].includes(status) || item.error ? ' error' : ''}" data-agy-key="tool-${escapeHtml(item.id)}" data-agy-message-id="${escapeHtml(item.id)}"${pending ? ' open' : ''}><summary class="codex-tool-header"><span class="codex-tool-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="codex-tool-command">${escapeHtml(item.command || '')}</span><span class="codex-tool-state">${escapeHtml(status === 'completed' ? '' : status)}</span></summary><div class="codex-tool-body">${item.input || item.rawInput ? `<pre class="codex-tool-code">${escapeHtml(antigravityJson(item.input || item.rawInput))}</pre>` : ''}${content}${text ? `<pre class="codex-tool-code">${escapeHtml(antigravityJson(text))}</pre>` : ''}${item.hasDetail && !item.detailLoaded ? `<button class="small-btn" data-agy-detail="${escapeHtml(item.id)}"${interactive ? '' : ' disabled'}>Load details</button>` : ''}</div>${permissions.map(request => renderAntigravityInlinePermission(request, interactive)).join('')}</details>`;
}
function renderAntigravityQuestionField(item, question, index, editable) {
    const key = question.id || question.key || String(index);
    const label = question.question || question.header || question.label || key;
    const value = item.answers?.[key] ?? question.default ?? '';
    const choices = question.type === 'boolean' && !(question.options || []).length
        ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : question.options || [];
    const attributes = `name="${escapeHtml(key)}" aria-label="${escapeHtml(label)}"${editable ? '' : ' disabled'}`;
    let field;
    if (choices.length) {
        field = `<select ${attributes}>${choices.map(choice => `<option value="${escapeHtml(choice.value ?? choice.label ?? choice.id)}"${String(value) === String(choice.value ?? choice.label ?? choice.id) ? ' selected' : ''}>${escapeHtml(choice.label ?? choice.name ?? choice.value ?? choice.id)}</option>`).join('')}</select>`;
    } else if (['integer', 'number'].includes(question.type)) {
        field = `<input type="number" step="${question.type === 'integer' ? '1' : 'any'}" ${attributes} value="${escapeHtml(value)}">`;
    } else {
        field = `<textarea ${attributes}>${escapeHtml(value)}</textarea>`;
    }
    return `<label class="antigravity-question-field"><span>${escapeHtml(label)}</span>${field}</label>`;
}
function renderAntigravityQuestion(item, interactive) {
    const pending = item.questionStatus === 'pending';
    return `<form class="claude-tool claude-tool-card antigravity-question" data-agy-question="${escapeHtml(item.id)}" data-agy-question-status="${escapeHtml(item.questionStatus)}"><strong>${escapeHtml(item.title || item.text || 'Antigravity question')}</strong>${(item.questions || []).map((question, index) => renderAntigravityQuestionField(item, question, index, pending && interactive)).join('')}${pending ? `<div class="claude-permission-actions"><button type="submit" class="small-btn primary"${interactive ? '' : ' disabled'}>Submit answer</button><button type="button" class="small-btn" data-agy-question-cancel${interactive ? '' : ' disabled'}>Cancel question</button></div>` : `<span>${escapeHtml(item.questionStatus || 'Answered')}</span>`}</form>`;
}
async function respondAntigravityQuestion(form, action) {
    const id = form.dataset.agyQuestion;
    const answers = Object.fromEntries(new FormData(form).entries());
    const question = antigravityMessages.find(item => String(item.id) === id);
    for (const field of question?.questions || []) {
        const key = field.id || field.key;
        if (field.type === 'boolean') answers[key] = answers[key] === 'true';
        if (['number', 'integer'].includes(field.type)) {
            if (String(answers[key] ?? '').trim() === '') delete answers[key];
            else answers[key] = Number(answers[key]);
        }
    }
    const sessionId = activeSessionId;
    form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await antigravityRequest('user-input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answers, action }) }, sessionId); }
    catch (error) { showAppToast(error.message); if (sessionId === activeSessionId) form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function renderAntigravityCompaction(item) {
    const status = String(item.compactionStatus || item.status || '');
    const phase = ['running', 'in_progress', 'pending'].includes(status) ? 'running'
        : status === 'completed' ? 'completed' : ['failed', 'error'].includes(status) ? 'failed'
            : ['cancelled', 'canceled'].includes(status) ? 'cancelled' : 'ended';
    const titles = { running: 'Compacting context', completed: 'Context compacted', failed: 'Compaction failed', cancelled: 'Compaction stopped', ended: 'Compaction ended' };
    const timestamp = Number(item.completedAtMs || item.updatedAt || item.createdAt || 0);
    const date = timestamp > 0 ? new Date(timestamp) : null;
    const time = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const description = phase === 'running' || !/^Compacting\b/i.test(item.text || '') ? item.text || '' : '';
    return `<div class="codex-compaction-card antigravity-compaction-card${phase === 'running' ? ' running' : ''}" data-agy-key="compaction-${escapeHtml(item.id || '')}" data-agy-compaction-phase="${phase}" role="status"><span class="codex-compaction-icon" aria-hidden="true">⇣</span><div><div class="codex-compaction-title">${titles[phase]}</div><div class="codex-compaction-meta">${escapeHtml([description, time].filter(Boolean).join(' · '))}</div></div></div>`;
}
function antigravityTurnKey(item) {
    return `${item.threadId || ''}:${item.turnId || ''}`;
}
function antigravityPermissionLayout(messages, permissions) {
    const byTool = new Map();
    const before = new Map();
    const tools = messages.filter(item => item.kind === 'tool');
    for (const request of permissions) {
        const providerId = String(request.toolUseId || request.toolCallId || request.providerId || request.id || '');
        const sameTurn = item => (!request.turnId || String(item.turnId || '') === String(request.turnId))
            && (!request.threadId || !item.threadId || String(item.threadId) === String(request.threadId));
        const candidates = tools.filter(item => sameTurn(item)
            && [item.id, item.providerId, item.toolUseId].some(id => id != null && String(id) === providerId));
        const tool = candidates[candidates.length - 1];
        if (tool) {
            if (!byTool.has(tool)) byTool.set(tool, []);
            byTool.get(tool).push(request);
            continue;
        }
        // Old snapshots may omit a tool association. Keep its audit in its turn,
        // before the reply, rather than placing completed approvals after all replies.
        const owned = messages.map((item, index) => ({ item, index })).filter(({ item }) => sameTurn(item));
        const timestamp = Number(request.createdAt || 0);
        const preceding = owned.filter(({ item }) => ['tool', 'reasoning', 'task-plan'].includes(item.kind)
            && (!timestamp || Number(item.createdAt || 0) <= timestamp));
        const reply = owned.find(({ item }) => item.kind === 'assistant' && (!timestamp || Number(item.createdAt || 0) >= timestamp));
        const boundary = owned.find(({ item }) => item.kind === 'turn-end');
        const index = preceding.length ? preceding[preceding.length - 1].index + 1
            : reply?.index ?? boundary?.index ?? (owned.length ? owned[owned.length - 1].index + 1 : 0);
        if (!before.has(index)) before.set(index, []);
        before.get(index).push({ kind: 'permission-audit', id: `permission-${request.id}`, turnId: request.turnId, threadId: request.threadId, request });
    }
    return { byTool, before };
}
function renderAntigravityReasoning(item, interactive, markdownOptions) {
    const html = renderMarkdown(item.text || '', markdownOptions);
    return `<details class="antigravity-reasoning" data-agy-key="reasoning-${escapeHtml(item.id)}" data-agy-message-id="${escapeHtml(item.id)}"><summary>Thinking</summary><div class="claude-md">${window.gladConversationPages?.body(item, html, interactive) || html}${item.hasDetail && !item.detailLoaded ? `<button class="small-btn" data-agy-detail="${escapeHtml(item.id)}"${interactive ? '' : ' disabled'}>Load details</button>` : ''}</div></details>`;
}
function renderAntigravityPlan(item, state, turnEnd) {
    const plan = (item.plan || item.steps || []).map(step => ({ ...step, step: step.step || step.content,
        status: step.status === 'in_progress' ? 'inProgress' : step.status }));
    return renderAgentPlan({ ...item, plan, planTurnStatus: turnEnd?.turnStatus || turnEnd?.status
        || (state.turnId === item.turnId && state.canAbort ? 'running' : item.planTurnStatus) },
    { label: 'Tasks', keyPrefix: 'antigravity-plan', initiallyOpen: true });
}
function renderAntigravityWorkGroup(items, permissionsByTool, state, turnEnd, interactive, markdownOptions) {
    const first = items[0];
    const active = !turnEnd && ['running', 'thinking', 'waiting_approval', 'waiting_input', 'stopping'].includes(state.status)
        && (!state.turnId || String(state.turnId) === String(first.turnId));
    const endStatus = turnEnd?.turnStatus || turnEnd?.status || '';
    const failed = endStatus === 'failed' || items.some(item => ['failed', 'error'].includes(item.toolStatus || item.status));
    const phase = active ? 'running' : ['cancelled', 'canceled'].includes(endStatus) ? 'cancelled' : failed ? 'failed' : 'ended';
    const tools = items.filter(item => item.kind === 'tool');
    const plans = items.filter(item => item.kind === 'task-plan');
    const permissions = items.flatMap(item => item.kind === 'permission-audit' ? [item.request] : permissionsByTool.get(item) || []);
    const label = active ? tools.length || plans.length ? 'Working' : 'Thinking'
        : phase === 'cancelled' ? 'Work stopped' : phase === 'failed' ? 'Work finished with errors' : tools.length || plans.length ? 'Worked' : 'Thought';
    const summary = [label,
        ...(tools.length ? [`${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`] : []),
        ...(plans.length ? [`${plans.length} ${plans.length === 1 ? 'plan' : 'plans'}`] : []),
        ...(permissions.some(request => request.status === 'denied') ? ['Approval denied'] : [])].join(' · ');
    const history = [];
    const pending = [];
    for (const item of items) {
        const requests = item.kind === 'permission-audit' ? [item.request] : permissionsByTool.get(item) || [];
        const awaiting = requests.some(request => request.status === 'pending');
        let html = '';
        if (item.kind === 'tool') html = renderAntigravityTool(item, interactive, requests);
        if (item.kind === 'reasoning') html = renderAntigravityReasoning(item, interactive, markdownOptions);
        if (item.kind === 'task-plan') html = renderAntigravityPlan(item, state, turnEnd);
        if (item.kind === 'permission-audit') html = renderAntigravityInlinePermission(item.request, interactive);
        (awaiting ? pending : history).push(html);
    }
    const ids = items.filter(item => item.hasDetail).map(item => item.id);
    // A permission inserted before existing work must not replace its DOM anchor.
    const anchor = items.find(item => item.kind !== 'permission-audit') || first;
    const key = `workgroup-${anchor.turnId || 'history'}-${anchor.id || anchor.providerId || ''}`;
    return `<div class="antigravity-work-segment" data-agy-key="segment-${escapeHtml(key)}" data-agy-turn-id="${escapeHtml(first.turnId || '')}"><details class="codex-work-group antigravity-work-group" data-agy-key="${escapeHtml(key)}" data-agy-work-phase="${phase}"${ids.length ? ` data-agy-detail-ids="${escapeHtml(JSON.stringify(ids))}"` : ''}><summary>${escapeHtml(summary)}</summary><div class="codex-work-group-body">${history.join('')}</div></details>${pending.length ? `<div class="antigravity-pending-work">${pending.join('')}</div>` : ''}</div>`;
}
function renderAntigravityMessageTime(item) {
    if (item.kind === 'assistant' && item.streaming) return '';
    // A native replay may know when a message started without knowing when its
    // last token arrived. updatedAt is a replay/detail clock and is never used.
    const completedAt = item.kind === 'assistant' ? Number(item.completedAtMs) : NaN;
    const completed = Number.isFinite(completedAt) && completedAt > 0 && Number.isFinite(new Date(completedAt).getTime());
    const timestamp = completed ? completedAt : Number(item.createdAt);
    const date = new Date(timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(date.getTime())) {
        return '<span class="codex-message-time antigravity-message-time" data-agy-time-unknown="true" title="The original message time was not reported">Time unknown</span>';
    }
    const label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const description = item.kind === 'assistant' ? completed ? 'Completed at' : 'Message started at' : 'Message sent at';
    return `<time class="codex-message-time antigravity-message-time" datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(`${description} ${date.toLocaleString()}`)}">${escapeHtml(label)}</time>`;
}
function renderAntigravityMessageMeta(item, context = null) {
    const time = renderAntigravityMessageTime(item);
    const meter = renderAgentContextMeter(context);
    return time || meter ? `<div class="codex-message-meta antigravity-message-meta">${time}${meter}</div>` : '';
}
function buildAntigravityConversationHtml(messages = antigravityMessages, permissions = antigravityPendingPermissions, state = antigravityState, markdownOptions = {}) {
    const interactive = messages === antigravityMessages;
    const { byTool, before } = antigravityPermissionLayout(messages, permissions);
    const turnEnds = new Map(messages.filter(item => item.kind === 'turn-end').map(item => [antigravityTurnKey(item), item]));
    const lastAssistantByTurn = new Map();
    for (const item of messages) if (item.kind === 'assistant') lastAssistantByTurn.set(antigravityTurnKey(item), item);
    const entries = [];
    for (let index = 0; index <= messages.length; index++) {
        entries.push(...(before.get(index) || []));
        if (index < messages.length) entries.push(messages[index]);
    }
    const parts = [];
    let operations = [];
    const flush = () => {
        if (!operations.length) return;
        parts.push(renderAntigravityWorkGroup(operations, byTool, state, turnEnds.get(antigravityTurnKey(operations[0])), interactive, markdownOptions));
        operations = [];
    };
    for (const item of entries) {
        if (['reasoning', 'tool', 'task-plan', 'permission-audit'].includes(item.kind)) {
            if (operations.length && antigravityTurnKey(operations[0]) !== antigravityTurnKey(item)) flush();
            operations.push(item);
            continue;
        }
        flush();
        if (['turn-start', 'turn-end'].includes(item.kind)) continue;
        if (item.kind === 'question') { const html = renderAntigravityQuestion(item, interactive); parts.push(window.gladConversationPages?.body(item, html, interactive) || html); continue; }
        if (item.kind === 'status') { parts.push(renderAntigravityStatus(item)); continue; }
        if (item.kind === 'compaction') { const html = renderAntigravityCompaction(item); parts.push(window.gladConversationPages?.body(item, html, interactive) || html); continue; }
        const kind = item.kind === 'user' || item.kind === 'assistant' ? item.kind : 'event';
        const context = kind === 'assistant' && lastAssistantByTurn.get(antigravityTurnKey(item)) === item
            ? turnEnds.get(antigravityTurnKey(item))?.context : null;
        const attachments = (item.attachments || []).map(attachment => `<span class="claude-message-attachment">${escapeHtml(attachment.name || 'Attachment')}</span>`).join('');
        if (kind === 'event') {
            const error = item.level === 'error' || item.kind === 'error';
            const html = escapeHtml(item.text || '').replace(/\n/g, '<br>');
            parts.push(`<div class="codex-message event${error ? ' error' : ''}" data-agy-key="message-${escapeHtml(item.id)}">${window.gladConversationPages?.body(item, html, interactive) || html}${renderAntigravityMessageMeta(item)}</div>`);
        } else {
            parts.push(`<div class="codex-message-block ${kind}" data-agy-key="message-${escapeHtml(item.id)}"><div class="codex-message ${kind} claude-md">${window.gladConversationPages ? window.gladConversationPages.body(item, renderMarkdown(item.text || '', markdownOptions), messages === antigravityMessages) : renderMarkdown(item.text || '', markdownOptions)}${attachments ? `<div class="claude-message-attachments">${attachments}</div>` : ''}</div>${renderAntigravityMessageMeta(item, context)}</div>`);
        }
    }
    flush();
    if (state.status === 'running') parts.push('<div class="codex-working-indicator" role="status" aria-label="Antigravity is working"></div>');
    return `<div class="codex-conversation antigravity-conversation">${window.gladConversationPages ? window.gladConversationPages.header('antigravity', messages) : ''}${parts.join('') || '<div class="codex-message event">Send a message to start Antigravity.</div>'}</div>`;
}
function antigravityDomKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const key = node.getAttribute('data-agy-key') || node.getAttribute('data-agy-permission') || node.getAttribute('data-codex-key');
    if (key) return `${node.nodeName}:${key}`;
    const question = node.getAttribute('data-agy-question');
    if (question) return `question:${question}`;
    if (node.matches('input[name], select[name], textarea[name]')) return `field:${node.nodeName}:${node.name}`;
    if (node.classList.contains('markdown-diagram')) return `diagram:${node.getAttribute('data-diagram-source')}`;
    return '';
}
function syncAntigravityDom(current, next) {
    if (gladMarkdownRich.preserveDiagram(current, next)) return current;
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName
        || antigravityDomKey(current) !== antigravityDomKey(next)) {
        const replacement = next.cloneNode(true);
        current.replaceWith(replacement);
        return replacement;
    }
    if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return current;
    }
    // Native details and diagram Source disclosures are local UI state.
    const preserveOpen = current.nodeName === 'DETAILS';
    for (const attribute of Array.from(current.attributes || [])) {
        if (!next.hasAttribute(attribute.name) && !(preserveOpen && attribute.name === 'open')) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes || [])) {
        if (!(preserveOpen && attribute.name === 'open') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    const nextChildren = Array.from(next.childNodes);
    const nextKeys = new Set(nextChildren.map(antigravityDomKey).filter(Boolean));
    // Remove obsolete keyed siblings first, so inserting/removing a work group
    // does not move an unchanged reply (and the user's text selection with it).
    for (const child of Array.from(current.childNodes)) {
        const key = antigravityDomKey(child);
        if (key && !nextKeys.has(key)) child.remove();
    }
    const keyed = new Map();
    for (const child of Array.from(current.childNodes)) {
        const key = antigravityDomKey(child);
        if (!key) continue;
        if (!keyed.has(key)) keyed.set(key, []);
        keyed.get(key).push(child);
    }
    const retained = new Set();
    let cursor = current.firstChild;
    for (const nextChild of nextChildren) {
        const key = antigravityDomKey(nextChild);
        let child = key ? keyed.get(key)?.find(node => !retained.has(node))
            : cursor && !antigravityDomKey(cursor) ? cursor : null;
        if (!child) {
            child = nextChild.cloneNode(true);
            current.insertBefore(child, cursor);
        } else {
            if (child !== cursor) current.insertBefore(child, cursor);
            child = syncAntigravityDom(child, nextChild);
        }
        retained.add(child);
        cursor = child.nextSibling;
    }
    for (const child of Array.from(current.childNodes)) if (!retained.has(child)) child.remove();
    return current;
}
function requestAntigravityGroupDetails(details) {
    if (!details.open || !details.dataset.agyDetailIds) return;
    let ids = [];
    try { ids = JSON.parse(details.dataset.agyDetailIds); } catch (_) {}
    for (const id of ids) {
        const item = antigravityMessages.find(item => String(item.id) === String(id));
        if (item?.hasDetail && !item.detailLoaded) requestAntigravityDetails(item.id);
    }
}
function installAntigravityTranscriptHandlers(host) {
    if (host.dataset.disclosureHandlers === 'true') return;
    host.dataset.disclosureHandlers = 'true';
    host.addEventListener('click', event => {
        const summary = event.target.closest('summary');
        if (summary?.parentElement instanceof HTMLDetailsElement) rememberAntigravityDisclosure(summary.parentElement, !summary.parentElement.open);
    });
    host.addEventListener('toggle', event => {
        const details = event.target;
        if (details instanceof HTMLDetailsElement) requestAntigravityGroupDetails(details);
    }, true);
}
function renderAntigravityChat() {
    if (antigravityRenderFrame !== null) return;
    antigravityRenderFrame = requestAnimationFrame(() => {
        antigravityRenderFrame = null;
        if (!isAntigravitySession()) return;
        const host = document.getElementById('antigravity-chat-container');
        installAntigravityTranscriptHandlers(host);
        const bottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
        const scrollTop = host.scrollTop;
        const previous = new Map(Array.from(host.querySelectorAll('details')).filter(item => antigravityDisclosureKey(item)).map(item => [antigravityDisclosureKey(item), { open: item.open, permissionState: item.dataset.agyPermissionState || '' }]));
        const drafts = new Map(Array.from(host.querySelectorAll('[data-agy-question]')).map(form => [form.dataset.agyQuestion, Object.fromEntries(new FormData(form))]));
        const focused = document.activeElement;
        const focusQuestion = focused?.closest('[data-agy-question]')?.dataset.agyQuestion;
        const focusName = focused?.name;
        const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
        const template = document.createElement('template');
        template.innerHTML = buildAntigravityConversationHtml();
        const next = template.content.firstElementChild;
        if (host.firstElementChild) syncAntigravityDom(host.firstElementChild, next);
        else host.appendChild(next);
        host.querySelectorAll('details').forEach(item => {
            const key = antigravityDisclosureKey(item);
            if (!key) return;
            const choice = antigravityDisclosureChoiceKey(item);
            const old = previous.get(key);
            const resolvedApproval = old?.permissionState === 'pending' && item.dataset.agyPermissionState !== 'pending' && item.hasAttribute('data-agy-permission');
            if (resolvedApproval) { item.open = false; antigravityDisclosureChoices.delete(choice); }
            else if (antigravityDisclosureChoices.has(choice)) item.open = antigravityDisclosureChoices.get(choice);
            else if (old && old.permissionState === (item.dataset.agyPermissionState || '')) item.open = old.open;
        });
        host.querySelectorAll('[data-agy-question]').forEach(form => { const draft = drafts.get(form.dataset.agyQuestion); if (draft) for (const field of form.elements) if (field.name && draft[field.name] !== undefined && field.value !== draft[field.name]) field.value = draft[field.name]; });
        if (focusQuestion && focusName) {
            const form = Array.from(host.querySelectorAll('[data-agy-question]')).find(form => form.dataset.agyQuestion === focusQuestion);
            const field = form && Array.from(form.elements).find(field => field.name === focusName);
            if (field && document.activeElement !== field) field.focus({ preventScroll: true });
            if (field && selection && typeof field.setSelectionRange === 'function'
                && (field.selectionStart !== selection[0] || field.selectionEnd !== selection[1])) field.setSelectionRange(...selection);
        }
        host.querySelectorAll('details[open][data-agy-detail-ids]').forEach(requestAntigravityGroupDetails);
        gladMarkdownRich.renderDiagrams(host);
        host.scrollTop = bottom ? host.scrollHeight : scrollTop;
        window.gladAntigravitySubagents?.sync();
    });
}
async function toggleAntigravityResumePanel() {
    const panel = document.getElementById('antigravity-resume-panel');
    const open = panel.hidden;
    closeAntigravityActionPanels();
    panel.hidden = !open;
    document.getElementById('antigravity-resume-btn').setAttribute('aria-expanded', String(open));
    if (panel.hidden) return;
    panel.innerHTML = 'Loading conversations…';
    updateTerminalControlsHeight();
    const sessionId = activeSessionId;
    try {
        const data = await antigravityRequest('resume-sessions', {}, sessionId);
        if (sessionId !== activeSessionId) return;
        panel.innerHTML = `<strong>Resume Antigravity conversation</strong>${(data.items || []).map(item => `<div class="antigravity-history-row"><span>${escapeHtml(item.title || item.id || item.sessionId)}<small>${escapeHtml(item.cwd || '')}</small></span><button class="small-btn" data-agy-preview="${escapeHtml(item.sessionId || item.id)}">Preview</button><button class="small-btn primary" data-agy-resume="${escapeHtml(item.sessionId || item.id)}">Resume</button></div>`).join('') || '<p>No saved conversations.</p>'}<div id="antigravity-history-preview"></div>`;
    } catch (error) { if (sessionId === activeSessionId) panel.textContent = error.message; }
    updateTerminalControlsHeight();
}
async function previewAntigravitySession(id) {
    const sessionId = activeSessionId;
    const sessionEpoch = antigravitySessionEpoch;
    const requestSequence = ++antigravityPreviewRequestSequence;
    const panel = document.getElementById('antigravity-resume-panel');
    panel.dataset.previewId = id;
    const isCurrent = () => isAntigravitySession() && sessionId === activeSessionId
        && sessionEpoch === antigravitySessionEpoch && requestSequence === antigravityPreviewRequestSequence
        && panel.dataset.previewId === id && !panel.hidden;
    try {
        const data = await antigravityRequest(`session-preview?sessionId=${encodeURIComponent(id)}&history=tail`, {}, sessionId);
        if (!isCurrent()) return;
        const preview = document.getElementById('antigravity-history-preview');
        if (!preview) return;
        const label = ['native-log-tail', 'native-log'].includes(data.historySource) ? `<p class="codex-lazy-detail">Recent native log preview${data.partial ? ' · partial history' : ''}</p>` : '';
        preview.innerHTML = label + buildAntigravityConversationHtml(data.messages || [], [], {}, { sessionId });
        gladMarkdownRich.renderDiagrams(preview);
    } catch (error) { if (isCurrent()) showAppToast(error.message); }
}
async function resumeAntigravitySession(id) {
    if (!antigravityReadyForInput()) return;
    const sessionId = activeSessionId;
    antigravityResumePending = true;
    applyAntigravityState({});
    try {
        const data = await antigravityRequest('resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }, sessionId);
        if (sessionId !== activeSessionId) return;
        document.getElementById('antigravity-resume-panel').hidden = true;
        if (data.state) applyAntigravityState(data.state);
    } catch (error) { showAppToast(error.message); }
    finally { if (sessionId === activeSessionId) { antigravityResumePending = false; applyAntigravityState({}); } }
}
async function toggleAntigravityCommands() {
    const panel = document.getElementById('antigravity-command-panel');
    const open = panel.hidden;
    closeAntigravityActionPanels();
    panel.hidden = !open;
    document.getElementById('antigravity-commands-btn').setAttribute('aria-expanded', String(open));
    if (panel.hidden) return;
    panel.textContent = 'Loading commands…';
    updateTerminalControlsHeight();
    const sessionId = activeSessionId;
    try {
        const data = await antigravityRequest('commands', {}, sessionId);
        if (sessionId !== activeSessionId) return;
        panel.innerHTML = (data.items || []).map(command => `<button class="small-btn" data-agy-command="${escapeHtml(command.name || command.command)}" title="${escapeHtml(command.description || '')}">/${escapeHtml(command.name || command.command)}</button>`).join('') || 'No commands available.';
    } catch (error) { if (sessionId === activeSessionId) panel.textContent = error.message; }
    updateTerminalControlsHeight();
}
document.addEventListener('change', event => {
    if (event.target.matches('[data-agy-config]')) void updateAntigravitySetting(event.target.dataset.agyConfig, event.target.value);
});
document.addEventListener('submit', event => {
    if (!event.target.matches('[data-agy-question]')) return;
    event.preventDefault();
    if (event.target.closest('#antigravity-chat-container')) void respondAntigravityQuestion(event.target, 'accept');
});
document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !isAntigravitySession()) return;
    if (button.hasAttribute('data-agy-permission-option')) respondAntigravityPermission(button.closest('[data-agy-permission]').dataset.agyPermission, button.dataset.agyPermissionOption);
    if (button.hasAttribute('data-agy-question-cancel')) void respondAntigravityQuestion(button.closest('form'), 'cancel');
    if (button.hasAttribute('data-agy-detail')) requestAntigravityDetails(button.dataset.agyDetail);
    if (button.hasAttribute('data-agy-preview')) void previewAntigravitySession(button.dataset.agyPreview);
    if (button.hasAttribute('data-agy-resume')) void resumeAntigravitySession(button.dataset.agyResume);
    if (button.hasAttribute('data-agy-command')) { inputEl.value = '/' + button.dataset.agyCommand; inputEl.focus(); }
});

function requestAntigravityDetails(id) {
    for (const [key, request] of antigravityDetailRequests) if (request.until <= Date.now()) antigravityDetailRequests.delete(key);
    if (Array.from(antigravityDetailRequests.values()).some(pending => pending.id === id && pending.until > Date.now())) return;
    const requestId = crypto.randomUUID?.() || `agy-detail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (antigravitySend({ type: 'antigravity-detail-request', requestId, ids: [id] })) {
        antigravityDetailRequests.set(requestId, { id, until: Date.now() + 15000 });
    }
}
document.getElementById('antigravity-chat-container').addEventListener('toggle', event => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open || !details.dataset.agyMessageId) return;
    const item = antigravityMessages.find(item => String(item.id) === details.dataset.agyMessageId);
    if (item?.hasDetail && !item.detailLoaded) requestAntigravityDetails(item.id);
}, true);
