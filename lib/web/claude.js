        function isClaudeSession() {
            return activeToolKey === 'claude-code';
        }

        function isCodexSession() {
            return activeToolKey === 'codex';
        }

        function setClaudeModeEnabled(enabled) {
            const codexChat = isCodexSession() && codexState.presentation === 'structured';
            const structured = enabled || codexChat;
            document.getElementById('terminal-container').style.display = structured ? 'none' : '';
            document.getElementById('claude-chat-container').style.display = enabled ? 'block' : 'none';
            document.getElementById('codex-chat-container').style.display = codexChat ? 'block' : 'none';
            document.getElementById('claude-control-panel').style.display = enabled ? 'block' : 'none';
            document.getElementById('codex-control-panel').style.display = codexChat ? 'block' : 'none';
            document.getElementById('codex-terminal-switch').style.display = isCodexSession() ? '' : 'none';
            document.getElementById('timer-btn').style.display = '';
            document.getElementById('attach-image-btn').style.display = codexChat ? '' : 'none';
            document.getElementById('shortcut-rail').style.display = structured ? 'none' : '';
            document.getElementById('scroll-controls').style.display = structured ? 'none' : '';
            document.getElementById('cmd-input').placeholder = enabled ? 'Message Claude...' : codexChat ? 'Message Codex...' : 'Type a message...';
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
                ['permission', 'claude-permission-select', 'claude-permission-picker-btn', 'Perm'],
                ['model', 'claude-model-select', 'claude-model-picker-btn', 'Model'],
                ['effort', 'claude-effort-select', 'claude-effort-picker-btn', 'Effort']
            ];
            mappings.forEach(([type, selectId, buttonId, prefix]) => {
                const select = document.getElementById(selectId);
                const button = document.getElementById(buttonId);
                if (!select || !button) return;
                const option = select.selectedOptions && select.selectedOptions[0];
                const label = pickerLabelFromOption(option);
                const fullValue = pickerFullValue(option);
                button.textContent = prefix;
                button.title = fullValue || label || prefix;
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

        function closeClaudeUsagePanel() {
            claudeUsagePanelOpen = false;
            const panel = document.getElementById('claude-usage-panel');
            if (panel) panel.classList.remove('active');
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
            const options = Array.from(select.options);
            panel.innerHTML = `<div class="claude-picker-title">${escapeHtml(pickerTitle(type))}</div>${options.map(option => {
                const selected = option.value === select.value;
                const full = pickerFullValue(option);
                return `<button class="claude-picker-option${selected ? ' selected' : ''}" onclick="chooseClaudePickerOption('${type}', decodePathValue('${encodePathValue(option.value)}'))">
                    <div class="claude-picker-option-main">
                        <span>${escapeHtml(option.textContent || option.value)}</span>
                        ${selected ? '<span class="selected-label">Selected</span>' : ''}
                    </div>
                    ${full ? `<div class="claude-picker-option-value">${escapeHtml(full)}</div>` : ''}
                </button>`;
            }).join('')}`;
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
            closeClaudeUsagePanel();
            claudeResumePanelOpen = false;
            const resumePanel = document.getElementById('claude-resume-panel');
            if (resumePanel) resumePanel.classList.remove('active');
            claudePickerOpen = type;
            renderClaudePicker(type);
        }

        function chooseClaudePickerOption(type, value) {
            const select = document.getElementById(selectIdForPicker(type));
            if (!select) return;
            select.value = value;
            closeClaudePicker();
            updateClaudeSettingsFromControls();
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

        function applyClaudeState(state = {}) {
            claudeState = { ...claudeState, ...state };
            claudeStatus = claudeState.status || claudeStatus;
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
            renderClaudeStateBar();
            renderClaudeUsagePanel();
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

        function formatContextK(value) {
            return `${(Number(value || 0) / 1000).toFixed(1)}K`;
        }

        function contextRemainingPercent(usage) {
            if (!usage || typeof usage.contextSize !== 'number') return null;
            const used = Math.max(0, usage.contextSize);
            return Math.max(0, Math.min(100, 100 - (used / CLAUDE_CONTEXT_SIZE) * 100));
        }

        function renderClaudeContextSizeBadge() {
            const usage = claudeState.latestUsage;
            if (!usage || typeof usage.contextSize !== 'number') return '';
            return `<div class="claude-context-size-badge">Context ${escapeHtml(formatContextK(usage.contextSize))}</div>`;
        }

        function renderClaudeStateBar() {
            const el = document.getElementById('claude-state-bar');
            if (!el) return;
            const pending = Number(claudeState.pendingPermissionCount || claudePendingPermissions.filter(item => item.status === 'pending').length) || 0;
            const mode = claudeState.permissionMode || 'default';
            const parts = [];
            if (pending) {
                parts.push(`<span class="claude-state-pill warn">${pending} approval${pending > 1 ? 's' : ''}</span>`);
            } else if (claudeStatus === 'thinking') {
                parts.push('<span class="claude-state-pill">Working</span>');
            } else if (claudeStatus && !['idle', 'stopped'].includes(claudeStatus)) {
                parts.push(`<span class="claude-state-pill warn">${escapeHtml(shortValue(claudeStatus))}</span>`);
            }
            const remainingPercent = contextRemainingPercent(claudeState.latestUsage);
            if (remainingPercent !== null && remainingPercent <= 10) {
                parts.push(`<span class="claude-state-pill warn">${Math.round(remainingPercent)}% left</span>`);
            }
            if (mode !== 'default') {
                parts.push(`<span class="claude-state-pill perm ${escapeHtml(mode)}">${escapeHtml(permissionModeLabel(mode))}</span>`);
            }
            el.innerHTML = parts.join('');
            el.style.display = parts.length ? 'flex' : 'none';
        }

        function usageItem(label, value) {
            return `<div class="claude-usage-item">
                <div class="claude-usage-label">${escapeHtml(label)}</div>
                <div class="claude-usage-value">${escapeHtml(value)}</div>
            </div>`;
        }

        function renderClaudeUsagePanel() {
            const panel = document.getElementById('claude-usage-panel');
            if (!panel) return;
            const usage = claudeState.latestUsage;
            if (!usage) {
                panel.innerHTML = '<div class="claude-usage-title">Usage</div><div class="claude-resume-meta">No usage yet.</div>';
            } else {
                panel.innerHTML = `<div class="claude-usage-title">Usage</div>
                    <div class="claude-usage-grid">
                        ${usageItem('Total', formatTokenCount(usage.totalTokens))}
                        ${usageItem('Context', formatContextK(usage.contextSize))}
                        ${usageItem('Input', formatTokenCount(usage.inputTokens))}
                        ${usageItem('Output', formatTokenCount(usage.outputTokens))}
                        ${usageItem('Cache write', formatTokenCount(usage.cacheCreation))}
                        ${usageItem('Cache read', formatTokenCount(usage.cacheRead))}
                    </div>`;
            }
            panel.classList.toggle('active', claudeUsagePanelOpen);
        }

        function toggleClaudeUsagePanel() {
            claudeUsagePanelOpen = !claudeUsagePanelOpen;
            if (claudeUsagePanelOpen) {
                closeClaudePicker();
                claudeResumePanelOpen = false;
                const resumePanel = document.getElementById('claude-resume-panel');
                if (resumePanel) resumePanel.classList.remove('active');
            }
            renderClaudeUsagePanel();
            updateTerminalControlsHeight();
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
            if (claudeResumePanelOpen) closeClaudeUsagePanel();
            const panel = document.getElementById('claude-resume-panel');
            panel.classList.toggle('active', claudeResumePanelOpen);
            updateTerminalControlsHeight();
            if (claudeResumePanelOpen && !claudeResumeItemsLoaded) {
                await loadClaudeResumeSessions();
            }
        }

        async function loadClaudeResumeSessions() {
            const panel = document.getElementById('claude-resume-panel');
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
                    return `<button class="claude-resume-item" onclick="selectClaudeResumeSession(decodePathValue('${encodedId}'))">
                        <div class="claude-resume-title"><span>${escapeHtml(item.id.slice(0, 8))}${active ? ' · current' : ''}</span><span>${escapeHtml(updated)}</span></div>
                        <div class="claude-resume-meta">${escapeHtml(item.lastText || item.firstText || item.cwd || 'No preview')}</div>
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
            let html = escapeHtml(text || '');
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
            html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
            html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
            html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');
            html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1">');
            html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
            return html;
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
                const fence = lines[i].match(/^```(\w+)?\s*$/);
                if (fence) {
                    const language = fence[1] || '';
                    const content = [];
                    i++;
                    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                        content.push(lines[i]);
                        i++;
                    }
                    if (i < lines.length) i++;
                    blocks.push({ type: 'code', language, content: content.join('\n') });
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
                    const ordered = /^\s*\d+\.\s+/.test(lines[i]);
                    const items = [];
                    while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))) {
                        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, ''));
                        i++;
                    }
                    blocks.push({ type: ordered ? 'ol' : 'ul', items });
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
                    if (/^```/.test(lines[i]) || /^\s{0,3}#{1,4}\s+/.test(lines[i]) || /^\s*([-*+])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) break;
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
                if (block.type === 'ol') return `<ol>${block.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`;
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

        function renderClaudeTool(tool) {
            const category = toolCategory(tool.name || '');
            const command = toolCommand(tool);
            const hasResult = tool.resultText || tool.isError;
            const running = claudeStatus === 'thinking' && !hasResult;
            const status = tool.isError ? 'error' : (hasResult ? 'completed' : (running ? 'running' : 'running'));
            const open = tool.isError || (!hasResult && !running) ? ' open' : '';
            const compact = category === 'terminal' || category === 'search' || category === 'read';
            return `<details class="claude-tool claude-tool-card${tool.isError ? ' error' : ''}"${open}>
                <summary class="claude-tool-header">
                    <span class="claude-tool-icon" data-icon="${escapeHtml(toolIcon(category))}"></span>
                    <span class="claude-tool-title">${escapeHtml(toolTitle(tool))}</span>
                    <span class="claude-tool-status">${escapeHtml(status)}</span>
                    <span class="claude-tool-command">${escapeHtml(command)}</span>
                </summary>
                ${compact && !tool.isError ? '' : `<div class="claude-tool-body">
                    ${renderToolSection('Input', tool.input)}
                    ${renderToolSection(tool.isError ? 'Error' : 'Output', tool.resultText)}
                </div>`}
            </details>`;
        }

        function renderWorkGroup(items) {
            const running = items.some(item => item.kind === 'tool' && !item.resultText);
            const label = `${items.length} tool call${items.length > 1 ? 's' : ''}`;
            return `<details class="claude-work-group"${running ? ' open' : ''}>
                <summary><span class="claude-tool-icon" data-icon="*"></span><span class="claude-work-group-title">Worked on ${escapeHtml(label)}</span>${running ? '<span class="claude-tool-status">running</span>' : ''}</summary>
                <div class="claude-work-group-body">${items.map(renderDisplayItem).join('')}</div>
            </details>`;
        }

        function buildClaudeDisplayItems(messages) {
            const items = [];
            const byToolUseId = new Map();
            for (const message of messages) {
                if (!message) continue;
                if (message.kind === 'tool') {
                    const item = { ...message, kind: 'tool', resultText: '', isError: false };
                    items.push(item);
                    if (item.toolUseId) byToolUseId.set(item.toolUseId, item);
                    continue;
                }
                if (message.kind === 'tool-result') {
                    const parent = message.toolUseId && byToolUseId.get(message.toolUseId);
                    if (parent) {
                        parent.resultText = message.text || '';
                        parent.isError = Boolean(message.isError);
                    } else {
                        items.push(message);
                    }
                    continue;
                }
                items.push(message);
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
            if (parsed.kind === 'command') {
                const args = parsed.args ? `<div class="claude-message user">${renderMarkdown(parsed.args)}</div>` : '';
                return `${args}<div class="claude-message user"><span class="claude-command-chip">/${escapeHtml(parsed.commandName)}</span></div>`;
            }
            return `<div class="claude-message user">${renderMarkdown(parsed.text)}</div>`;
        }

        function renderDisplayItem(message) {
            if (!message) return '';
            if (message.kind === 'user') return renderUserMessage(message);
            if (message.kind === 'assistant') return `<div class="claude-message assistant">${renderMarkdown(textFromClaudeMessage(message))}</div>`;
            if (message.kind === 'tool') return renderClaudeTool(message);
            if (message.kind === 'tool-result') return `<div class="claude-tool${message.isError ? ' error' : ''}">${renderToolSection(message.isError ? 'Error' : 'Output', message.text || '')}</div>`;
            if (message.kind === 'work-group') return renderWorkGroup(message.items);
            if (message.kind === 'event') return `<div class="claude-message event${message.level === 'error' ? ' error' : ''}">${escapeHtml(message.text || '')}</div>`;
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

        function renderClaudeChat() {
            const container = document.getElementById('claude-chat-container');
            const parts = [renderClaudeContextSizeBadge(), ...buildClaudeDisplayItems(claudeMessages).map(renderDisplayItem)].filter(Boolean);
            for (const req of claudePendingPermissions.filter(item => item.status === 'pending')) {
                parts.push(`<div class="claude-tool claude-permission">
                    <div class="claude-tool-header">
                        <span class="claude-tool-icon" data-icon="!"></span>
                        <strong>${escapeHtml(req.title || req.toolName || 'Permission required')}</strong>
                    </div>
                    <div class="claude-tool-body">
                        ${req.reason ? `<div>${escapeHtml(req.reason)}</div>` : ''}
                        ${req.blockedPath ? `<div class="claude-resume-meta">${escapeHtml(req.blockedPath)}</div>` : ''}
                        ${renderToolSection('Input', req.input || {})}
                        <div class="claude-permission-actions">
                            ${renderClaudePermissionActions(req)}
                        </div>
                    </div>
                </div>`);
            }
            if (claudeStatus === 'thinking') {
                parts.push('<div class="claude-status">Claude is working...</div>');
            }
            container.innerHTML = parts.join('') || '<div class="claude-message event">Send a message to start Claude.</div>';
            renderClaudeStateBar();
            requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
        }

        function applyClaudeEvent(event) {
            if (!event) return;
            if (event.type === 'message' && event.message) {
                claudeMessages.push(event.message);
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
                applyClaudeState(event.state);
            }
            if (event.type !== 'state') applyClaudeState({
                status: claudeStatus,
                pendingPermissionCount: claudePendingPermissions.filter(item => item.status === 'pending').length,
                canAbort: claudeStatus === 'thinking'
            });
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
            try {
                const workingDirectory = document.getElementById('cwd-field').value;
                const runtimeConfig = toolKey === 'claude-code' ? await refreshClaudeRuntimeConfig() : null;
                const claudeOptions = runtimeConfig ? {
                    model: runtimeConfig.defaultModel || 'default',
                    effort: runtimeConfig.defaultEffort || 'medium'
                } : undefined;
                const res = await fetchWithTimeout('/api/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toolKey, workingDirectory, claudeOptions })
                });
                const data = await res.json();
                if (!res.ok || !data.id) throw new Error(data.error || 'Failed to create session');
                document.getElementById('modal-overlay').style.display = 'none';
                refreshSessionsNow();
            } catch (e) { alert('Failed to create session: ' + e.message); }
        }
