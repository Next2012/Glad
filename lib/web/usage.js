        const usageState = {
            source: null,
            scope: 'weekly',
            selectedPeriod: null,
            sources: [],
            requestSequence: 0
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
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: 'USD',
                notation: compact && amount >= 1000 ? 'compact' : 'standard',
                minimumFractionDigits: compact ? 2 : (amount < 1 ? 3 : 2),
                maximumFractionDigits: compact ? 2 : (amount < 1 ? 4 : 2)
            }).format(amount);
        }

        function closeUsageSourceModal(event) {
            if (event && event.target.id !== 'usage-source-overlay') return;
            document.getElementById('usage-source-overlay').style.display = 'none';
        }

        async function showUsageSourceModal(options = {}) {
            const overlay = document.getElementById('usage-source-overlay');
            overlay.style.display = 'flex';
            const hasCachedSources = usageState.sources.length > 0;
            if (hasCachedSources && !options.refresh) {
                renderUsageSources();
            } else {
                document.getElementById('usage-sources-list').innerHTML = '<p class="usage-modal-state">Reading local usage data...</p>';
            }
            const list = document.getElementById('usage-sources-list');
            try {
                const suffix = options.refresh ? '?refresh=1' : '';
                const response = await fetchWithTimeout(`/api/usage/sources${suffix}`, {}, 60000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                usageState.sources = Array.isArray(data.sources) ? data.sources : [];
                renderUsageSources();
            } catch (error) {
                if (hasCachedSources) return;
                list.innerHTML = `<div class="usage-modal-state">Unable to read usage data.<br>${escapeHtml(error.message)}<br><button class="btn-retry" type="button" onclick="showUsageSourceModal({ refresh: true })">Retry</button></div>`;
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

        async function loadUsageDashboard(refresh = false) {
            const requestSequence = ++usageState.requestSequence;
            setUsageLoading(true);
            try {
                const query = new URLSearchParams({ source: usageState.source.id, scope: usageState.scope });
                if (usageState.selectedPeriod) query.set('period', usageState.selectedPeriod);
                if (refresh) query.set('refresh', '1');
                const response = await fetchWithTimeout(`/api/usage/report?${query}`, {}, 60000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                if (requestSequence !== usageState.requestSequence) return;
                renderUsageDashboard(data);
            } catch (error) {
                if (requestSequence !== usageState.requestSequence) return;
                const state = document.getElementById('usage-loading');
                state.classList.add('error');
                state.innerHTML = `Unable to load usage: ${escapeHtml(error.message)}<br><button class="btn-retry" type="button" onclick="loadUsageDashboard(true)">Retry</button>`;
                state.hidden = false;
                document.getElementById('usage-dashboard').hidden = true;
            } finally {
                if (requestSequence !== usageState.requestSequence) return;
                const refreshButton = document.getElementById('usage-refresh-button');
                refreshButton.classList.remove('loading');
                refreshButton.disabled = false;
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

        function totalSummaryCard(label, value, cost = false) {
            const display = cost ? formatEstimatedCost(value, true) : formatCompactNumber(value);
            const exact = cost ? formatEstimatedCost(value) : `${formatExactTokens(value)} tokens`;
            return `<article class="usage-summary-card" title="${escapeHtml(exact)}">
                <span class="label"><i class="dot ${cost ? 'cost' : 'tokens'}"></i>${escapeHtml(label)}</span>
                <strong class="value">${escapeHtml(display)}</strong>
                <span class="exact">${escapeHtml(exact)}</span>
            </article>`;
        }

        function renderAllModelTotals(report) {
            const totals = report.summary && report.summary.totals ? report.summary.totals : {};
            const cards = [totalSummaryCard('All-model tokens', totals.totalTokens)];
            if (totals.estimatedCostUSD !== null && totals.estimatedCostUSD !== undefined) {
                cards.push(totalSummaryCard('All GPT cost', totals.estimatedCostUSD, true));
            }
            document.getElementById('usage-summary').innerHTML = cards.join('');
        }

        function renderModelSummary(report) {
            const models = report.summary && Array.isArray(report.summary.models) ? report.summary.models : [];
            const totals = report.summary && report.summary.totals ? report.summary.totals : {};
            const hasCost = totals.estimatedCostUSD !== null && totals.estimatedCostUSD !== undefined;
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
                    ${hasCost ? `<td>${escapeHtml(formatEstimatedCost(model.estimatedCostUSD))}</td>` : ''}
                </tr>`).join('')}</tbody>
                <tfoot><tr><td>All models</td><td>${escapeHtml(formatExactTokens(totals.uncachedInputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.cachedInputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.outputTokens))}</td><td>${escapeHtml(formatExactTokens(totals.totalTokens))}</td>${hasCost ? `<td>${escapeHtml(formatEstimatedCost(totals.estimatedCostUSD))}</td>` : ''}</tr></tfoot>
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
            const hasCost = days.some(day => day.totals && day.totals.estimatedCostUSD !== null);
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
                    ${hasCost ? `<td>${escapeHtml(formatEstimatedCost(day.totals.estimatedCostUSD))}</td>` : ''}
                    <td class="usage-models" title="${escapeHtml(day.models.map(model => model.modelName).join(', '))}">${escapeHtml(day.models.map(model => model.modelName).join(', ') || '—')}</td>
                </tr>`).join('')}</tbody>
            </table>`;
        }

        function renderEngineNote(report) {
            const engine = report.engine || { name: 'ccusage', version: 'unknown' };
            const pricingMode = engine.pricingMode === 'embedded' ? 'embedded pricing' : 'pricing';
            const parts = [`Statistics and ${pricingMode} calculated by ${engine.name} ${engine.version}`];
            if (report.cost) parts.push(report.cost.note);
            else parts.push('Cost is only shown for GPT models used by Codex.');
            document.getElementById('usage-engine-note').textContent = parts.join(' · ');
        }

        function renderUsageDashboard(report) {
            setUsageLoading(false);
            updateUsageScopeButtons();
            renderPeriodPicker(report);
            const updated = report.generatedAt ? new Date(report.generatedAt) : null;
            document.getElementById('usage-updated-at').textContent = updated && !Number.isNaN(updated.getTime())
                ? `Updated ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : '';
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
                emptyText: 'No Codex GPT cost estimate in this period.',
                formatExact: formatEstimatedCost,
                formatCompact: value => formatEstimatedCost(value, true)
            });
            document.getElementById('usage-cost-panel').hidden = !hasCostChart;
            renderDailyTable(report);
            renderEngineNote(report);
        }
