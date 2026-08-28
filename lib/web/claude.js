        function isClaudeSession() {
            return activeToolKey === 'claude-code';
        }

        function isCodexSession() {
            return activeToolKey === 'codex';
        }

        function setClaudeModeEnabled(enabled) {
            const codexChat = isCodexSession();
            const structured = enabled || codexChat;
            const actionRail = enabled
                ? document.querySelector('.claude-control-rail')
                : codexChat
                    ? document.getElementById('codex-control-rail')
                    : document.getElementById('shortcut-rail');
            const attachmentButton = document.getElementById('attachment-btn');
            const scheduleButton = document.getElementById('schedule-send-btn');
            if (actionRail && attachmentButton && scheduleButton) {
                actionRail.prepend(scheduleButton);
                actionRail.prepend(attachmentButton);
            }
            document.getElementById('terminal-container').style.display = structured ? 'none' : '';
            document.getElementById('claude-chat-container').style.display = enabled ? 'block' : 'none';
            document.getElementById('codex-chat-container').style.display = codexChat ? 'block' : 'none';
            document.getElementById('claude-control-panel').style.display = enabled ? 'flex' : 'none';
            document.getElementById('codex-control-panel').style.display = codexChat ? 'flex' : 'none';
            document.getElementById('attachment-btn').style.display = '';
            document.getElementById('shortcut-rail').style.display = structured ? 'none' : '';
            document.getElementById('scroll-controls').style.display = structured ? 'none' : '';
            document.getElementById('cmd-input').placeholder = enabled ? 'Message Claude...' : codexChat ? 'Message Codex...' : 'Type a message...';
            if (!codexChat) {
                const skillPrefix = document.getElementById('composer-skill-prefix');
                skillPrefix.classList.remove('active');
                skillPrefix.innerHTML = '';
            }
            if (!structured) renderSessionAttention();
            updateTerminalControlsHeight();
        }

        function updateTerminalControlsHeight() {
            const controls = document.getElementById('terminal-controls');
            const measuredHeight = controls ? Math.ceil(controls.getBoundingClientRect().height) : 0;
            document.documentElement.style.setProperty('--terminal-controls-rest-height', `${Math.max(0, measuredHeight)}px`);
        }

        function shortModelLabel(value, resolved) {
            const source = String(value || 'default');
            const target = String(resolved || source);
            const compact = target
                .replace(/^claude-/, '')
                .replace(/-20\d{6,}.*$/, '')
                .slice(0, 9);
            if (source === 'default') return 'M:Def';
            if (source === 'env') return `M:${compact || 'Env'}`;
            if (source === 'sonnet') return `M:${compact || 'Son'}`;
            if (source === 'opus') return `M:${compact || 'Opus'}`;
            if (source === 'haiku') return `M:${compact || 'Hai'}`;
            return `M:${compact || source.slice(0, 9)}`;
        }

        function fullModelLabel(value, resolved, label) {
            const source = String(value || 'default');
            if (source === 'default') return 'Default';
            if (source === 'env') return resolved ? `Environment (${resolved})` : 'Environment';
            if (label && label !== value) return label;
            return String(resolved || value || 'Model');
        }

        function permissionModeLabel(value) {
            const labels = {
                default: 'Default',
                acceptEdits: 'Accept edits',
                plan: 'Plan mode',
                bypassPermissions: 'Bypass'
            };
            return labels[value] || String(value || 'Default');
        }

        function effortLabel(value) {
            const labels = {
                low: 'Low',
                medium: 'Medium',
                high: 'High',
                xhigh: 'Extra high',
                max: 'Max'
            };
            return labels[value] || String(value || 'Medium');
        }

        function pickerLabelFromOption(option) {
            return option ? (option.textContent || option.value || '') : '';
        }

        function pickerFullValue(option) {
            if (!option) return '';
            return option.dataset.resolved || '';
        }

        function syncClaudePickerButtons() {
            const mappings = [
                ['permission', 'claude-permission-select', 'claude-permission-picker-btn', 'Permission'],
                ['model', 'claude-model-select', 'claude-model-picker-btn', 'Model']
            ];
            mappings.forEach(([type, selectId, buttonId, prefix]) => {
                const select = document.getElementById(selectId);
                const button = document.getElementById(buttonId);
                if (!select || !button) return;
                const option = select.selectedOptions && select.selectedOptions[0];
                const label = pickerLabelFromOption(option);
                const fullValue = pickerFullValue(option);
                setActionButtonLabel(button, prefix);
                button.title = type === 'model'
                    ? `${fullValue || label || prefix} · ${effortLabel(claudeState.effort)}`
                    : (fullValue || label || prefix);
                button.classList.toggle('active', claudePickerOpen === type);
            });
        }

        function closeClaudePicker() {
            claudePickerOpen = null;
            const panel = document.getElementById('claude-picker-panel');
            if (panel) {
                panel.classList.remove('active');
                panel.innerHTML = '';
            }
            syncClaudePickerButtons();
            updateTerminalControlsHeight();
        }

        function pickerTitle(type) {
            if (type === 'permission') return 'Permission mode';
            if (type === 'model') return 'Model';
            if (type === 'effort') return 'Effort';
            return 'Options';
        }

        function selectIdForPicker(type) {
            if (type === 'permission') return 'claude-permission-select';
            if (type === 'model') return 'claude-model-select';
            if (type === 'effort') return 'claude-effort-select';
            return '';
        }

        function renderClaudePicker(type) {
            const panel = document.getElementById('claude-picker-panel');
            const select = document.getElementById(selectIdForPicker(type));
            if (!panel || !select) return;
            const renderOptions = optionType => {
                const optionSelect = document.getElementById(selectIdForPicker(optionType));
                if (!optionSelect) return '';
                return Array.from(optionSelect.options).map(option => {
                    const full = pickerFullValue(option);
                    const isSelected = option.value === optionSelect.value;
                    return `<button class="claude-picker-option${isSelected ? ' selected' : ''}" onclick="chooseClaudePickerOption('${optionType}', decodePathValue('${encodePathValue(option.value)}'))">
                        <div class="claude-picker-option-main">
                            <span>${escapeHtml(option.textContent || option.value)}</span>
                            ${isSelected ? '<span class="selected-label">Selected</span>' : ''}
                        </div>
                        ${full ? `<div class="claude-picker-option-value">${escapeHtml(full)}</div>` : ''}
                    </button>`;
                }).join('');
            };
            panel.classList.toggle('combined', type === 'model');
            panel.innerHTML = type === 'model'
                ? `<div class="claude-picker-column"><div class="claude-picker-title">Model</div>${renderOptions('model')}</div>
                    <div class="claude-picker-column"><div class="claude-picker-title">Effort</div>${renderOptions('effort')}</div>`
                : `<div class="claude-picker-title">${escapeHtml(pickerTitle(type))}</div>${renderOptions(type)}`;
            panel.classList.add('active');
            syncClaudePickerButtons();
            updateTerminalControlsHeight();
        }

        async function toggleClaudePicker(type) {
            if (claudePickerOpen === type) {
                closeClaudePicker();
                return;
            }
            if (type === 'model') await refreshClaudeRuntimeConfig();
            claudeResumePanelOpen = false;
            claudeForkPanelOpen = false;
            const resumePanel = document.getElementById('claude-resume-panel');
            if (resumePanel) resumePanel.classList.remove('active');
            const forkPanel = document.getElementById('claude-fork-panel');
            if (forkPanel) forkPanel.classList.remove('active');
            claudePickerOpen = type;
            renderClaudePicker(type);
        }

        async function chooseClaudePickerOption(type, value) {
            const select = document.getElementById(selectIdForPicker(type));
            if (!select) return;
            select.value = value;
            const keepCombinedOpen = claudePickerOpen === 'model' && (type === 'model' || type === 'effort');
            if (!keepCombinedOpen) closeClaudePicker();
            await updateClaudeSettingsFromControls();
            if (keepCombinedOpen && claudePickerOpen === 'model') renderClaudePicker('model');
        }

        function applyClaudeRuntimeConfig(config) {
            if (!config || !Array.isArray(config.models)) return;
            claudeRuntimeConfig = config;
            const modelEl = document.getElementById('claude-model-select');
            if (modelEl) {
                const current = modelEl.value || claudeState.model || config.defaultModel || 'default';
                modelEl.innerHTML = '';
                config.models.forEach(item => {
                    const option = new Option(fullModelLabel(item.value, item.resolved, item.label), item.value);
                    option.title = item.resolved ? `${item.label}: ${item.resolved}` : item.label;
                    option.dataset.resolved = item.resolved || '';
                    option.dataset.shortLabel = shortModelLabel(item.value, item.resolved);
                    modelEl.add(option);
                });
                const next = Array.from(modelEl.options).some(option => option.value === current)
                    ? current
                    : (config.defaultModel || 'default');
                modelEl.value = next;
                claudeState.model = next;
            }
            if (config.defaultEffort && claudeState.effort === 'medium') {
                claudeState.effort = config.defaultEffort;
            }
            syncClaudePickerButtons();
            renderClaudeStateBar();
        }

        async function refreshClaudeRuntimeConfig() {
            try {
                const res = await fetchWithTimeout('/api/claude-config', {}, 10000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load Claude config');
                applyClaudeRuntimeConfig(data.config);
                return data.config;
            } catch (e) {
                log('Failed to load Claude config: ' + e.message);
                return null;
            }
        }

        function ensureSelectOption(selectEl, value, labelPrefix) {
            const normalized = String(value || '').trim();
            if (!normalized) return;
            const exists = Array.from(selectEl.options).some(option => option.value === normalized);
            if (!exists) {
                const label = `${labelPrefix}:${normalized.replace(/^claude-/, '').replace(/-20\d{6,}.*$/, '').slice(0, 10)}`;
                selectEl.add(new Option(label, normalized));
            }
        }

        function applyClaudeState(state = {}, options = {}) {
            claudeState = { ...claudeState, ...state };
            claudeStatus = claudeState.status || claudeStatus;
            if (typeof syncComposerSendState === 'function') {
                syncComposerSendState({ acknowledgeProviderState: Boolean(options.providerStateReceived) });
            }
            const permissionEl = document.getElementById('claude-permission-select');
            const modelEl = document.getElementById('claude-model-select');
            const effortEl = document.getElementById('claude-effort-select');
            if (permissionEl) permissionEl.value = claudeState.permissionMode || 'default';
            if (modelEl) {
                ensureSelectOption(modelEl, claudeState.model || 'default', 'M');
                modelEl.value = claudeState.model || 'default';
            }
            if (effortEl) effortEl.value = claudeState.effort || 'medium';
            syncClaudePickerButtons();
            const abortBtn = document.getElementById('claude-abort-btn');
            if (abortBtn) abortBtn.disabled = !(claudeState.canAbort || claudeStatus === 'thinking');
            const forkBtn = document.getElementById('claude-fork-btn');
            if (forkBtn) forkBtn.disabled = claudeStatus === 'thinking';
            const usageBtn = document.getElementById('claude-usage-btn');
            if (usageBtn) {
                usageBtn.disabled = claudeUsagePending || claudeStatus === 'thinking';
                setActionButtonLabel(usageBtn, claudeUsagePending ? 'Loading' : 'Usage');
            }
            const contextBtn = document.getElementById('claude-context-btn');
            if (contextBtn) {
                contextBtn.disabled = claudeContextPending || claudeStatus === 'thinking';
                setActionButtonLabel(contextBtn, claudeContextPending ? 'Loading' : 'Context');
            }
            renderClaudeStateBar();
            renderClaudeChat();
        }

        function shortValue(value, fallback = 'N/A') {
            const text = String(value || fallback);
            return text.length > 16 ? text.slice(0, 13) + '...' : text;
        }

        function formatTokenCount(value) {
            const number = Number(value || 0);
            if (number >= 1000000) return `${(number / 1000000).toFixed(2)}M`;
            if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
            return String(Math.round(number));
        }

        function formatClaudeDuration(durationMs) {
            const value = Number(durationMs || 0);
            if (!(value > 0)) return '';
            if (value < 1000) return `${Math.round(value)}ms`;
            const seconds = value / 1000;
            if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
            if (seconds < 60) return `${Math.round(seconds)}s`;
            const minutes = Math.floor(seconds / 60);
            return `${minutes}m ${Math.round(seconds % 60)}s`;
        }

        function renderClaudeMessageTime(message, finalOnly = false) {
            if (!message) return '';
            const timestamp = Number(finalOnly
                ? (message.completedAtMs || message.updatedAt || message.createdAt)
                : message.createdAt);
            if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
            const date = new Date(timestamp);
            if (Number.isNaN(date.getTime())) return '';
            const label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<time class="claude-message-time" datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(label)}</time>`;
        }

        function renderClaudeStateBar() {
            const el = document.getElementById('claude-state-bar');
            if (!el) return;
            const pending = Number(claudeState.pendingPermissionCount || claudePendingPermissions.filter(item => item.status === 'pending').length) || 0;
            const mode = claudeState.permissionMode || 'default';
            const parts = [];
            const attention = [];
            if (pending) {
                attention.push(`<button type="button" class="session-attention-pill approval claude-approval-jump" onclick="jumpToClaudeApproval()" title="Jump to pending approval" aria-label="Jump to pending Claude approval"><span aria-hidden="true">!</span>${pending} approval${pending > 1 ? 's' : ''}<span aria-hidden="true">↓</span></button>`);
            } else if (claudeStatus && !['idle', 'stopped', 'thinking'].includes(claudeStatus)) {
                parts.push(`<span class="claude-state-pill warn">${escapeHtml(shortValue(claudeStatus))}</span>`);
            }
            if (mode !== 'default') {
                parts.push(`<span class="claude-state-pill perm ${escapeHtml(mode)}">${escapeHtml(permissionModeLabel(mode))}</span>`);
            }
            el.innerHTML = parts.join('');
            el.style.display = parts.length ? 'flex' : 'none';
            renderSessionAttention(attention);
        }

        function jumpToClaudeApproval() {
            const pending = claudePendingPermissions.filter(item => item && item.status === 'pending');
            if (!pending.length) return false;
            const request = pending[claudeApprovalJumpIndex % pending.length];
            claudeApprovalJumpIndex = (claudeApprovalJumpIndex + 1) % pending.length;
            return focusClaudeApproval(String(request.id || ''));
        }

        function focusClaudeApproval(permissionId, retry = true) {
            const target = Array.from(document.querySelectorAll('[data-claude-permission-id]'))
                .find(element => element.dataset.claudePermissionId === permissionId);
            if (!target) {
                if (!retry) return false;
                commitClaudeChatRender();
                requestAnimationFrame(() => focusClaudeApproval(permissionId, false));
                return false;
            }
            for (let parent = target.parentElement; parent; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS') parent.open = true;
            }
            target.classList.remove('claude-approval-focus');
            void target.offsetWidth;
            target.classList.add('claude-approval-focus');
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
            target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            setTimeout(() => target.classList.remove('claude-approval-focus'), 1800);
            return true;
        }

        function prepareClaudeInfoRequest() {
            closeClaudePicker();
            claudeResumePanelOpen = false;
            claudeForkPanelOpen = false;
            document.getElementById('claude-resume-panel').classList.remove('active');
            document.getElementById('claude-fork-panel').classList.remove('active');
        }

        function requestClaudeUsage() {
            if (!currentSocket || currentSocket.readyState !== 1 || claudeUsagePending) return;
            prepareClaudeInfoRequest();
            claudeUsagePending = true;
            applyClaudeState({});
            currentSocket.send(JSON.stringify({ type: 'claude-usage' }));
        }

        function requestClaudeContext() {
            if (!currentSocket || currentSocket.readyState !== 1 || claudeContextPending) return;
            prepareClaudeInfoRequest();
            claudeContextPending = true;
            applyClaudeState({});
            currentSocket.send(JSON.stringify({ type: 'claude-context' }));
        }

        async function updateClaudeSettingsFromControls() {
            await refreshClaudeRuntimeConfig();
            const settings = {
                permissionMode: document.getElementById('claude-permission-select').value,
                model: document.getElementById('claude-model-select').value,
                effort: document.getElementById('claude-effort-select').value
            };
            applyClaudeState(settings);
            if (currentSocket && currentSocket.readyState === 1) {
                currentSocket.send(JSON.stringify({ type: 'claude-settings', settings }));
            }
        }

        function abortClaudeSession() {
            if (!currentSocket || currentSocket.readyState !== 1) return;
            currentSocket.send(JSON.stringify({ type: 'claude-abort' }));
        }

        async function toggleClaudeResumePanel() {
            claudeResumePanelOpen = !claudeResumePanelOpen;
            if (claudeResumePanelOpen) closeClaudePicker();
            claudeForkPanelOpen = false;
            document.getElementById('claude-fork-panel').classList.remove('active');
            const panel = document.getElementById('claude-resume-panel');
            panel.classList.toggle('active', claudeResumePanelOpen);
            updateTerminalControlsHeight();
            if (claudeResumePanelOpen && !claudeResumeItemsLoaded) {
                await loadClaudeResumeSessions(panel, 'resume');
            }
        }

        async function toggleClaudeForkPanel() {
            if (claudeStatus === 'thinking') return;
            claudeForkPanelOpen = !claudeForkPanelOpen;
            closeClaudePicker();
            claudeResumePanelOpen = false;
            document.getElementById('claude-resume-panel').classList.remove('active');
            const panel = document.getElementById('claude-fork-panel');
            panel.classList.toggle('active', claudeForkPanelOpen);
            updateTerminalControlsHeight();
            if (claudeForkPanelOpen) await loadClaudeResumeSessions(panel, 'fork');
        }

        async function loadClaudeResumeSessions(panel = document.getElementById('claude-resume-panel'), action = 'resume') {
            if (!activeSessionId) return;
            panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">Loading sessions...</div>';
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/claude-resume-sessions`, {}, 15000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load resume sessions');
                const items = data.items || [];
                claudeResumeItemsLoaded = true;
                if (!items.length) {
                    panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">No local Claude sessions found for this folder.</div>';
                    return;
                }
                panel.innerHTML = items.map(item => {
                    const encodedId = encodePathValue(item.id);
                    const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'Unknown';
                    const active = item.id === claudeState.resumeSessionId || item.id === claudeState.claudeSessionId;
                    const questions = Array.isArray(item.questions) ? item.questions : [];
                    const handler = action === 'fork' ? 'selectClaudeForkSession' : 'selectClaudeResumeSession';
                    return `<button class="claude-resume-item" onclick="${handler}(decodePathValue('${encodedId}'))">
                        <div class="claude-resume-title"><span>${escapeHtml(questions[0] || item.firstText || 'Claude session')}${active ? ' · current' : ''}</span><span>${escapeHtml(updated)}</span></div>
                        <div class="codex-resume-question-secondary">${escapeHtml(questions[1] || '')}</div>
                    </button>`;
                }).join('');
            } catch (e) {
                panel.innerHTML = `<div class="claude-resume-meta" style="padding:12px; color:#ff6b61;">${escapeHtml(e.message)}</div>`;
            }
        }

        function selectClaudeResumeSession(id) {
            if (!id || !currentSocket || currentSocket.readyState !== 1) return;
            currentSocket.send(JSON.stringify({ type: 'claude-resume', resumeSessionId: id }));
            applyClaudeState({ resumeSessionId: id, claudeSessionId: id });
            claudeResumePanelOpen = false;
            document.getElementById('claude-resume-panel').classList.remove('active');
            updateTerminalControlsHeight();
        }

        async function selectClaudeForkSession(id) {
            if (!id || !activeSessionId || claudeStatus === 'thinking') return;
            const panel = document.getElementById('claude-fork-panel');
            panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">Forking and switching this conversation...</div>';
            updateTerminalControlsHeight();
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/claude-fork`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ claudeSessionId: id })
                }, 60000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Unable to fork Claude session');
                applyClaudeState({ resumeSessionId: data.claudeSessionId, claudeSessionId: data.claudeSessionId });
                claudeForkPanelOpen = false;
                panel.classList.remove('active');
                panel.innerHTML = '';
            } catch (error) {
                panel.innerHTML = `<div class="claude-resume-meta" style="padding:12px;color:#ff6b61;">${escapeHtml(error.message)}</div>`;
            }
            updateTerminalControlsHeight();
        }

        function textFromClaudeMessage(message) {
            if (!message) return '';
            if (message.text) return String(message.text);
            if (message.summary) return String(message.summary);
            return '';
        }

        function escapeRegExp(text) {
            return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function inlineMarkdown(text) {
            const protectedSegments = [];
            const protect = value => `\uE000${protectedSegments.push(value) - 1}\uE001`;
            const restore = value => value.replace(/\uE000(\d+)\uE001/g, (_match, index) => protectedSegments[Number(index)] || '');
            const formatText = value => {
                const codeSegments = [];
                const protectCode = code => `\uE002${codeSegments.push(code) - 1}\uE003`;
                const restoreCode = formatted => formatted.replace(/\uE002(\d+)\uE003/g, (_match, index) => codeSegments[Number(index)] || '');
                let formatted = value.replace(/`([^`]+)`/g, (_match, code) => protectCode(`<code>${code}</code>`));
                formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                formatted = formatted.replace(/(^|[^\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>');
                formatted = formatted.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
                formatted = formatted.replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
                return restoreCode(formatted);
            };

            let html = escapeHtml(text || '');
            html = html.replace(/`([^`]+)`|!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
                (_match, code, alt, imageUrl, label, linkUrl) => {
                    if (code !== undefined) return protect(`<code>${code}</code>`);
                    if (imageUrl !== undefined) return protect(`<img src="${imageUrl}" alt="${alt}">`);
                    return protect(`<a href="${linkUrl}" target="_blank" rel="noopener noreferrer">${formatText(label)}</a>`);
                });
            return restore(formatText(html));
        }

        function parseMarkdownFenceOpener(line) {
            const match = String(line || '').match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
            if (!match) return null;
            const marker = match[1];
            const info = match[2].trim();
            if (marker[0] === '`' && info.includes('`')) return null;
            return {
                character: marker[0],
                length: marker.length,
                language: info.split(/\s+/, 1)[0] || ''
            };
        }

        function isMarkdownFenceCloser(line, opener) {
            const match = String(line || '').match(/^\s{0,3}(`+|~+)\s*$/);
            return Boolean(match && match[1][0] === opener.character && match[1].length >= opener.length);
        }

        function splitMarkdownBlocks(markdown) {
            const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
            const blocks = [];
            let i = 0;
            while (i < lines.length) {
                if (!lines[i].trim()) {
                    i++;
                    continue;
                }
                const fence = parseMarkdownFenceOpener(lines[i]);
                if (fence) {
                    const content = [];
                    i++;
                    while (i < lines.length && !isMarkdownFenceCloser(lines[i], fence)) {
                        content.push(lines[i]);
                        i++;
                    }
                    if (i < lines.length) i++;
                    blocks.push({ type: 'code', language: fence.language, content: content.join('\n') });
                    continue;
                }
                if (/^\s*[-*_]{3,}\s*$/.test(lines[i])) {
                    blocks.push({ type: 'hr' });
                    i++;
                    continue;
                }
                if (/^\s{0,3}#{1,4}\s+/.test(lines[i])) {
                    const match = lines[i].match(/^(\s{0,3})(#{1,4})\s+(.+)$/);
                    blocks.push({ type: 'header', level: match[2].length, text: match[3] });
                    i++;
                    continue;
                }
                if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
                    const rows = [lines[i]];
                    i += 2;
                    while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                        rows.push(lines[i]);
                        i++;
                    }
                    blocks.push({ type: 'table', rows });
                    continue;
                }
                if (/^\s*([-*+])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) {
                    const orderedMatch = lines[i].match(/^\s*(\d+)\.\s+/);
                    const ordered = Boolean(orderedMatch);
                    const start = ordered ? Number(orderedMatch[1]) : null;
                    const items = [];
                    while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))) {
                        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, ''));
                        i++;
                    }
                    blocks.push({ type: ordered ? 'ol' : 'ul', items, ...(ordered ? { start } : {}) });
                    continue;
                }
                if (/^\s*>\s?/.test(lines[i])) {
                    const quote = [];
                    while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                        quote.push(lines[i].replace(/^\s*>\s?/, ''));
                        i++;
                    }
                    blocks.push({ type: 'quote', text: quote.join('\n') });
                    continue;
                }
                const paragraph = [];
                while (i < lines.length && lines[i].trim()) {
                    if (parseMarkdownFenceOpener(lines[i]) || /^\s{0,3}#{1,4}\s+/.test(lines[i]) || /^\s*([-*+])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) break;
                    paragraph.push(lines[i]);
                    i++;
                }
                // Always make progress even if a future block detector and parser disagree.
                if (!paragraph.length) {
                    paragraph.push(lines[i]);
                    i++;
                }
                blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
            }
            return blocks;
        }

        function renderMarkdown(markdown) {
            const blocks = splitMarkdownBlocks(markdown);
            return `<div class="claude-md">${blocks.map(block => {
                if (block.type === 'code') {
                    const language = block.language ? `<div class="claude-tool-section-title">${escapeHtml(block.language)}</div>` : '';
                    return `<pre>${language}<code>${escapeHtml(block.content)}</code></pre>`;
                }
                if (block.type === 'hr') return '<hr>';
                if (block.type === 'header') return `<h${block.level}>${inlineMarkdown(block.text)}</h${block.level}>`;
                if (block.type === 'ul') return `<ul>${block.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`;
                if (block.type === 'ol') return `<ol${block.start !== 1 ? ` start="${block.start}"` : ''}>${block.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`;
                if (block.type === 'quote') return `<blockquote>${renderMarkdown(block.text)}</blockquote>`;
                if (block.type === 'table') return renderMarkdownTable(block.rows);
                return `<p>${inlineMarkdown(block.text).replace(/\n/g, '<br>')}</p>`;
            }).join('')}</div>`;
        }

        function renderMarkdownTable(rows) {
            const parsed = rows.map(row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()));
            if (!parsed.length) return '';
            const [head, ...body] = parsed;
            return `<table><thead><tr>${head.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        }

        function parseLocalCommandMessage(text) {
            const value = String(text || '');
            if (/^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/.test(value)) return { kind: 'hidden' };
            const stdoutMatch = value.match(/^\s*<local-command-stdout>\s*([\s\S]*?)\s*<\/local-command-stdout>\s*$/);
            if (stdoutMatch) {
                const stdout = stdoutMatch[1].trim();
                if (/^Goal set:/i.test(stdout)) return { kind: 'hidden' };
                return { kind: 'text', text: stdout };
            }
            const raw = value.trim().match(/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*?))?$/);
            if (raw) {
                return { kind: 'command', commandName: raw[1], args: raw[2] && raw[2].trim() };
            }
            const nameMatch = value.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/);
            if (nameMatch) {
                const argsMatch = value.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
                const stripped = value
                    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
                    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
                    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
                    .trim();
                if (!stripped) return { kind: 'command', commandName: nameMatch[1].trim(), args: argsMatch && argsMatch[1].trim() };
                return { kind: 'text', text: stripped };
            }
            return { kind: 'text', text: value };
        }

        function toolCategory(name) {
            if (['Bash', 'CodexBash', 'execute'].includes(name)) return 'terminal';
            if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit';
            if (['Read', 'LS'].includes(name)) return 'read';
            if (['Grep', 'Glob'].includes(name)) return 'search';
            if (['WebFetch', 'WebSearch'].includes(name)) return 'web';
            if (['Task', 'Agent'].includes(name)) return 'task';
            return 'other';
        }

        function toolIcon(category) {
            const labels = { terminal: '$', edit: '+/-', read: 'R', search: '?', web: 'W', task: 'A', other: '*' };
            return labels[category] || '*';
        }

        function toolCommand(tool) {
            const input = tool && tool.input;
            if (!input || typeof input !== 'object') return '';
            if (typeof input.command === 'string') return input.command;
            if (Array.isArray(input.command)) return input.command.join(' ');
            if (typeof input.file_path === 'string') return input.file_path;
            if (typeof input.path === 'string') return input.path;
            if (typeof input.pattern === 'string') return input.pattern;
            if (typeof input.prompt === 'string') return input.prompt;
            return tool.summary || '';
        }

        function toolTitle(tool) {
            const name = tool.name || 'Tool';
            const input = tool.input || {};
            if (name === 'Bash') return (tool.description || 'Terminal');
            if (name === 'Read' && input.file_path) return input.file_path;
            if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') return input.file_path || name;
            if (name === 'Grep') return input.pattern ? `grep(pattern: ${input.pattern})` : 'Search Content';
            if (name === 'Glob') return input.pattern || 'Search Files';
            if ((name === 'Task' || name === 'Agent') && input.description) return input.description;
            if (name.startsWith('mcp__')) return name.replace(/^mcp__/, '').replace(/__/g, ': ');
            return name;
        }

        function renderToolSection(title, value) {
            if (value === undefined || value === null || value === '') return '';
            const code = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            return `<div class="claude-tool-section"><div class="claude-tool-section-title">${escapeHtml(title)}</div><pre class="claude-tool-code">${escapeHtml(code)}</pre></div>`;
        }

        function renderClaudeDiff(oldText, newText) {
            const deleted = oldText ? String(oldText).split('\n').map(line => `<div class="codex-diff-line del">${escapeHtml(`-${line}`)}</div>`).join('') : '';
            const added = newText ? String(newText).split('\n').map(line => `<div class="codex-diff-line add">${escapeHtml(`+${line}`)}</div>`).join('') : '';
            return `<div class="codex-diff">${deleted}${added}</div>`;
        }

        function renderClaudeEditBody(tool) {
            const input = tool.input || {};
            const path = input.file_path || input.path || input.notebook_path || 'File';
            const edits = tool.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits
                : tool.name === 'Write' ? [{ old_string: '', new_string: input.content || '' }]
                    : tool.name === 'NotebookEdit' ? [{ old_string: '', new_string: input.new_source || '' }]
                        : [{ old_string: input.old_string || '', new_string: input.new_string || '' }];
            const changes = edits.map((edit, index) => `<details class="claude-edit-file"${edits.length === 1 ? ' open' : ''}>
                <summary><span class="path">${escapeHtml(path)}</span>${edits.length > 1 ? `<span class="codex-patch-kind">edit ${index + 1}</span>` : ''}</summary>
                ${renderClaudeDiff(edit.old_string, edit.new_string)}
            </details>`).join('');
            return `<div class="claude-edit-body">${changes}${tool.resultText ? renderToolSection(tool.isError ? 'Error' : 'Output', tool.resultText) : ''}</div>`;
        }

        function renderClaudeTool(tool, permission = null) {
            const category = toolCategory(tool.name || '');
            const command = toolCommand(tool);
            const status = tool.toolStatus || (tool.isError ? 'failed' : (tool.completedAtMs ? 'completed' : 'running'));
            const running = status === 'running';
            const hasResult = tool.resultText !== undefined && tool.resultText !== '';
            const duration = running ? '' : formatClaudeDuration(tool.durationMs);
            const open = tool.isError || (!hasResult && !running) ? ' open' : '';
            const compact = category === 'terminal' || category === 'search' || category === 'read';
            const body = isClaudeEditTool(tool.name) ? renderClaudeEditBody(tool)
                : compact && !tool.isError ? '' : `<div class="claude-tool-body">
                    ${renderToolSection('Input', tool.input)}
                    ${renderToolSection(tool.isError ? 'Error' : 'Output', tool.resultText)}
                </div>`;
            return `<details class="claude-tool claude-tool-card${tool.isError ? ' error' : ''}" data-claude-key="tool-${escapeHtml(tool.id || tool.toolUseId || '')}"${open}>
                <summary class="claude-tool-header">
                    <span class="claude-tool-icon" data-icon="${escapeHtml(toolIcon(category))}"></span>
                    <span class="claude-tool-title">${escapeHtml(toolTitle(tool))}</span>
                    <span class="claude-tool-command">${escapeHtml(command)}</span>
                    ${duration ? `<span class="claude-tool-duration">${escapeHtml(duration)}</span>` : ''}
                    <span class="claude-tool-status${running ? ' running' : ''}">${escapeHtml(status === 'completed' ? '' : status)}</span>
                </summary>
                ${body}${permission ? renderClaudePermission(permission, true) : ''}
            </details>`;
        }

        function renderWorkGroup(items, context) {
            const running = items.some(item => item.kind === 'tool' && item.toolStatus === 'running');
            const failed = items.some(item => item.kind === 'tool' && ['failed', 'cancelled'].includes(item.toolStatus));
            const startedAt = Math.min(...items.map(item => Number(item.startedAtMs || item.createdAt || Date.now())));
            const completedAt = Math.max(...items.map(item => Number(item.completedAtMs || 0)));
            const duration = formatClaudeDuration(!running && completedAt >= startedAt ? completedAt - startedAt : 0);
            const label = running ? 'Working' : failed ? 'Work finished with errors' : duration ? `Worked for ${duration}` : 'Worked';
            const key = items.map(item => item.id || item.toolUseId || '').join('-');
            return `<details class="claude-work-group" data-claude-key="group-${escapeHtml(key)}"${running ? ' open' : ''}>
                <summary><span class="claude-tool-icon" data-icon="*"></span><span class="claude-work-group-title">${escapeHtml(label)} · ${items.length} ${items.length > 1 ? 'tools' : 'tool'}</span>${running ? '<span class="claude-tool-status running">running</span>' : ''}</summary>
                <div class="claude-work-group-body">${items.map(item => renderDisplayItem(item, context)).join('')}</div>
            </details>`;
        }

        function buildClaudeDisplayItems(messages) {
            const items = [];
            const byToolUseId = new Map();
            const turnEndById = new Map(messages
                .filter(message => message?.kind === 'turn-end' && message.turnId)
                .map(message => [String(message.turnId), message]));
            for (const message of messages) {
                if (!message) continue;
                if (message.kind === 'turn-start' || message.kind === 'turn-end') continue;
                if (message.kind === 'tool') {
                    const item = { ...message, kind: 'tool', resultText: '', isError: false, toolStatus: message.toolStatus || 'running' };
                    items.push(item);
                    if (item.toolUseId) byToolUseId.set(item.toolUseId, item);
                    continue;
                }
                if (message.kind === 'tool-result') {
                    const parent = message.toolUseId && byToolUseId.get(message.toolUseId);
                    if (parent) {
                        parent.resultText = message.text || '';
                        parent.isError = Boolean(message.isError);
                        parent.completedAtMs = Number(message.completedAtMs || message.createdAt || Date.now());
                        parent.durationMs = Math.max(0, parent.completedAtMs - Number(parent.startedAtMs || parent.createdAt || parent.completedAtMs));
                        parent.toolStatus = parent.isError ? 'failed' : 'completed';
                    } else {
                        items.push(message);
                    }
                    continue;
                }
                items.push(message);
            }

            for (const item of items) {
                if (item.kind !== 'tool' || item.toolStatus !== 'running' || !item.turnId) continue;
                const turnEnd = turnEndById.get(String(item.turnId));
                if (!turnEnd) continue;
                item.completedAtMs = Number(turnEnd.createdAt || item.createdAt || Date.now());
                item.durationMs = Math.max(0, item.completedAtMs - Number(item.startedAtMs || item.createdAt || item.completedAtMs));
                item.toolStatus = turnEnd.turnStatus === 'failed' ? 'failed'
                    : turnEnd.turnStatus === 'cancelled' ? 'cancelled' : 'completed';
                item.isError = item.toolStatus === 'failed';
            }

            const grouped = [];
            let run = [];
            const flush = () => {
                if (run.length > 1) grouped.push({ kind: 'work-group', items: run });
                else if (run.length === 1) grouped.push(run[0]);
                run = [];
            };
            for (const item of items) {
                if (item.kind === 'tool') {
                    if (run.length && run[0].turnId !== item.turnId) flush();
                    run.push(item);
                    continue;
                }
                flush();
                grouped.push(item);
            }
            flush();
            return grouped;
        }

        function renderUserMessage(message) {
            const parsed = parseLocalCommandMessage(textFromClaudeMessage(message));
            if (parsed.kind === 'hidden') return '';
            const attachments = Array.isArray(message.attachments) && message.attachments.length
                ? `<div class="claude-message-attachments">${message.attachments.map(item => `<span class="claude-message-attachment" title="${escapeHtml(item.name || 'Attachment')}"><svg class="message-attachment-icon action-icon" aria-hidden="true"><use href="#icon-${item.kind === 'file' ? 'file' : 'image'}"></use></svg>${escapeHtml(item.name || 'Attachment')}</span>`).join('')}</div>` : '';
            if (parsed.kind === 'command') {
                const args = parsed.args ? `<div class="claude-message user">${renderMarkdown(parsed.args)}</div>` : '';
                return `${args}<div class="claude-message user"><span class="claude-command-chip">/${escapeHtml(parsed.commandName)}</span>${attachments}</div>`;
            }
            const content = parsed.text ? renderMarkdown(parsed.text) : '';
            return `<div class="claude-message user">${content}${attachments}</div>`;
        }

        function formatClaudeMoney(value, currency = 'USD') {
            const amount = Number(value || 0);
            try {
                return new Intl.NumberFormat([], { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(amount);
            } catch {
                return `$${amount.toFixed(2)}`;
            }
        }

        function claudeUsageCardItem(label, value) {
            if (value == null || value === '') return '';
            return `<div class="codex-status-item"><div class="codex-status-label">${escapeHtml(label)}</div><div class="codex-status-value">${escapeHtml(value)}</div></div>`;
        }

        function renderClaudeUsageCard(message) {
            if (message.error) {
                return `<div class="codex-status-card claude-usage-card error" data-claude-key="message-${escapeHtml(message.id || '')}">
                    <div class="codex-status-title">Claude usage</div>
                    <div class="codex-status-value">${escapeHtml(message.error)}</div>
                </div>`;
            }
            const usage = message.usage || {};
            const session = usage.session || {};
            const duration = [session.wallDuration ? `${session.wallDuration} wall` : '', session.apiDuration ? `${session.apiDuration} API` : '']
                .filter(Boolean).join(' · ');
            const tokenUsage = session.inputTokens != null || session.outputTokens != null
                ? `${formatTokenCount(session.inputTokens)} in · ${formatTokenCount(session.outputTokens)} out`
                : '';
            const cacheUsage = session.cacheReadTokens != null || session.cacheWriteTokens != null
                ? `${formatTokenCount(session.cacheReadTokens)} read · ${formatTokenCount(session.cacheWriteTokens)} write`
                : '';
            const models = Array.isArray(session.models) ? session.models : [];
            const modelItems = models.map(model => claudeUsageCardItem(
                model.model || 'Model',
                `${formatTokenCount(model.inputTokens)} in · ${formatTokenCount(model.outputTokens)} out${model.costUsd == null ? '' : ` · ${formatClaudeMoney(model.costUsd)}`}`
            )).join('');
            return `<div class="codex-status-card claude-usage-card" data-claude-key="message-${escapeHtml(message.id || '')}">
                <div class="codex-status-title">${escapeHtml(message.title || 'Claude usage')}</div>
                <div class="codex-status-grid">
                    ${claudeUsageCardItem('Session cost', session.totalCostUsd == null ? '' : formatClaudeMoney(session.totalCostUsd))}
                    ${claudeUsageCardItem('Duration', duration)}
                    ${claudeUsageCardItem('Tokens', tokenUsage)}
                    ${claudeUsageCardItem('Cache', cacheUsage)}
                    ${claudeUsageCardItem('Code changes', session.linesAdded == null && session.linesRemoved == null ? '' : `+${Number(session.linesAdded || 0)} / -${Number(session.linesRemoved || 0)}`)}
                    ${modelItems}
                </div>
            </div>`;
        }

        function renderClaudeContextCard(message) {
            if (message.error) {
                return `<div class="codex-status-card claude-context-card error" data-claude-key="message-${escapeHtml(message.id || '')}">
                    <div class="codex-status-title">Claude context</div>
                    <div class="codex-status-value">${escapeHtml(message.error)}</div>
                </div>`;
            }
            const context = message.context || {};
            const hasTotals = context.usedTokens != null && context.maxTokens != null;
            const total = hasTotals
                ? `${formatTokenCount(context.usedTokens)} / ${formatTokenCount(context.maxTokens)} · ${Number(context.usedPercent || 0)}% used`
                : '';
            const categories = Array.isArray(context.categories) ? context.categories : [];
            const categoryItems = categories.map(category => claudeUsageCardItem(
                category.label || 'Context item',
                `${formatTokenCount(category.tokens)}${category.percent ? ` · ${category.percent}` : ''}`
            )).join('');
            return `<div class="codex-status-card claude-context-card" data-claude-key="message-${escapeHtml(message.id || '')}">
                <div class="codex-status-title">${escapeHtml(message.title || 'Claude context')}</div>
                <div class="codex-status-grid">
                    ${claudeUsageCardItem('Model', context.model)}
                    ${claudeUsageCardItem('Context', total)}
                    ${claudeUsageCardItem('Available', context.remainingTokens == null ? '' : `${formatTokenCount(context.remainingTokens)} tokens`)}
                    ${categoryItems}
                </div>
            </div>`;
        }

        function renderDisplayItem(message, context = null) {
            if (!message) return '';
            if (message.kind === 'user') return `<div class="claude-message-block user" data-claude-key="message-${escapeHtml(message.id || '')}">${renderUserMessage(message)}${renderClaudeMessageTime(message)}</div>`;
            if (message.kind === 'assistant') return `<div class="claude-message-block assistant" data-claude-key="message-${escapeHtml(message.id || '')}"><div class="claude-message assistant">${renderMarkdown(textFromClaudeMessage(message))}</div>${renderClaudeMessageTime(message, true)}</div>`;
            if (message.kind === 'tool') {
                const permission = context?.permissionByToolUseId.get(String(message.toolUseId || '')) || null;
                if (permission) context.usedPermissions.add(permission.id);
                return renderClaudeTool(message, permission);
            }
            if (message.kind === 'tool-result') return `<div class="claude-tool${message.isError ? ' error' : ''}">${renderToolSection(message.isError ? 'Error' : 'Output', message.text || '')}</div>`;
            if (message.kind === 'work-group') return renderWorkGroup(message.items, context);
            if (message.kind === 'usage') return renderClaudeUsageCard(message);
            if (message.kind === 'context') return renderClaudeContextCard(message);
            if (message.kind === 'event') return `<div class="claude-message event${message.level === 'error' ? ' error' : ''}" data-claude-key="message-${escapeHtml(message.id || '')}">${escapeHtml(message.text || '')}</div>`;
            return '';
        }

        function isClaudeEditTool(name) {
            return ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name || '');
        }

        function isClaudeExitPlanTool(name) {
            return name === 'exit_plan_mode' || name === 'ExitPlanMode';
        }

        function claudeAllowToolLabel(req) {
            if (req.toolName === 'Bash' && req.input && typeof req.input.command === 'string') return 'Allow command';
            return 'Allow tool';
        }

        function renderClaudePermissionActions(req) {
            const id = escapeHtml(req.id);
            const toolName = req.toolName || '';
            const parts = [
                `<button class="small-btn primary" onclick="respondClaudePermission('${id}', 'allow-once')">Yes</button>`
            ];
            if (isClaudeEditTool(toolName) || isClaudeExitPlanTool(toolName) || req.canAllowEdits) {
                parts.push(`<button class="small-btn primary" onclick="respondClaudePermission('${id}', 'allow-edits')">Allow edits</button>`);
            }
            if (isClaudeExitPlanTool(toolName) || req.canBypass) {
                parts.push(`<button class="small-btn primary" onclick="respondClaudePermission('${id}', 'bypass')">Allow all</button>`);
            }
            if (toolName && !isClaudeEditTool(toolName) && !isClaudeExitPlanTool(toolName) && req.canAllowTool !== false) {
                parts.push(`<button class="small-btn primary" onclick="respondClaudePermission('${id}', 'allow-tool')">${escapeHtml(claudeAllowToolLabel(req))}</button>`);
            }
            parts.push(`<button class="small-btn danger" onclick="respondClaudePermission('${id}', 'deny')">Deny</button>`);
            return parts.join('');
        }

        function renderClaudePermission(req, inline = false) {
            const id = escapeHtml(String(req.id || ''));
            const body = `${req.reason ? `<div>${escapeHtml(req.reason)}</div>` : ''}
                ${req.blockedPath ? `<div class="claude-resume-meta">${escapeHtml(req.blockedPath)}</div>` : ''}
                ${renderToolSection('Input', req.input || {})}
                <div class="claude-permission-actions">${renderClaudePermissionActions(req)}</div>`;
            if (inline) {
                return `<div class="claude-inline-permission" data-claude-permission-id="${id}">
                    <div class="claude-inline-permission-title">${escapeHtml(req.title || req.toolName || 'Permission required')}</div>${body}
                </div>`;
            }
            return `<div class="claude-tool claude-permission" data-claude-key="permission-${id}" data-claude-permission-id="${id}">
                <div class="claude-tool-header"><span class="claude-tool-icon" data-icon="!"></span><strong>${escapeHtml(req.title || req.toolName || 'Permission required')}</strong></div>
                <div class="claude-tool-body">${body}</div>
            </div>`;
        }

        function syncClaudeDom(current, next) {
            if (!current || !next) return;
            if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
                current.replaceWith(next.cloneNode(true));
                return;
            }
            if (current.nodeType === Node.TEXT_NODE) {
                if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
                return;
            }
            const currentKey = current.getAttribute?.('data-claude-key');
            const nextKey = next.getAttribute?.('data-claude-key');
            if (currentKey && nextKey && currentKey !== nextKey) {
                current.replaceWith(next.cloneNode(true));
                return;
            }
            const preserveOpen = current.tagName === 'DETAILS' && currentKey === nextKey;
            const wasOpen = preserveOpen ? current.open : false;
            for (const attribute of Array.from(current.attributes || [])) {
                if (!next.hasAttribute(attribute.name) && !(preserveOpen && attribute.name === 'open')) current.removeAttribute(attribute.name);
            }
            for (const attribute of Array.from(next.attributes || [])) {
                if (!(preserveOpen && attribute.name === 'open') && current.getAttribute(attribute.name) !== attribute.value) {
                    current.setAttribute(attribute.name, attribute.value);
                }
            }
            if (preserveOpen) current.open = wasOpen;
            const currentChildren = Array.from(current.childNodes);
            const nextChildren = Array.from(next.childNodes);
            const shared = Math.min(currentChildren.length, nextChildren.length);
            for (let i = 0; i < shared; i++) syncClaudeDom(currentChildren[i], nextChildren[i]);
            for (let i = current.childNodes.length - 1; i >= nextChildren.length; i--) current.childNodes[i].remove();
            for (let i = shared; i < nextChildren.length; i++) current.appendChild(nextChildren[i].cloneNode(true));
        }

        function renderClaudeChat() {
            if (claudeRenderFrame != null) return;
            claudeRenderFrame = requestAnimationFrame(() => {
                claudeRenderFrame = null;
                commitClaudeChatRender();
            });
        }

        function commitClaudeChatRender() {
            const container = document.getElementById('claude-chat-container');
            if (!container) return;
            const wasEmpty = !container.firstElementChild;
            const previousScrollTop = container.scrollTop;
            const distanceFromBottom = container.scrollHeight - container.clientHeight - previousScrollTop;
            const shouldStickToBottom = wasEmpty || distanceFromBottom <= 64;
            const permissionByToolUseId = new Map(claudePendingPermissions
                .filter(item => item.status === 'pending' && item.toolUseId)
                .map(item => [String(item.toolUseId), item]));
            const context = { permissionByToolUseId, usedPermissions: new Set() };
            const parts = buildClaudeDisplayItems(claudeMessages).map(item => renderDisplayItem(item, context)).filter(Boolean);
            for (const req of claudePendingPermissions.filter(item => item.status === 'pending')) {
                if (!context.usedPermissions.has(req.id)) parts.push(renderClaudePermission(req));
            }
            const working = `<div class="claude-working-indicator" role="status" aria-label="Claude is working" title="Claude is working"${claudeStatus === 'thinking' ? '' : ' style="display:none"'}></div>`;
            const template = document.createElement('template');
            template.innerHTML = `<div class="claude-conversation">${working}${parts.join('') || '<div class="claude-message event">Send a message to start Claude.</div>'}</div>`;
            const next = template.content.firstElementChild;
            const current = container.firstElementChild;
            if (!current) container.appendChild(next);
            else syncClaudeDom(current, next);
            renderClaudeStateBar();
            container.scrollTop = shouldStickToBottom ? container.scrollHeight : previousScrollTop;
        }

        function applyClaudeEvent(event) {
            if (!event) return;
            if (event.type === 'message' && event.message) {
                claudeMessages.push(event.message);
                if (event.message.kind === 'usage') claudeUsagePending = false;
                if (event.message.kind === 'context') claudeContextPending = false;
            } else if (event.type === 'status') {
                claudeStatus = event.status || 'idle';
            } else if (event.type === 'permission-request' && event.request) {
                claudePendingPermissions = claudePendingPermissions.filter(item => item.id !== event.request.id);
                claudePendingPermissions.push(event.request);
            } else if (event.type === 'permission-updated' && event.request) {
                claudePendingPermissions = claudePendingPermissions.map(item => item.id === event.request.id ? event.request : item);
            } else if (event.type === 'history-reset' && Array.isArray(event.messages)) {
                claudeMessages = event.messages;
            } else if (event.type === 'state' && event.state) {
                applyClaudeState(event.state, { providerStateReceived: true });
            }
            if (event.type !== 'state') applyClaudeState({
                status: claudeStatus,
                pendingPermissionCount: claudePendingPermissions.filter(item => item.status === 'pending').length,
                canAbort: claudeStatus === 'thinking'
            }, { providerStateReceived: event.type === 'status' });
            renderClaudeChat();
        }

        function respondClaudePermission(id, actionOrApproved) {
            if (!currentSocket || currentSocket.readyState !== 1) return;
            const action = typeof actionOrApproved === 'string'
                ? actionOrApproved
                : (actionOrApproved ? 'allow-once' : 'deny');
            currentSocket.send(JSON.stringify({
                type: 'claude-permission',
                id,
                action,
                approved: action !== 'deny'
            }));
        }

        async function createSession(toolKey, sessionName) {
            const selectedSkill = window.pendingSkillHubSkill || null;
            try {
                const workingDirectory = document.getElementById('cwd-field').value;
                const runtimeConfig = toolKey === 'claude-code' ? await refreshClaudeRuntimeConfig() : null;
                const claudeOptions = runtimeConfig ? {
                    model: runtimeConfig.defaultModel || 'default',
                    effort: runtimeConfig.defaultEffort || 'medium'
                } : undefined;
                const endpoint = selectedSkill ? '/api/skillhub/sessions' : '/api/sessions';
                const body = selectedSkill ? {
                    toolKey,
                    workingDirectory,
                    skill: {
                        id: selectedSkill.id,
                        version: selectedSkill.version,
                        digest: selectedSkill.digest
                    }
                } : { toolKey, workingDirectory, claudeOptions };
                const list = document.getElementById('tools-list');
                if (selectedSkill) list.innerHTML = '<p class="skill-hall-status">Downloading and verifying Skill…</p>';
                const res = await fetchWithTimeout(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                }, selectedSkill ? 70000 : 30000);
                const data = await res.json();
                if (!res.ok || !data.id) throw new Error(data.error || 'Failed to create session');
                document.getElementById('modal-overlay').style.display = 'none';
                window.pendingSkillHubSkill = null;
                if (selectedSkill) joinSession(data.id, data.name || selectedSkill.name, 'codex');
                else refreshSessionsNow();
            } catch (e) {
                alert('Failed to create session: ' + e.message);
                if (selectedSkill) await showToolModal(selectedSkill);
            }
        }
