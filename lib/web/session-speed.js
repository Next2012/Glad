// All clocks and samples live in the daemon; this view never measures WS timing.
const sessionSpeedCache = new Map();
let speedPanelSession = null, speedPanelScope = 'session', speedPanelView = 'turns';
let speedPanelTimer = null, speedPanelEpoch = 0, speedPanelBusy = false, speedPanelController = null;
// A 270-degree clockwise arc, normalized to the fixed 100 tok/s scale.
const speedGaugePath = 'M6.101 25.899 A14 14 0 1 1 25.899 25.899';
function speedGaugeHTML(fill) {
    return `<svg class="speed-gauge" viewBox="0 0 32 32" aria-hidden="true"><path class="speed-gauge-track" pathLength="100" d="${speedGaugePath}"/><path class="speed-gauge-value" pathLength="100" d="${speedGaugePath}"${fill > 0 ? '' : ' hidden'}/></svg>`;
}
function speedNumber(value, compact = false) {
    if (!Number.isFinite(value)) return '—';
    if (compact) {
        if (value >= 1000) return '1k+';
        if (value > 0 && value < 1) return '<1';
        return String(Math.min(999, Math.round(value)));
    }
    return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
function speedBadgeRate(sample) {
    return Number.isFinite(sample?.rate) && sample.rate >= 0 ? sample.rate : null;
}
function speedBadgePresentation(sample) {
    const rate = speedBadgeRate(sample);
    return { value: speedNumber(rate, true), fill: Math.min(rate ?? 0, 100), title: speedBadgeTitle(sample) };
}
function speedBadgeHTML(id, sample) {
    const { value, fill, title } = speedBadgePresentation(sample);
    const label = escapeHtml(title);
    return `<button type="button" class="session-speed-badge${sample?.shortSample ? ' short-sample' : ''}${value.length > 2 ? ' speed-badge-wide' : ''}" style="--speed-fill:${fill};--speed-mix:${fill}%" data-speed-session="${escapeHtml(id)}" onclick="event.stopPropagation();openSessionSpeed(this.dataset.speedSession)" aria-label="${label}" title="${label}">${speedGaugeHTML(fill)}<span class="speed-gauge-number">${escapeHtml(value)}</span></button>`;
}
function speedBadgeTitle(sample) {
    const rate = speedBadgeRate(sample);
    return 'Effective output speed · ' + (rate == null ? 'No speed data' : `≈${speedNumber(rate)} tok/s`) + ' · Last completed turn · includes first output waiting' + (sample?.shortSample ? ' · Short reply (under 50 tokens)' : '');
}
function renderSpeedBadge(button, sample) {
    const { value, fill, title } = speedBadgePresentation(sample);
    button.querySelector('.speed-gauge-number').textContent = value;
    button.style.setProperty('--speed-fill', String(fill));
    button.style.setProperty('--speed-mix', `${fill}%`);
    button.querySelector('.speed-gauge-value').toggleAttribute('hidden', fill === 0);
    button.classList.toggle('speed-badge-wide', value.length > 2);
    button.classList.toggle('short-sample', Boolean(sample?.shortSample));
    button.title = title;
    button.setAttribute('aria-label', title);
}
function reloadSpeedStatistics() {
    speedPanelEpoch++; speedPanelController?.abort(); speedPanelBusy = false;
    void loadSessionSpeed();
}
function updateSessionSpeed(id, sample) {
    if (!id) return;
    sessionSpeedCache.set(String(id), sample || null);
    for (const button of document.querySelectorAll('[data-speed-session]')) {
        if (button.dataset.speedSession !== String(id)) continue;
        renderSpeedBadge(button, sample);
    }
    if (id === activeSessionId) syncActiveSpeedBadge(id);
}
function syncActiveSpeedBadge(id = activeSessionId) {
    const button = document.getElementById('session-speed-button');
    if (!button) return;
    button.dataset.speedSession = id || '';
    const sample = sessionSpeedCache.get(String(id));
    renderSpeedBadge(button, sample);
}
async function loadSessionSpeedBadge(id) {
    syncActiveSpeedBadge(id);
    try {
        const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(id)}/metadata`, {}, 10000);
        if (response.ok) { const data = await response.json(); if (activeSessionId === id) updateSessionSpeed(id, data.speed); }
    } catch (_) { /* The live snapshot also carries the badge. */ }
}
function closeSessionSpeed(event) {
    if (event && event.target.id !== 'session-speed-overlay') return;
    document.getElementById('session-speed-overlay').classList.remove('active');
    clearInterval(speedPanelTimer); speedPanelTimer = null; speedPanelEpoch++;
    speedPanelController?.abort(); speedPanelController = null; speedPanelBusy = false;
}
async function openSessionSpeed(id = activeSessionId) {
    if (!id) return;
    closeSessionSpeed(); speedPanelSession = id; speedPanelScope = 'session'; speedPanelView = 'turns';
    document.getElementById('speed-limit').value = '50';
    document.getElementById('speed-exclude-short').checked = false;
    document.getElementById('speed-content').innerHTML = '<p>Loading speed samples…</p>';
    document.getElementById('session-speed-overlay').classList.add('active');
    selectSpeedView('turns');
    speedPanelTimer = setInterval(() => void loadSessionSpeed(), 3000);
}
function selectSpeedView(view) {
    speedPanelView = view;
    for (const button of document.querySelectorAll('[data-speed-view]')) button.setAttribute('aria-selected', String(button.dataset.speedView === view));
    document.getElementById('speed-limit-row').hidden = view !== 'turns';
    void loadSessionSpeed();
}
function selectSpeedScope(scope) {
    speedPanelScope = scope; speedPanelEpoch++; speedPanelController?.abort(); speedPanelBusy = false;
    for (const button of document.querySelectorAll('[data-speed-scope]')) button.setAttribute('aria-pressed', String(button.dataset.speedScope === scope));
    void loadSessionSpeed();
}
async function loadSessionSpeed() {
    if (speedPanelBusy || !document.getElementById('session-speed-overlay').classList.contains('active')) return;
    const epoch = speedPanelEpoch, id = speedPanelSession;
    speedPanelBusy = true; const controller = new AbortController(); speedPanelController = controller;
    try {
        const query = new URLSearchParams({ scope: speedPanelScope, limit: document.getElementById('speed-limit').value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', excludeShort: String(document.getElementById('speed-exclude-short').checked) });
        const timer=setTimeout(() => controller.abort(),15000);
        let response;
        try {response=await fetch(`/api/sessions/${encodeURIComponent(id)}/speed?${query}`, {signal:controller.signal});} finally {clearTimeout(timer);}
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load speed samples');
        if (epoch !== speedPanelEpoch) return;
        updateSessionSpeed(id, data.last);
        document.getElementById('speed-model-scope').disabled = !data.last?.model;
        for (const button of document.querySelectorAll('[data-speed-scope]')) button.setAttribute('aria-pressed', String(button.dataset.speedScope === speedPanelScope));
        const content = document.getElementById('speed-content');
        const opened = new Set([...content.querySelectorAll('details[open]')].map(el => el.dataset.speedSample));
        const scroll = content.scrollTop;
        const heading = speedPanelScope === 'model' ? data.last?.model || 'Same model' : 'This session';
        const lastRate = speedBadgeRate(data.last);
        let html = `<p class="speed-latest-speed">Last completed turn · <strong>${lastRate == null ? '—' : '≈' + speedNumber(lastRate)} tok/s</strong></p>`;
        html += data.last?.shortSample ? '<p class="speed-latest-note">Latest completed turn: Short reply (under 50 tokens). First output waiting can dominate its effective speed. The badge still shows this turn.</p>' : '';
        html += `<p class="speed-scope-caption">${escapeHtml(heading)}${speedPanelScope === 'model' ? ' · matching service, effort and Fast mode' : ''}</p>`;
        if (speedPanelView === 'turns') {
            html += `<div class="speed-summary"><strong>${data.mean != null ? '≈' : ''}${speedNumber(data.mean)} <small>tok/s</small></strong><span>Mean per completed turn · ${data.validCount} / ${data.sampleCount} included samples · ${data.excludedCount} short samples excluded</span>${data.shortCount && !data.excludeShort ? `<small>${data.shortCount} short samples included</small>` : ''}</div>`;
            html += data.items.length ? data.items.map(sample => `<details class="speed-turn" data-speed-sample="${escapeHtml(sample.id)}"${opened.has(sample.id) ? ' open' : ''}><summary><span>${escapeHtml(new Date(sample.endedAt).toLocaleString())}<small>${escapeHtml(sample.model || 'Model not reported')} · ${escapeHtml(sample.status)}${sample.shortSample ? ' · Short sample' : ''}${sample.quality === 'incomplete' ? ' · Incomplete data' : ''}${sample.compacted ? ' · Context compacted' : ''}</small></span><strong>${sample.rate != null ? '≈' : ''}${speedNumber(sample.rate)} <small>tok/s</small></strong></summary><dl><dt>Reported output tokens</dt><dd>${sample.outputTokens == null ? '—' : sample.outputTokens}</dd><dt>Turn duration</dt><dd>${speedNumber(sample.wallMs / 1000)}s</dd><dt>Observed tool / human waits</dt><dd>${speedNumber(sample.blockedMs / 1000)}s</dd><dt>Effective output window</dt><dd>${speedNumber(sample.observedMs / 1000)}s</dd>${sample.resultOutputTokens != null ? `<dt>CLI result output tokens (diagnostic)</dt><dd>${sample.resultOutputTokens}${sample.resultTokensMatch === false ? ' · Different scope/count' : ''}</dd>` : ''}</dl></details>`).join('') : '<p>No live samples yet. Statistics start after this update; old history is not estimated.</p>';
        } else {
            const hourlyIncluded = data.hours.reduce((n,h) => n+h.count,0), hourlyExcluded = data.hours.reduce((n,h) => n+h.excludedCount,0);
            html += `<p class="speed-counts">${hourlyIncluded} included · ${hourlyExcluded} short samples excluded</p>`;
            html += '<p class="speed-hour-note">Last 24 hours · turns grouped by completion time · '+escapeHtml(data.timezone)+'</p><table class="speed-hours"><thead><tr><th>Hour</th><th>Included</th><th>Excluded</th><th>Mean tok/s</th></tr></thead><tbody>'+data.hours.map(hour => `<tr><td>${escapeHtml(hour.label)}</td><td>${hour.count}</td><td>${hour.excludedCount}</td><td>${hour.mean != null ? '≈' : ''}${speedNumber(hour.mean)}</td></tr>`).join('')+'</tbody></table>';
        }
        content.innerHTML = html; content.scrollTop = scroll;
    } catch (error) { if (epoch === speedPanelEpoch && error.name !== 'AbortError') document.getElementById('speed-content').textContent = error.message; }
    finally { if (epoch === speedPanelEpoch) { speedPanelBusy = false; speedPanelController = null; } }
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSessionSpeed(); });
