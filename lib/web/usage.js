        const usageState = {
            source: null,
            scope: 'weekly',
            selectedPeriod: null,
            sources: [],
            requestSequence: 0,
            sourceSequence: 0,
            sourcesTimer: null,
            dashboardTimer: null,
            offlineOnly: false,
            settingPending: false,
            reports: new Map()
        };

        const usageModelColors = [
            '#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff453a', '#64d2ff',
            '#ffd60a', '#5e5ce6', '#ff375f', '#66d4cf', '#ac8e68', '#8e8e93'
        ];

        function formatExactTokens(value) {
            return new Intl.NumberFormat().format(Number(value) || 0);
        }

        function formatCompactNumber(value) {
            const number = Number(value) || 0;
            if (number < 1000) return formatExactTokens(number);
            return new Intl.NumberFormat(undefined, {
                notation: 'compact',
                maximumFractionDigits: number >= 1000000 ? 2 : 1
            }).format(number);
        }

        function formatEstimatedCost(value, compact = false) {
            if (value === null || value === undefined) return '—';
            const amount = Number(value) || 0;
            const small = amount > 0 && amount < 1;
            if (amount > 0 && amount < 0.0001) return `< ${new Intl.NumberFormat(undefined, { style:'currency', currency:'USD', minimumFractionDigits:4, maximumFractionDigits:4 }).format(0.0001)}`;
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: 'USD',
                notation: compact && amount >= 1000 ? 'compact' : 'standard',
                minimumFractionDigits: small ? 3 : 2,
                maximumFractionDigits: small ? 4 : 2
            }).format(amount);
        }

        function stopUsagePolling() {
            clearTimeout(usageState.sourcesTimer); usageState.sourcesTimer = null;
            clearTimeout(usageState.dashboardTimer); usageState.dashboardTimer = null;
            usageState.sourceSequence++; usageState.requestSequence++;
        }
        function closeUsageSourceModal(event) {
            if (event && event.target.id !== 'usage-source-overlay') return;
            clearTimeout(usageState.sourcesTimer); usageState.sourcesTimer = null;
            usageState.sourceSequence++;
            document.getElementById('usage-source-overlay').style.display = 'none';
        }
        function usageDashboardVisible() { return document.getElementById('usage-view').classList.contains('active'); }
        function usageSourcesVisible() { return document.getElementById('usage-source-overlay').style.display === 'flex'; }
        function applyUsageStatus(data) {
            if (typeof data.offlineOnly === 'boolean' && !usageState.settingPending) {
                usageState.offlineOnly = data.offlineOnly;
                for (const id of ['usage-offline-only', 'usage-source-offline-only']) document.getElementById(id).checked = data.offlineOnly;
            }
            const updated = data.generatedAt ? new Date(data.generatedAt) : null;
            document.getElementById('usage-updated-at').textContent = updated && !Number.isNaN(updated.getTime()) ? `Updated ${updated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : '';
            const status = document.getElementById('usage-refresh-status');
            status.textContent = [data.refreshing ? 'Updating…' : '', data.lastError ? `Refresh failed: ${data.lastError}` : '', data.settingsPending ? 'Showing the previous report while applying your pricing setting.' : ''].filter(Boolean).join(' · ');
            status.hidden = !status.textContent;
            status.classList.toggle('error', Boolean(data.lastError));
            const button = document.getElementById('usage-refresh-button');
            button.classList.toggle('loading', Boolean(data.refreshing)); button.disabled = Boolean(data.refreshing);
        }
        async function setUsageOfflineOnly(value) {
            const previous = usageState.offlineOnly;
            usageState.settingPending = true;
            for (const id of ['usage-offline-only','usage-source-offline-only']) document.getElementById(id).disabled = true;
            try {
                const response = await fetchWithTimeout('/api/usage/settings', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({offlineOnly:value}) });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                usageState.settingPending = false;
                for (const cached of usageState.reports.values()) {
                    cached.offlineOnly = value; cached.settingsPending = true; cached.refreshing = true; cached.lastError = '';
                }
                applyUsageStatus(data);
                if (usageDashboardVisible()) await loadUsageDashboard();
                if (usageSourcesVisible()) await showUsageSourceModal();
            } catch (error) {
                usageState.offlineOnly = previous;
                for (const id of ['usage-offline-only','usage-source-offline-only']) document.getElementById(id).checked = previous;
                const target = usageSourcesVisible() ? document.getElementById('usage-sources-status') : document.getElementById('usage-refresh-status');
                target.textContent = `Unable to change pricing setting: ${error.message}`; target.hidden = false;
            } finally {
                usageState.settingPending = false;
                for (const id of ['usage-offline-only','usage-source-offline-only']) document.getElementById(id).disabled = false;
            }
        }
        async function showUsageSourceModal(options = {}) {
            document.getElementById('usage-source-overlay').style.display = 'flex';
            clearTimeout(usageState.sourcesTimer); usageState.sourcesTimer = null;
            const sequence = ++usageState.sourceSequence;
            if (usageState.sources.length) renderUsageSources();
            else document.getElementById('usage-sources-list').innerHTML = '<p class="usage-modal-state">Reading usage for the first time…</p>';
            try {
                const response = await fetchWithTimeout(`/api/usage/sources${options.refresh ? '?refresh=1' : ''}`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                if (sequence !== usageState.sourceSequence || !usageSourcesVisible()) return;
                applyUsageStatus(data);
                const status = document.getElementById('usage-sources-status');
                status.textContent = [data.refreshing ? 'Updating…' : '', data.lastError ? `Refresh failed: ${data.lastError}` : ''].filter(Boolean).join(' · ');
                status.hidden = !status.textContent;
                if (data.hasData !== false) { usageState.sources = Array.isArray(data.sources) ? data.sources : []; renderUsageSources(); }
                else if (data.lastError && !usageState.sources.length) document.getElementById('usage-sources-list').innerHTML = `<p class="usage-modal-state">${escapeHtml(data.lastError)}<br><button class="small-btn" type="button" onclick="showUsageSourceModal({refresh:true})">Retry</button></p>`;
                if (data.refreshing) usageState.sourcesTimer = setTimeout(() => { if (usageSourcesVisible()) void showUsageSourceModal(); }, 1000);
            } catch (error) {
                if (sequence !== usageState.sourceSequence) return;
                const status = document.getElementById('usage-sources-status');
                status.textContent = `Unable to read usage: ${error.message}`; status.hidden = false;
                if (!usageState.sources.length) document.getElementById('usage-sources-list').innerHTML = '<button class="small-btn" type="button" onclick="showUsageSourceModal({refresh:true})">Retry</button>';
            }
        }
        function renderUsageSources() {
            const list = document.getElementById('usage-sources-list');
            if (!usageState.sources.length) {
                list.innerHTML = '<p class="usage-modal-state">No supported local CLI usage history was found.</p>';
                return;
            }
            list.innerHTML = usageState.sources.map(source => `
                <button class="usage-source-item" type="button" onclick="openUsageDashboard('${escapeHtml(source.id)}')">
                    <span class="usage-source-badge">${escapeHtml(source.badge)}</span>
                    <span class="usage-source-copy"><strong>${escapeHtml(source.label)}</strong><span>Local token history</span></span>
                    <span class="usage-source-arrow">›</span>
                </button>`).join('');
        }

        async function openUsageDashboard(sourceId) {
            const source = usageState.sources.find(item => item.id === sourceId);
            usageState.source = source || { id: sourceId, label: sourceId };
            usageState.selectedPeriod = null;
            closeUsageSourceModal();
            document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
            document.getElementById('usage-view').classList.add('active');
            document.getElementById('usage-source-title').textContent = `${usageState.source.label} Usage`;
            await loadUsageDashboard();
        }

        async function setUsageScope(scope) {
            if (!['weekly', 'monthly'].includes(scope) || usageState.scope === scope) return;
            usageState.scope = scope;
            usageState.selectedPeriod = null;
            updateUsageScopeButtons();
            if (usageState.source) await loadUsageDashboard();
        }

        function updateUsageScopeButtons() {
            for (const scope of ['weekly', 'monthly']) {
                document.getElementById(`usage-scope-${scope}`).classList.toggle('active', usageState.scope === scope);
            }
        }

        async function selectUsagePeriod(period) {
            if (!period || usageState.selectedPeriod === period) return;
            usageState.selectedPeriod = period;
            await loadUsageDashboard();
        }

        async function refreshUsageDashboard() {
            if (!usageState.source) return;
            await loadUsageDashboard(true);
        }

        function setUsageLoading(loading, message = 'Loading usage data...') {
            const state = document.getElementById('usage-loading');
            const dashboard = document.getElementById('usage-dashboard');
            const refresh = document.getElementById('usage-refresh-button');
            state.classList.remove('error');
            state.textContent = message;
            state.hidden = !loading;
            dashboard.hidden = loading;
            refresh.classList.toggle('loading', loading);
            refresh.disabled = loading;
        }

        function usageReportKey(period = usageState.selectedPeriod) { return `${usageState.source?.id}:${usageState.scope}:${period || ''}`; }
        async function loadUsageDashboard(refresh = false) {
            clearTimeout(usageState.dashboardTimer); usageState.dashboardTimer = null;
            if (!usageState.source) return;
            const sequence = ++usageState.requestSequence;
            const key = usageReportKey();
            const cached = usageState.reports.get(key);
            if (cached) renderUsageDashboard(cached);
            else setUsageLoading(true, 'Reading usage for the first time…');
            try {
                const query = new URLSearchParams({ source:usageState.source.id, scope:usageState.scope });
                if (usageState.selectedPeriod) query.set('period', usageState.selectedPeriod);
                if (refresh) query.set('refresh','1');
                const response = await fetchWithTimeout(`/api/usage/report?${query}`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                if (sequence !== usageState.requestSequence || !usageDashboardVisible()) return;
                if (data.hasData !== false) {
                    usageState.reports.set(key, data);
                    usageState.reports.set(`${usageState.source.id}:${usageState.scope}:${data.selectedPeriod || ''}`, data);
                    renderUsageDashboard(data);
                } else {
                    setUsageLoading(true, data.lastError ? `Unable to read usage: ${data.lastError}` : 'Reading usage for the first time…');
                    applyUsageStatus(data);
                }
                if (data.refreshing) usageState.dashboardTimer = setTimeout(() => { if (usageDashboardVisible()) void loadUsageDashboard(); }, 1000);
            } catch (error) {
                if (sequence !== usageState.requestSequence) return;
                const status = document.getElementById('usage-refresh-status');
                status.textContent = `Refresh failed: ${error.message}`; status.hidden = false; status.classList.add('error');
                if (!cached) setUsageLoading(true, `Unable to read usage: ${error.message}`);
            }
        }

        function renderPeriodPicker(report) {
            usageState.selectedPeriod = report.selectedPeriod;
            const select = document.getElementById('usage-period-select');
            select.innerHTML = (report.availablePeriods || []).map(period =>
                `<option value="${escapeHtml(period)}"${period === report.selectedPeriod ? ' selected' : ''}>${escapeHtml(period)}</option>`
            ).join('');
            select.disabled = !report.availablePeriods || report.availablePeriods.length === 0;
        }

        function totalSummaryCard(label, value, cost = false, displayOverride = '') {
            const display = displayOverride || (cost ? formatEstimatedCost(value, true) : formatCompactNumber(value));
            const exact = displayOverride || (cost ? formatEstimatedCost(value) : `${formatExactTokens(value)} tokens`);
            return `<article class="usage-summary-card" title="${escapeHtml(exact)}">
                <span class="label"><i class="dot ${cost ? 'cost' : 'tokens'}"></i>${escapeHtml(label)}</span>
                <strong class="value">${escapeHtml(display)}</strong>
                <span class="exact">${escapeHtml(exact)}</span>
            </article>`;
        }

        function usagePricingState(report) {
            const models = report.summary?.models || [], totals = report.summary?.totals || {};
            const unpriced = totals.unpricedModels || models.filter(model => model.missingPricing).map(model => model.modelName);
            const status = totals.pricingStatus || (totals.estimatedCostUSD == null ? 'unavailable' : unpriced.length ? 'partial' : 'complete');
            return {status,unpriced};
        }
        function renderAllModelTotals(report) {
            const totals = report.summary?.totals || {};
            const {status,unpriced} = usagePricingState(report);
            const cards = [totalSummaryCard('All-model tokens',totals.totalTokens)];
            if (totals.estimatedCostUSD != null) cards.push(totalSummaryCard(status === 'partial' ? 'Known-price estimate' : 'Estimated cost',totals.estimatedCostUSD,true));
            else if (report.summary?.models?.length) cards.push(totalSummaryCard('Estimated cost',null,true,'Cannot estimate'));
            document.getElementById('usage-summary').innerHTML = cards.join('');
            const note = document.getElementById('usage-pricing-note');
            note.textContent = unpriced.length ? `${status === 'partial' ? 'Known-price estimate excludes models with unknown prices' : 'Cannot estimate cost because model prices are unknown'}: ${unpriced.join(', ')}.` : '';
            note.hidden = !note.textContent;
        }

        function renderModelSummary(report) {
            const models = report.summary && Array.isArray(report.summary.models) ? report.summary.models : [];
            const totals = report.summary && report.summary.totals ? report.summary.totals : {};
            const hasCost = models.length > 0;
            const container = document.getElementById('usage-model-summary');
            if (!models.length) {
                container.innerHTML = '<div class="usage-empty">No usage in this period.</div>';
                return;
            }
            container.innerHTML = `<table class="usage-table">
                <thead><tr><th>Model</th><th>Uncached input</th><th>Cached input</th><th>Output</th><th>Total tokens</th>${hasCost ? '<th>Cost</th>' : ''}</tr></thead>
                <tbody>${models.map(model => `<tr>
                    <td class="usage-models" title="${escapeHtml(model.modelName)}">${escapeHtml(model.modelName)}</td>
                    <td>${escapeHtml(formatExactTokens(model.uncachedInputTokens))}</td>
                    <td>${escapeHtml(formatExactTokens(model.cachedInputTokens))}</td>
                    <td>${escapeHtml(formatExactTokens(model.outputTokens))}</td>
                    <td>${escapeHtml(formatExactTokens(model.totalTokens))}</td>
                    ${hasCost ? `<td>${escapeHtml(model.estimatedCostUSD == null ? 'Unknown' : formatEstimatedCost(model.estimatedCostUSD))}</td>` : ''}
                </tr>`).join('')}</tbody>
                <tfoot><tr><td>All models</td><td>${escapeHtml(formatExactTokens(totals.uncachedInputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.cachedInputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.outputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.totalTokens))}</td>${hasCost ? `<td>${escapeHtml(totals.estimatedCostUSD == null ? 'Cannot estimate' : formatEstimatedCost(totals.estimatedCostUSD))}</td>` : ''}</tr></tfoot>
            </table>`;
        }

        function collectChartModels(days, metric) {
            const names = [];
            const seen = new Set();
            for (const day of days) {
                for (const model of day.models || []) {
                    const value = model[metric];
                    if ((value === null || value === undefined || Number(value) <= 0) || seen.has(model.modelName)) continue;
                    seen.add(model.modelName);
                    names.push(model.modelName);
                }
            }
            return names.sort((a, b) => a.localeCompare(b));
        }

        function modelColorMap(modelNames) {
            return new Map(modelNames.map((name, index) => [
                name,
                usageModelColors[index] || `hsl(${(index * 47) % 360} 75% 58%)`
            ]));
        }

        function renderModelLegend(elementId, modelNames, colors) {
            document.getElementById(elementId).innerHTML = modelNames.map(name =>
                `<span title="${escapeHtml(name)}"><i style="background:${colors.get(name)}"></i>${escapeHtml(name)}</span>`
            ).join('');
        }

        function renderStackedModelChart(report, options) {
            const days = report.days || [];
            const modelNames = collectChartModels(days, options.metric);
            const colors = modelColorMap(modelNames);
            const container = document.getElementById(options.containerId);
            renderModelLegend(options.legendId, modelNames, colors);
            if (!days.length || !modelNames.length) {
                container.innerHTML = `<div class="usage-empty">${escapeHtml(options.emptyText)}</div>`;
                return false;
            }
            const dayTotals = days.map(day => (day.models || []).reduce((sum, model) => {
                const value = model[options.metric];
                return sum + (value === null || value === undefined ? 0 : Number(value) || 0);
            }, 0));
            const maximum = Math.max(...dayTotals, 1);
            container.innerHTML = days.map((day, dayIndex) => {
                const segments = modelNames.map(name => {
                    const model = (day.models || []).find(item => item.modelName === name);
                    const value = model && model[options.metric] !== null ? Number(model[options.metric]) || 0 : 0;
                    if (value <= 0) return '';
                    const title = `${name}: ${options.formatExact(value)}`;
                    return `<span title="${escapeHtml(title)}" style="width:${value / maximum * 100}%;background:${colors.get(name)}"></span>`;
                }).join('');
                return `<div class="usage-chart-row">
                    <span class="usage-chart-label">${escapeHtml(day.period)}</span>
                    <div class="usage-chart-track">${segments}</div>
                    <span class="usage-chart-total">${escapeHtml(options.formatCompact(dayTotals[dayIndex]))}</span>
                </div>`;
            }).join('');
            return true;
        }

        function renderDailyTable(report) {
            const days = (report.days || []).slice().reverse();
            const hasCost = days.some(day => day.models?.length);
            const container = document.getElementById('usage-daily-table');
            if (!days.length) {
                container.innerHTML = '<div class="usage-empty">No daily usage in this period.</div>';
                return;
            }
            container.innerHTML = `<table class="usage-table">
                <thead><tr><th>Date</th><th>Total tokens</th>${hasCost ? '<th>Cost</th>' : ''}<th>Models</th></tr></thead>
                <tbody>${days.map(day => `<tr>
                    <td>${escapeHtml(day.period)}</td>
                    <td>${escapeHtml(formatExactTokens(day.totals.totalTokens))}</td>
                    ${hasCost ? `<td>${escapeHtml(day.totals.estimatedCostUSD == null ? 'Cannot estimate' : formatEstimatedCost(day.totals.estimatedCostUSD))}</td>` : ''}
                    <td class="usage-models" title="${escapeHtml(day.models.map(model => model.modelName).join(', '))}">${escapeHtml(day.models.map(model => model.modelName).join(', ') || '—')}</td>
                </tr>`).join('')}</tbody>
            </table>`;
        }

        function renderEngineNote(report) {
            const engine = report.engine || { name: 'ccusage', version: 'unknown' };
            const pricingMode = ['offline','embedded'].includes(engine.pricingMode) ? 'offline pricing (built-in price tables and configured overrides)' : 'online-preferred pricing (uses built-in prices if downloading fails)';
            const parts = [`Statistics and ${pricingMode} calculated by ${engine.name} ${engine.version}`];
            if (report.cost) parts.push(report.cost.note);
            else parts.push('No model-price estimate is available for this period.');
            document.getElementById('usage-engine-note').textContent = parts.join(' · ');
        }

        function renderUsageDashboard(report) {
            setUsageLoading(false);
            updateUsageScopeButtons();
            renderPeriodPicker(report);
            applyUsageStatus(report);
            renderAllModelTotals(report);
            renderModelSummary(report);
            renderStackedModelChart(report, {
                containerId: 'usage-token-chart',
                legendId: 'usage-token-legend',
                metric: 'totalTokens',
                emptyText: 'No token data in this period.',
                formatExact: value => `${formatExactTokens(value)} tokens`,
                formatCompact: formatCompactNumber
            });
            const hasCostChart = renderStackedModelChart(report, {
                containerId: 'usage-cost-chart',
                legendId: 'usage-cost-legend',
                metric: 'estimatedCostUSD',
                emptyText: 'No model-price estimate in this period.',
                formatExact: formatEstimatedCost,
                formatCompact: value => formatEstimatedCost(value, true)
            });
            document.getElementById('usage-cost-panel').hidden = !hasCostChart;
            renderDailyTable(report);
            renderEngineNote(report);
        }

        new MutationObserver(() => { if (!usageDashboardVisible()) { clearTimeout(usageState.dashboardTimer); usageState.dashboardTimer=null; usageState.requestSequence++; } }).observe(document.getElementById('usage-view'),{attributes:true,attributeFilter:['class']});
        window.addEventListener('pagehide',stopUsagePolling);
