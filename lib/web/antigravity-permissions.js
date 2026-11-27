// Presets apply immediately only when the change is a native Mode switch.
// Process settings and rules share one draft and one reconnect operation.
let agyPermissionDocument = null;
let agyPermissionDraft = null;
let agyPermissionRulesDraft = null;
let agyPermissionScope = 'session';
let agyPermissionTab = 'policy';
let agyPermissionRuleKind = 'deny';
let agyPermissionLoadSequence = 0;
const agyPermissionKeys = ['toolPermission', 'enableTerminalSandbox', 'allowNonWorkspaceAccess', 'artifactReviewPolicy'];
const agyPermissionLabels = { 'request-review': 'Request review', 'proceed-in-sandbox': 'Proceed in sandbox', strict: 'Strict', 'always-proceed': 'Always proceed' };
const agyPermissionPresets = [
    { id: 'default', mode: 'default', tool: 'request-review', name: 'Default', short: 'Ask', detail: 'Review edits & commands' },
    { id: 'accept-edits', mode: 'accept-edits', tool: 'request-review', name: 'Accept edits', short: 'Edits', detail: 'Edit workspace files' },
    { id: 'auto', mode: 'auto', tool: 'request-review', name: 'Auto', short: 'Auto', detail: 'Sandbox + risk review' },
    { id: 'sandbox', mode: 'accept-edits', tool: 'proceed-in-sandbox', name: 'Proceed in sandbox', short: 'Sandbox', detail: 'Ask before running outside' },
    { id: 'plan', mode: 'plan', tool: 'request-review', name: 'Plan', short: 'Plan', detail: 'Plan first, not read-only' },
    { id: 'strict', tool: 'strict', name: 'Strict', short: 'Strict', detail: 'Ask for every tool' },
    { id: 'skip', mode: 'accept-edits', tool: 'always-proceed', name: 'Skip approvals', short: 'Skip', detail: 'Edit & run without asking' }
];
function resetAntigravityPermissions() {
    agyPermissionDocument = agyPermissionDraft = agyPermissionRulesDraft = null;
    agyPermissionLoadSequence += 1;
    agyPermissionScope = 'session'; agyPermissionTab = 'policy'; agyPermissionRuleKind = 'deny';
    document.getElementById('antigravity-permissions-panel').replaceChildren();
}
function agyPermissionModes() {
    const option = antigravityConfigOptions().find(option => option.category === 'mode' || option.id === 'mode');
    return option ? antigravityOptionValues(option) : [];
}
function agyPolicyPreset(mode, values) {
    if (values?.toolPermission === 'strict' || values?.toolPermission === 'always-proceed') return agyPermissionPresets.find(preset => preset.tool === values.toolPermission);
    return agyPermissionPresets.find(preset => preset.mode === mode && preset.tool === values?.toolPermission);
}
function agyPolicyDescription(mode, values) {
    const tool = values?.toolPermission;
    const auto = Boolean(values) && mode === 'auto' && !['strict', 'always-proceed'].includes(tool);
    const sandbox = auto ? 'Sandbox (Auto)' : values ? (values.enableTerminalSandbox ? 'Sandbox' : 'No sandbox') : 'Sandbox inherited';
    const preset = agyPolicyPreset(mode, values);
    const approval = preset?.name || (tool ? `Custom · ${agyPermissionLabels[tool] || mode}` : mode || 'Default');
    return { label: `${approval} · ${sandbox}`, short: preset?.short || (tool === 'strict' ? 'Strict' : 'Custom'), sandbox, tool, auto, preset };
}
function agyPermissionBaseline() {
    const baseline = { mode: String(agyPermissionDocument.mode || antigravityState.mode || 'default') };
    for (const key of agyPermissionKeys) baseline[key] = agyPermissionDocument.overrides?.[key] ?? 'inherit';
    return baseline;
}
function agyPermissionDraftValues() {
    return Object.fromEntries(agyPermissionKeys.map(key => [key, agyPermissionDraft[key] === 'inherit'
        ? (Object.prototype.hasOwnProperty.call(agyPermissionDocument.overrides || {}, key)
            ? (agyPermissionDocument.defaults?.[key] ?? agyPermissionDocument.values[key]) : agyPermissionDocument.values[key]) : agyPermissionDraft[key]]));
}
function agyPermissionHasDraft() {
    return Boolean(agyPermissionDocument && agyPermissionDraft && (JSON.stringify(agyPermissionBaseline()) !== JSON.stringify(agyPermissionDraft)
        || JSON.stringify(agyPermissionDocument.rules) !== JSON.stringify(agyPermissionRulesDraft)));
}
function agyPermissionNeedsReconnect() {
    return agyPermissionKeys.some(key => agyPermissionDraft[key] !== (agyPermissionDocument.overrides?.[key] ?? 'inherit'))
        || JSON.stringify(agyPermissionDocument.rules) !== JSON.stringify(agyPermissionRulesDraft);
}
function renderAntigravityPermissionsSummary() {
    scheduleAgyPermissionRailEdges();
    const button = document.getElementById('antigravity-mode-control');
    const active = antigravityState.permissionPolicy;
    const description = agyPolicyDescription(antigravityState.mode, active?.values);
    button.querySelector('.action-label').textContent = description.label;
    let short = button.querySelector('.agy-policy-short');
    if (!short) { short = document.createElement('span'); short.className = 'agy-policy-short'; short.setAttribute('aria-hidden', 'true'); button.appendChild(short); }
    short.textContent = description.short;
    button.title = `Permissions and sandbox: ${description.label}${active?.sandboxWarning ? ' · Sandbox error' : ''}`;
    button.setAttribute('aria-label', button.title);
    if (active?.sandboxWarning) button.querySelector('.action-label').textContent += ' · Sandbox error';
    button.dataset.approval = description.tool || 'inherited';
    button.dataset.sandbox = active?.values ? String(Boolean(active.values.enableTerminalSandbox || description.auto)) : 'inherited';
    button.dataset.sandboxError = String(Boolean(active?.sandboxWarning));
    const panel = document.getElementById('antigravity-permissions-panel');
    if (!agyPermissionDocument || panel.hidden || !panel.querySelector('[data-agy-policy-current]')) return;
    const ready = antigravityReadyForInput(), dirty = agyPermissionHasDraft();
    const preview = agyPolicyDescription(agyPermissionDraft.mode, agyPermissionDraftValues());
    panel.querySelectorAll('[data-agy-policy-toggle], [data-agy-rule-list], [data-agy-rule-prefix], [data-agy-preset]').forEach(control => { control.disabled = !ready; });
    const modes = agyPermissionModes().map(mode => mode.value ?? mode.id);
    panel.querySelectorAll('[data-agy-preset]').forEach(card => {
        const preset = agyPermissionPresets.find(preset => preset.id === card.dataset.agyPreset);
        card.disabled = !ready || Boolean(preset.mode && !modes.includes(preset.mode));
        card.setAttribute('aria-pressed', String(preview.preset?.id === preset.id));
        card.classList.toggle('selected', preview.preset?.id === preset.id);
    });
    const values = agyPermissionDraftValues();
    for (const key of agyPermissionKeys.filter(key => key !== 'toolPermission')) {
        const control = panel.querySelector(`[data-agy-policy-toggle="${key}"]`);
        const on = key === 'artifactReviewPolicy' ? values[key] !== 'always-proceed' : Boolean(values[key]);
        control.setAttribute('aria-checked', String(key === 'enableTerminalSandbox' && preview.auto ? true : on));
        control.textContent = control.getAttribute('aria-checked') === 'true' ? 'On' : 'Off';
        control.disabled = !ready || (key === 'enableTerminalSandbox' && preview.auto);
    }
    panel.querySelector('[data-agy-sandbox-auto]').hidden = !preview.auto;
    const current = panel.querySelector('[data-agy-policy-current]');
    current.textContent = `${dirty ? 'Current: ' : ''}${description.label}`;
    current.hidden = agyPermissionTab !== 'policy' || Boolean(description.preset);
    const note = panel.querySelector('[data-agy-policy-note]');
    note.textContent = active?.sandboxWarning ? 'Sandbox connection failed. See the tool output.' : !ready ? 'Available when the conversation is idle.' : '';
    note.hidden = agyPermissionTab !== 'policy' || !note.textContent;
    panel.querySelector('[data-agy-policy-footer]').hidden = !dirty && !antigravitySettingsPending;
    panel.querySelector('[data-agy-policy-apply]').disabled = !ready || !dirty;
    panel.querySelector('[data-agy-policy-apply]').textContent = antigravitySettingsPending ? 'Applying…' : agyPermissionNeedsReconnect() ? 'Apply and reconnect' : 'Apply mode';
    panel.querySelector('[data-agy-policy-cancel]').disabled = antigravitySettingsPending;
    panel.querySelector('[data-agy-policy-defaults]').disabled = !ready;
    panel.querySelector('[data-agy-policy-defaults]').hidden = agyPermissionTab !== 'policy';
    for (const option of panel.querySelector('[data-agy-rule-scope]').options) {
        const count = ['deny', 'ask', 'allow'].reduce((total, kind) => total + (agyPermissionRulesDraft[option.value][kind]?.length || 0), 0);
        option.textContent = `${option.dataset.label} (${count})`;
    }
}
async function toggleAntigravityPermissions() {
    const panel = document.getElementById('antigravity-permissions-panel'), open = panel.hidden;
    closeAntigravityActionPanels();
    panel.hidden = !open;
    document.getElementById('antigravity-mode-control').setAttribute('aria-expanded', String(open));
    if (open && (!agyPermissionDocument || !agyPermissionHasDraft())) await loadAntigravityPermissions();
    else renderAntigravityPermissionsSummary();
    updateTerminalControlsHeight();
}
function resetAgyPermissionDraft() {
    agyPermissionDraft = agyPermissionBaseline();
    agyPermissionRulesDraft = JSON.parse(JSON.stringify(agyPermissionDocument.rules));
    buildAntigravityPermissions();
}
async function loadAntigravityPermissions() {
    const sessionId = activeSessionId, epoch = antigravitySessionEpoch, sequence = ++agyPermissionLoadSequence;
    const panel = document.getElementById('antigravity-permissions-panel');
    panel.textContent = 'Loading permissions…';
    try {
        const data = await antigravityRequest('permissions', {}, sessionId);
        if (sessionId !== activeSessionId || epoch !== antigravitySessionEpoch || sequence !== agyPermissionLoadSequence) return;
        agyPermissionDocument = data;
        data.mode = String(antigravityState.mode || data.mode || 'default');
        resetAgyPermissionDraft();
    } catch (error) {
        if (sessionId === activeSessionId && epoch === antigravitySessionEpoch && sequence === agyPermissionLoadSequence) {
            panel.innerHTML = `<p role="alert">${escapeHtml(error.message)}</p><button type="button" class="small-btn" data-agy-policy-retry>Retry</button>`;
        }
    }
    updateTerminalControlsHeight();
}
function buildAntigravityPermissions() {
    const panel = document.getElementById('antigravity-permissions-panel');
    panel.innerHTML = `<div class="agy-policy-heading">
        <div class="agy-policy-tabs" role="tablist" aria-label="Permission settings"><button type="button" role="tab" id="agy-policy-tab" aria-controls="agy-policy-page" data-agy-policy-tab="policy">Policy</button><button type="button" role="tab" id="agy-rules-tab" aria-controls="agy-rules-page" data-agy-policy-tab="rules">Rules</button></div>
        <button type="button" class="agy-save-default" data-agy-policy-defaults>Save default</button>
        <button type="button" class="small-btn" data-agy-policy-close aria-label="Close permissions">✕</button></div>
        <p class="agy-policy-current" data-agy-policy-current hidden></p>
        <div id="agy-policy-page" role="tabpanel" aria-labelledby="agy-policy-tab">
          <div class="agy-policy-presets" role="group" aria-label="Permission presets">${agyPermissionPresets.map(preset => `<button type="button" class="antigravity-picker-option${preset.id === 'skip' ? ' agy-preset-skip' : ''}" data-agy-preset="${preset.id}" aria-pressed="false"><span class="agy-preset-radio" aria-hidden="true"></span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.detail)}</small></button>`).join('')}</div>
          <div class="agy-policy-switches">
            <div class="agy-sandbox-row"><span>Terminal sandbox <small data-agy-sandbox-auto hidden>Auto</small></span><button type="button" role="switch" aria-label="Terminal sandbox" aria-checked="false" data-agy-policy-toggle="enableTerminalSandbox">Off</button></div>
            <div class="agy-sandbox-row"><span>Outside workspace</span><button type="button" role="switch" aria-label="Outside workspace" aria-checked="false" data-agy-policy-toggle="allowNonWorkspaceAccess">Off</button></div>
            <div class="agy-sandbox-row"><span>Review plans</span><button type="button" role="switch" aria-label="Review plans" aria-checked="true" data-agy-policy-toggle="artifactReviewPolicy">On</button></div>
          </div>
        </div>
        <div id="agy-rules-page" role="tabpanel" aria-labelledby="agy-rules-tab" hidden>
          <label class="agy-rule-scope">Scope <select data-agy-rule-scope aria-label="Rule scope"><option value="session" data-label="This session">This session</option><option value="project" data-label="Project · Glad">Project · Glad</option><option value="shared" data-label="Shared · Glad">Shared · Glad</option><option value="global" data-label="Global · agy">Global · agy</option></select></label>
          <div class="agy-rule-kinds" role="tablist" aria-label="Rule priority">${['deny', 'ask', 'allow'].map(kind => `<button type="button" role="tab" id="agy-rule-tab-${kind}" aria-controls="agy-rule-page-${kind}" data-agy-rule-kind="${kind}">${kind[0].toUpperCase() + kind.slice(1)} <span data-agy-rule-count="${kind}">0</span></button>`).join('<span aria-hidden="true">›</span>')}</div>
          <div class="agy-rules-grid">${['deny', 'ask', 'allow'].map(kind => `<div role="tabpanel" id="agy-rule-page-${kind}" aria-labelledby="agy-rule-tab-${kind}" data-agy-rule-page="${kind}"><textarea data-agy-rule-list="${kind}" aria-label="${kind[0].toUpperCase() + kind.slice(1)} rules" spellcheck="false" placeholder="One action(target) per line"></textarea></div>`).join('')}</div>
          <div class="agy-rule-prefixes">${['command', 'read_file', 'write_file', 'read_url', 'mcp'].map(action => `<button type="button" class="small-btn" data-agy-rule-prefix="${action}">+ ${{command:'cmd',read_file:'read',write_file:'write',read_url:'url',mcp:'mcp'}[action]}</button>`).join('')}</div>
        </div>
        <p class="agy-policy-help agy-policy-warning" data-agy-policy-note role="status" hidden></p>
        <p class="agy-policy-error" data-agy-policy-error role="alert" hidden></p>
        <div class="agy-policy-footer" data-agy-policy-footer hidden><button type="button" class="small-btn" data-agy-policy-cancel>Cancel</button><button type="button" class="small-btn primary" data-agy-policy-apply>Apply and reconnect</button></div>`;
    panel.querySelector('[data-agy-rule-scope]').value = agyPermissionScope;
    showAgyPermissionTab(agyPermissionTab);
    showAgyPermissionRules();
    renderAntigravityPermissionsSummary();
}
function showAgyPermissionTab(tab) {
    agyPermissionTab = tab;
    const panel = document.getElementById('antigravity-permissions-panel');
    panel.querySelectorAll('[data-agy-policy-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.agyPolicyTab === tab)); });
    panel.querySelector('#agy-policy-page').hidden = tab !== 'policy';
    panel.querySelector('#agy-rules-page').hidden = tab !== 'rules';
    renderAntigravityPermissionsSummary();
    updateTerminalControlsHeight();
}
function showAgyPermissionRuleKind(kind) {
    agyPermissionRuleKind = kind;
    const panel = document.getElementById('antigravity-permissions-panel');
    panel.querySelectorAll('[data-agy-rule-kind]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.agyRuleKind === kind)));
    panel.querySelectorAll('[data-agy-rule-page]').forEach(page => { page.hidden = page.dataset.agyRulePage !== kind; });
    updateTerminalControlsHeight();
}
function showAgyPermissionRules() {
    const panel = document.getElementById('antigravity-permissions-panel'), doc = agyPermissionRulesDraft[agyPermissionScope];
    for (const kind of ['deny', 'ask', 'allow']) {
        panel.querySelector(`[data-agy-rule-list="${kind}"]`).value = (doc[kind] || []).join('\n');
        panel.querySelector(`[data-agy-rule-count="${kind}"]`).textContent = String(doc[kind]?.length || 0);
    }
    showAgyPermissionRuleKind(agyPermissionRuleKind);
}
async function chooseAgyPermissionPreset(id) {
    if (!antigravityReadyForInput()) return;
    const preset = agyPermissionPresets.find(item => item.id === id);
    if (!preset || (preset.mode && !agyPermissionModes().some(mode => (mode.value ?? mode.id) === preset.mode))) return;
    const hadDraft = agyPermissionHasDraft(), values = agyPermissionDraftValues();
    if (preset.mode) agyPermissionDraft.mode = preset.mode;
    if (preset.id === 'sandbox' && !values.enableTerminalSandbox) agyPermissionDraft.enableTerminalSandbox = true;
    if (values.toolPermission !== preset.tool) agyPermissionDraft.toolPermission = preset.tool;
    renderAntigravityPermissionsSummary();
    if (!hadDraft && !agyPermissionNeedsReconnect() && agyPermissionHasDraft()) await applyAgyPermissionEditor();
    updateTerminalControlsHeight();
}
async function applyAgyPermissionEditor(saveDefault = false) {
    if (!antigravityReadyForInput() || !agyPermissionDocument) return;
    const sessionId = activeSessionId, epoch = antigravitySessionEpoch;
    const isCurrent = () => sessionId === activeSessionId && epoch === antigravitySessionEpoch;
    const policy = Object.fromEntries(agyPermissionKeys.map(key => [key, agyPermissionDraft[key]]));
    if (saveDefault && !window.confirm('Save this policy as the native agy default? Future CLI sessions will use it. Current sessions are unchanged.')) return;
    if (!saveDefault && agyPermissionDraftValues().toolPermission === 'always-proceed' && agyPermissionDocument.values.toolPermission !== 'always-proceed'
        && !window.confirm('Run tools without approval? Ask / Deny rules still apply. Sandbox and outside-workspace access remain separate.')) return;
    const rules = Object.fromEntries(Object.entries(agyPermissionRulesDraft).filter(([scope, value]) => JSON.stringify(value) !== JSON.stringify(agyPermissionDocument.rules[scope])));
    if (!saveDefault && !agyPermissionNeedsReconnect()) {
        if (agyPermissionDraft.mode !== agyPermissionDocument.mode && !await updateAntigravitySetting('mode', agyPermissionDraft.mode)) return;
        if (isCurrent()) await loadAntigravityPermissions();
        return;
    }
    antigravitySettingsPending = true;
    applyAntigravityState({});
    const panel = document.getElementById('antigravity-permissions-panel');
    panel.querySelector('[data-agy-policy-error]').hidden = true;
    try {
        const path = saveDefault ? 'permission-defaults' : 'permissions';
        const body = saveDefault ? { policy: agyPermissionDraftValues(), revision: agyPermissionDocument.globalRevision, mode: agyPermissionDraft.mode }
            : { policy, mode: agyPermissionDraft.mode, rules, revision: agyPermissionDocument.revision };
        const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/antigravity-${path}`, { method: saveDefault ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 95000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Unable to apply permissions.');
        if (!isCurrent()) return;
        if (data.state) applyAntigravityState(data.state);
        if (saveDefault) {
            const latest = await antigravityRequest('permissions', {}, sessionId);
            if (!isCurrent()) return;
            agyPermissionDocument.globalRevision = latest.globalRevision;
            agyPermissionDocument.defaults = latest.defaults;
            showAppToast('Default saved. Current session unchanged.');
        } else await loadAntigravityPermissions();
    } catch (error) {
        if (isCurrent()) {
            const message = panel.querySelector('[data-agy-policy-error]');
            message.textContent = error.message;
            message.hidden = false;
            message.scrollIntoView({ block: 'nearest' });
        }
    } finally { if (isCurrent()) { antigravitySettingsPending = false; applyAntigravityState({}); } }
}
document.addEventListener('change', event => {
    if (event.target.hasAttribute('data-agy-rule-scope')) { agyPermissionScope = event.target.value; showAgyPermissionRules(); }
});
document.addEventListener('input', event => {
    const kind = event.target.dataset.agyRuleList;
    if (!kind || !agyPermissionRulesDraft) return;
    agyPermissionRulesDraft[agyPermissionScope][kind] = event.target.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    document.querySelector(`[data-agy-rule-count="${kind}"]`).textContent = String(agyPermissionRulesDraft[agyPermissionScope][kind].length);
    renderAntigravityPermissionsSummary();
});
document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !isAntigravitySession()) return;
    const panel = document.getElementById('antigravity-permissions-panel');
    if (button.hasAttribute('data-agy-policy-close')) { closeAntigravityActionPanels(); document.getElementById('antigravity-mode-control').focus(); }
    if (button.hasAttribute('data-agy-policy-tab')) showAgyPermissionTab(button.dataset.agyPolicyTab);
    if (button.hasAttribute('data-agy-rule-kind')) showAgyPermissionRuleKind(button.dataset.agyRuleKind);
    if (button.hasAttribute('data-agy-preset')) void chooseAgyPermissionPreset(button.dataset.agyPreset);
    if (button.hasAttribute('data-agy-policy-apply')) void applyAgyPermissionEditor();
    if (button.hasAttribute('data-agy-policy-defaults')) void applyAgyPermissionEditor(true);
    if (button.hasAttribute('data-agy-policy-retry')) void loadAntigravityPermissions();
    if (button.hasAttribute('data-agy-policy-cancel')) void loadAntigravityPermissions();
    if (button.hasAttribute('data-agy-policy-toggle')) {
        const key = button.dataset.agyPolicyToggle;
        const values = agyPermissionDraftValues();
        const desired = key === 'artifactReviewPolicy' ? values[key] === 'always-proceed' : !Boolean(values[key]);
        const original = key === 'artifactReviewPolicy' ? agyPermissionDocument.values[key] !== 'always-proceed' : Boolean(agyPermissionDocument.values[key]);
        agyPermissionDraft[key] = desired === original ? (agyPermissionDocument.overrides?.[key] ?? 'inherit')
            : key === 'artifactReviewPolicy' ? (desired ? 'asks-for-review' : 'always-proceed') : desired;
        renderAntigravityPermissionsSummary(); updateTerminalControlsHeight();
    }
    if (button.hasAttribute('data-agy-rule-prefix')) {
        const field = panel.querySelector(`[data-agy-rule-list="${agyPermissionRuleKind}"]`);
        const prefix = `${button.dataset.agyRulePrefix}()`;
        const before = field.value.slice(0, field.selectionStart), after = field.value.slice(field.selectionEnd);
        const insertion = `${before && !before.endsWith('\n') ? '\n' : ''}${prefix}${after && !after.startsWith('\n') ? '\n' : ''}`;
        field.setRangeText(insertion, field.selectionStart, field.selectionEnd, 'end');
        const caret = before.length + (before && !before.endsWith('\n') ? 1 : 0) + prefix.length - 1;
        field.focus(); field.setSelectionRange(caret, caret);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }
});
document.addEventListener('keydown', event => {
    const tab = event.target.closest('[data-agy-policy-tab], [data-agy-rule-kind]');
    if (tab && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const tabs = [...tab.parentElement.querySelectorAll('button[role="tab"]')];
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.click(); next.focus(); return;
    }
    if (event.key !== 'Tab' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !isAntigravitySession() || event.target.id !== 'cmd-input') return;
    if (!antigravityReadyForInput()) return;
    event.preventDefault();
    if (agyPermissionHasDraft()) { showAppToast('Apply or cancel permission changes before switching modes.'); return; }
    const modes = agyPermissionModes();
    if (modes.length < 2) return;
    const index = modes.findIndex(item => (item.value ?? item.id) === antigravityState.mode);
    const next = modes[(index + 1) % modes.length];
    const sessionId = activeSessionId, epoch = antigravitySessionEpoch;
    void updateAntigravitySetting('mode', next.value ?? next.id).then(success => {
        if (success && sessionId === activeSessionId && epoch === antigravitySessionEpoch && agyPermissionDocument) void loadAntigravityPermissions();
    });
});

let agyRailMeasurePending = false;
function scheduleAgyPermissionRailEdges() {
    if (agyRailMeasurePending) return;
    agyRailMeasurePending = true;
    requestAnimationFrame(() => {
        agyRailMeasurePending = false;
        const rail = document.getElementById('antigravity-control-rail');
        rail.classList.toggle('agy-rail-more-left', rail.scrollLeft > 1);
        rail.classList.toggle('agy-rail-more-right', rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 1);
    });
}
const agyPermissionRail = document.getElementById('antigravity-control-rail');
agyPermissionRail.addEventListener('scroll', scheduleAgyPermissionRailEdges, { passive: true });
new ResizeObserver(scheduleAgyPermissionRailEdges).observe(agyPermissionRail);
