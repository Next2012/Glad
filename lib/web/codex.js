        function codexText(text) { return escapeHtml(text || '').replace(/\n/g, '<br>'); }
        function codexJson(value) {
            if (typeof value === 'string') return value;
            try { return JSON.stringify(value || {}, null, 2); } catch (_) { return String(value || ''); }
        }
        function codexToolStatus(item) {
            const status = item.toolStatus || 'running';
            if (status === 'inProgress') return 'running';
            if (status === 'failed' || status === 'declined') return status;
            if (status === 'completed') return item.exitCode && item.exitCode !== 0 ? 'failed' : 'completed';
            return status;
        }
        function formatCodexDuration(durationMs) {
            const value = Number(durationMs || 0);
            if (!(value > 0)) return '';
            if (value < 1000) return `${Math.round(value)}ms`;
            const seconds = value / 1000;
            if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
            if (seconds < 60) return `${Math.round(seconds)}s`;
            const minutes = Math.floor(seconds / 60);
            return `${minutes}m ${Math.round(seconds % 60)}s`;
        }
        function renderCodexDiff(diff) {
            return `<div class="codex-diff">${String(diff || '').split('\n').map(line => {
                const type = line.startsWith('+++') || line.startsWith('---') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
                return `<div class="codex-diff-line ${type}">${escapeHtml(line || ' ')}</div>`;
            }).join('')}</div>`;
        }
        function normalizeCodexChanges(changes) {
            if (Array.isArray(changes)) return changes.filter(Boolean).map(change => [change.path || 'File', change]);
            if (changes && typeof changes === 'object') return Object.entries(changes);
            return [];
        }
        function codexChangeDiff(change = {}) {
            if (typeof change.diff === 'string') return change.diff;
            if (typeof change.unified_diff === 'string') return change.unified_diff;
            const kind = change.kind && typeof change.kind === 'object' ? change.kind : {};
            const type = change.type || kind.type || '';
            const oldText = change.modify?.old_content ?? change.old_content ?? change.oldContent ?? (type === 'delete' ? change.content : change.delete?.content) ?? '';
            const newText = change.modify?.new_content ?? change.new_content ?? change.newContent ?? (type === 'add' ? change.content : change.add?.content) ?? '';
            if (!oldText && !newText) return '';
            return `${String(oldText).split('\n').map(line => `-${line}`).join('\n')}\n${String(newText).split('\n').map(line => `+${line}`).join('\n')}`;
        }
        function renderCodexPatch(item) {
            const entries = normalizeCodexChanges(item.changes || item.input?.changes);
            if (!entries.length) return `<div class="codex-tool-body"><pre class="codex-tool-code">${escapeHtml(codexJson(item.input))}</pre></div>`;
            return entries.map(([path, change]) => {
                const kind = change?.type || change?.kind?.type || 'edit';
                const move = change?.move_path || change?.kind?.move_path;
                const diff = codexChangeDiff(change);
                return `<details class="codex-patch-file"><summary><span class="path">${escapeHtml(path)}${move ? ` → ${escapeHtml(move)}` : ''}</span><span class="codex-patch-kind">${escapeHtml(kind)}</span></summary>${diff ? renderCodexDiff(diff) : ''}</details>`;
            }).join('');
        }
        function renderCodexPermission(request, inline = false) {
            if (!request) return '';
            const pending = request.status === 'pending';
            const permissionId = escapeHtml(String(request.id || ''));
            const labels = { approved: 'Allowed once', approved_for_session: 'Allowed for session', denied: 'Denied', abort: 'Stopped' };
            const detail = request.reason || (request.input && Object.keys(request.input).length ? codexJson(request.input) : '');
            const content = `${inline ? `<div class="codex-inline-permission-title">${escapeHtml(request.title || 'Permission required')}</div>` : ''}${detail ? `<div>${codexText(detail)}</div>` : ''}${pending ? `<div class="claude-permission-actions"><button class="small-btn primary" onclick="respondCodexPermission('${escapeHtml(request.id)}', 'approved')">Yes</button><button class="small-btn" onclick="respondCodexPermission('${escapeHtml(request.id)}', 'approved_for_session')">Yes, for session</button><button class="small-btn danger" onclick="respondCodexPermission('${escapeHtml(request.id)}', 'abort')">Stop and explain</button></div>` : `<div class="codex-permission-result">${escapeHtml(labels[request.decision] || request.status)}</div>`}`;
            if (inline) return `<div class="codex-inline-permission" data-codex-permission-id="${permissionId}">${content}</div>`;
            return `<div class="claude-tool claude-permission" data-codex-permission-id="${permissionId}"><div class="claude-tool-header"><strong>${escapeHtml(request.title || 'Permission required')}</strong></div><div class="claude-tool-body">${content}</div></div>`;
        }
        function formatCodexReset(timestamp) {
            const value = Number(timestamp || 0);
            return value ? new Date(value * 1000).toLocaleString() : '';
        }
        function formatCodexTokens(value) {
            const count = Number(value || 0);
            return count >= 1000000 ? `${(count / 1000000).toFixed(1)}M`
                : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
        }
        function codexStatusItem(label, value) {
            if (value == null || value === '') return '';
            return `<div class="codex-status-item"><div class="codex-status-label">${escapeHtml(label)}</div><div class="codex-status-value">${escapeHtml(value)}</div></div>`;
        }
        function renderCodexStatus(item) {
            const account = item.account || {};
            const limit = item.rateLimits || {};
            const primary = limit.primary;
            const secondary = limit.secondary;
            const context = item.context;
            const accountLabel = account.type === 'chatgpt'
                ? [account.email, account.planType].filter(Boolean).join(' · ')
                : account.type === 'apiKey' ? 'API key' : account.type || 'Not signed in';
            const fiveHour = primary ? `${Math.max(0, 100 - Number(primary.usedPercent || 0))}% left${primary.resetsAt ? ` · resets ${formatCodexReset(primary.resetsAt)}` : ''}` : '';
            const weekly = secondary ? `${Math.max(0, 100 - Number(secondary.usedPercent || 0))}% left${secondary.resetsAt ? ` · resets ${formatCodexReset(secondary.resetsAt)}` : ''}` : '';
            const contextLabel = context ? `${context.remainingPercent}% left${context.contextWindow ? ` · ${formatCodexTokens(context.remainingTokens)} / ${formatCodexTokens(context.contextWindow)}` : ''}` : 'Available after the first usage update';
            return `<div class="codex-status-card"><div class="codex-status-title">${escapeHtml(item.title || 'Codex status')}</div><div class="codex-status-grid">
                ${codexStatusItem('Account', accountLabel)}
                ${codexStatusItem('Model', [item.model, item.effort].filter(Boolean).join(' · '))}
                ${codexStatusItem('5h limit', fiveHour)}
                ${codexStatusItem('Weekly limit', weekly)}
                ${codexStatusItem('Context', contextLabel)}
            </div></div>`;
        }
        function renderCodexCompaction(item) {
            const running = item.compactionStatus === 'running';
            const timestamp = Number(item.completedAtMs || item.updatedAt || item.createdAt || 0);
            const date = timestamp > 0 ? new Date(timestamp) : null;
            const time = date && !Number.isNaN(date.getTime())
                ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const detail = running ? 'Compacting context…' : ['Completed', time].filter(Boolean).join(' · ');
            return `<div class="codex-compaction-card${running ? ' running' : ''}" data-codex-key="compaction-${escapeHtml(item.id || item.providerId || '')}"><span class="codex-compaction-icon" aria-hidden="true">⇣</span><div><div class="codex-compaction-title">${running ? 'Compacting context' : 'Context compacted'}</div><div class="codex-compaction-meta">${escapeHtml(detail)}</div></div></div>`;
        }
        function renderCodexWarning(item) {
            return `<div class="codex-warning-card" data-codex-key="warning-${escapeHtml(item.id || '')}" role="status"><span class="codex-warning-icon" aria-hidden="true">!</span><div><div class="codex-warning-title">Codex warning</div><div class="codex-warning-text">${codexText(item.text || 'Codex reported a warning.')}</div></div></div>`;
        }
        function renderCodexTool(item, permission = null) {
            const status = codexToolStatus(item);
            const isError = status === 'failed' || Boolean(item.error) || (item.exitCode != null && item.exitCode !== 0);
            const runningClass = status === 'running' ? ' running' : '';
            if (item.name === 'CodexPatch') {
                return `<div class="codex-tool${isError ? ' error' : ''}">${renderCodexPatch(item)}${permission ? renderCodexPermission(permission, true) : ''}</div>`;
            }
            const command = item.name === 'CodexBash' ? item.command : item.title || item.tool || '';
            const icon = item.name === 'CodexBash' ? '>_' : item.name === 'McpTool' ? 'MCP' : item.name === 'Agent' ? 'A' : '•';
            const title = item.name === 'CodexBash' ? 'Command' : item.title || item.name || 'Tool';
            const hasInput = item.input && typeof item.input === 'object' && Object.keys(item.input).length > 0;
            const result = item.result || ((item.name === 'McpTool' || item.name === 'Agent') && hasInput ? codexJson(item.input) : '');
            const duration = status === 'running' ? '' : formatCodexDuration(item.durationMs);
            return `<details class="codex-tool${isError ? ' error' : ''}" data-codex-key="tool-${escapeHtml(item.id || item.providerId || '')}"><summary class="codex-tool-header"><span class="codex-tool-icon">${escapeHtml(icon)}</span><span class="codex-tool-title">${escapeHtml(title)}</span>${command && command !== title ? `<span class="codex-tool-command">${escapeHtml(command)}</span>` : '<span class="codex-tool-command"></span>'}${duration ? `<span class="codex-tool-duration">${escapeHtml(duration)}</span>` : ''}<span class="codex-tool-state${runningClass}">${escapeHtml(status === 'completed' ? '' : status)}</span></summary>${result ? `<div class="codex-tool-body"><pre class="codex-tool-code">${escapeHtml(result)}</pre></div>` : ''}${permission ? renderCodexPermission(permission, true) : ''}</details>`;
        }
        function renderCodexToolGroup(items, permissionById, usedPermissions, turnEnd = null) {
            const running = items.some(item => codexToolStatus(item) === 'running');
            const failed = items.some(item => codexToolStatus(item) === 'failed' || item.error);
            const startedAt = Math.min(...items.map(item => Number(item.startedAtMs || item.createdAt || Date.now())));
            const itemCompletedAt = Math.max(...items.map(item => Number(item.completedAtMs || 0)));
            const storedDuration = Number(turnEnd?.durationMs || 0);
            const completedAt = Number(turnEnd?.createdAt || 0);
            const durationMs = itemCompletedAt >= startedAt ? itemCompletedAt - startedAt : storedDuration > 0 ? storedDuration
                : (!running && completedAt >= startedAt ? completedAt - startedAt : 0);
            const duration = formatCodexDuration(durationMs);
            const tools = items.map(item => {
                const permission = permissionById.get(String(item.providerId || ''));
                if (permission) usedPermissions.add(permission.id);
                return renderCodexTool(item, permission);
            }).join('');
            const label = running ? 'Working' : failed ? 'Work finished with errors' : duration ? `Worked for ${duration}` : 'Worked';
            const key = items.map(item => item.id || item.providerId || '').join('-');
            return `<details class="codex-work-group" data-codex-key="group-${escapeHtml(key)}"><summary>${label} · ${items.length} ${items.length === 1 ? 'tool' : 'tools'}</summary><div class="codex-work-group-body">${tools}</div></details>`;
        }
        function isCodexSubagentItem(item) {
            return Boolean(item?.threadId && codexState.threadId && item.threadId !== codexState.threadId);
        }
        function renderCodexSubagentGroup(threadId, items, permissionById, usedPermissions) {
            const turnEnds = items.filter(item => item.kind === 'turn-end');
            const content = items.filter(item => !['reasoning', 'turn-start', 'turn-end'].includes(item.kind));
            const tools = content.filter(item => item.kind === 'tool');
            const messages = content.filter(item => item.kind === 'assistant' || item.kind === 'user');
            const running = tools.some(item => codexToolStatus(item) === 'running')
                || items.filter(item => item.kind === 'turn-start').length > turnEnds.length;
            const startedAt = Math.min(...items.map(item => Number(item.startedAtMs || item.createdAt || Infinity)));
            const completedAt = Math.max(...turnEnds.map(item => Number(item.createdAt || 0)),
                ...content.map(item => Number(item.completedAtMs || item.updatedAt || 0)));
            const duration = formatCodexDuration(Number.isFinite(startedAt) && completedAt >= startedAt
                ? completedAt - startedAt : 0);
            const counts = [];
            if (tools.length) counts.push(`${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`);
            if (messages.length) counts.push(`${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`);
            const label = running ? 'Subagent working' : duration ? `Subagent worked for ${duration}` : 'Subagent worked';
            const body = [];
            for (let i = 0; i < content.length;) {
                const item = content[i];
                if (item.kind === 'tool') {
                    const group = [];
                    const turnId = item.turnId;
                    while (i < content.length && content[i].kind === 'tool' && content[i].turnId === turnId) group.push(content[i++]);
                    const turnEnd = turnEnds.find(candidate => candidate.turnId === turnId) || null;
                    body.push(renderCodexToolGroup(group, permissionById, usedPermissions, turnEnd));
                    continue;
                }
                if (item.kind === 'assistant' || item.kind === 'user') {
                    body.push(`<div class="codex-subagent-message${item.kind === 'user' ? ' task' : ''}">${renderMarkdown(item.text || '')}</div>`);
                } else if (item.text) {
                    body.push(`<div class="codex-subagent-message">${codexText(item.text)}</div>`);
                }
                i += 1;
            }
            const suffix = counts.length ? ` · ${counts.join(' · ')}` : '';
            return `<details class="codex-work-group codex-subagent-group" data-codex-key="subagent-${escapeHtml(threadId)}"><summary>${escapeHtml(label + suffix)}</summary><div class="codex-work-group-body">${body.join('')}</div></details>`;
        }
        function renderCodexMessageTime(item, finalOnly = false) {
            if (!item || (finalOnly && item.streaming)) return '';
            const timestamp = Number(finalOnly ? (item.completedAtMs || item.updatedAt || item.createdAt) : item.createdAt);
            if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
            const date = new Date(timestamp);
            if (Number.isNaN(date.getTime())) return '';
            const label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<time class="codex-message-time" datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(label)}</time>`;
        }
        function renderCodexContextMeter(context) {
            const total = Number(context?.contextWindow || 0);
            const remaining = Number(context?.remainingTokens || 0);
            if (!(total > 0) || !Number.isFinite(remaining)) return '';
            const reportedPercent = Number(context.remainingPercent ?? Math.round(remaining / total * 100));
            const percent = Math.max(0, Math.min(100, Number.isFinite(reportedPercent) ? reportedPercent : 0));
            const level = percent <= 20 ? ' danger' : percent <= 40 ? ' warn' : '';
            const label = `${formatCodexTokens(remaining)} / ${formatCodexTokens(total)}（${Math.round(percent)}%）`;
            return `<span class="codex-context-meter${level}" style="--context-remaining:${percent}%" title="${escapeHtml(`Context remaining: ${label}`)}" aria-label="${escapeHtml(`Context remaining: ${label}`)}">${escapeHtml(label)}</span>`;
        }
        function renderCodexMessageSkills(item) {
            const skills = Array.isArray(item?.skills) ? item.skills : [];
            return skills.map(skill => `<span class="codex-message-skill" title="${escapeHtml(skill.path || skill.name || '')}">Skill · ${escapeHtml(skill.name || 'unknown')}</span>`).join('');
        }
        function renderCodexMessageMeta(item, finalOnly = false, context = null) {
            const time = renderCodexMessageTime(item, finalOnly);
            const skills = renderCodexMessageSkills(item);
            const meter = renderCodexContextMeter(context);
            return time || skills || meter ? `<div class="codex-message-meta">${time}${skills}${meter}</div>` : '';
        }
        function syncCodexDom(current, next) {
            if (!current || !next) return;
            if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
                current.replaceWith(next.cloneNode(true));
                return;
            }
            if (current.nodeType === Node.TEXT_NODE) {
                if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
                return;
            }
            const currentKey = current.getAttribute?.('data-codex-key');
            const nextKey = next.getAttribute?.('data-codex-key');
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
            for (let i = 0; i < shared; i++) syncCodexDom(currentChildren[i], nextChildren[i]);
            for (let i = current.childNodes.length - 1; i >= nextChildren.length; i--) current.childNodes[i].remove();
            for (let i = shared; i < nextChildren.length; i++) current.appendChild(nextChildren[i].cloneNode(true));
        }
        function renderCodexChat() {
            if (codexRenderFrame != null) return;
            codexRenderFrame = requestAnimationFrame(() => {
                codexRenderFrame = null;
                commitCodexChatRender();
            });
        }
        function commitCodexChatRender() {
            const container = document.getElementById('codex-chat-container');
            if (!container) return;
            const wasEmpty = !container.firstElementChild;
            const previousScrollTop = container.scrollTop;
            const distanceFromBottom = container.scrollHeight - container.clientHeight - previousScrollTop;
            const shouldStickToBottom = wasEmpty || distanceFromBottom <= 64;
            const parts = [];
            const permissionById = new Map(codexPendingPermissions.map(item => [String(item.id), item]));
            const usedPermissions = new Set();
            const turnEndById = new Map(codexMessages.filter(item => item.kind === 'turn-end' && item.turnId)
                .map(item => [String(item.turnId), item]));
            const lastAssistantByTurn = new Map();
            for (const item of codexMessages) {
                if (item.kind === 'assistant' && item.turnId && !isCodexSubagentItem(item)) {
                    lastAssistantByTurn.set(String(item.turnId), item.id);
                }
            }
            const subagentItems = new Map();
            for (const item of codexMessages) {
                if (!isCodexSubagentItem(item)) continue;
                const threadId = String(item.threadId);
                if (!subagentItems.has(threadId)) subagentItems.set(threadId, []);
                subagentItems.get(threadId).push(item);
            }
            const renderedSubagents = new Set();
            const visible = codexMessages.filter(item => !['reasoning', 'turn-start', 'turn-end'].includes(item.kind));
            for (let i = 0; i < visible.length;) {
                const item = visible[i];
                if (isCodexSubagentItem(item)) {
                    const threadId = String(item.threadId);
                    if (!renderedSubagents.has(threadId)) {
                        renderedSubagents.add(threadId);
                        parts.push(renderCodexSubagentGroup(threadId, subagentItems.get(threadId) || [], permissionById, usedPermissions));
                    }
                    i += 1;
                    continue;
                }
                if (item.kind === 'tool') {
                    const tools = [];
                    const turnId = item.turnId;
                    while (i < visible.length && visible[i].kind === 'tool' && visible[i].turnId === turnId) tools.push(visible[i++]);
                    parts.push(renderCodexToolGroup(tools, permissionById, usedPermissions,
                        turnEndById.get(String(turnId || ''))));
                    continue;
                }
                if (item.kind === 'assistant') {
                    const turnId = String(item.turnId || '');
                    const turnEnd = turnEndById.get(turnId);
                    const context = lastAssistantByTurn.get(turnId) === item.id ? turnEnd?.context : null;
                    parts.push(`<div class="codex-message-block assistant" data-codex-key="message-${escapeHtml(item.id || '')}"><div class="codex-message assistant claude-md">${renderMarkdown(item.text || '')}</div>${renderCodexMessageMeta(item, true, context)}</div>`);
                }
                else if (item.kind === 'user') parts.push(`<div class="codex-message-block user" data-codex-key="message-${escapeHtml(item.id || '')}"><div class="codex-message user claude-md">${renderMarkdown(item.text || '')}</div>${renderCodexMessageMeta(item)}</div>`);
                else if (item.kind === 'compaction') parts.push(renderCodexCompaction(item));
                else if (item.kind === 'status') parts.push(renderCodexStatus(item));
                else if (item.kind === 'event' && item.level === 'warning') parts.push(renderCodexWarning(item));
                else parts.push(`<div class="codex-message ${escapeHtml(item.level === 'error' ? 'event error' : item.kind || 'event')}">${codexText(item.text)}</div>`);
                i += 1;
            }
            for (const request of codexPendingPermissions) if (!usedPermissions.has(request.id)) parts.push(renderCodexPermission(request));
            const skillBubble = selectedCodexSkill && codexState.status === 'idle'
                ? `<div class="codex-skill-bubble" role="status" aria-label="Selected skill: ${escapeHtml(selectedCodexSkill.name)}"><span class="codex-skill-bubble-name">Skill · ${escapeHtml(selectedCodexSkill.name)}</span><button type="button" class="codex-skill-bubble-close" onclick="clearCodexSkillSelection()" title="Remove selected skill" aria-label="Remove selected skill">×</button></div>`
                : '';
            const working = `<div class="codex-working-indicator" role="status" aria-label="Codex is working" title="Codex is working"${codexState.status === 'running' ? '' : ' style="display:none"'}></div>`;
            const template = document.createElement('template');
            template.innerHTML = `<div class="codex-conversation">${skillBubble}${working}${parts.join('') || '<div class="codex-message event">Send a message to start Codex.</div>'}</div>`;
            const next = template.content.firstElementChild;
            const current = container.firstElementChild;
            if (!current) container.appendChild(next);
            else syncCodexDom(current, next);
            if (codexHistoryPrependAnchor) {
                const anchor = codexHistoryPrependAnchor;
                codexHistoryPrependAnchor = null;
                container.scrollTop = anchor.scrollTop + Math.max(0, container.scrollHeight - anchor.scrollHeight);
            } else {
                container.scrollTop = shouldStickToBottom ? container.scrollHeight : previousScrollTop;
            }
        }

        function applyCodexHistoryPageMeta(page = {}) {
            codexHistoryBeforeId = page?.beforeId || codexMessages[0]?.id || null;
            codexHistoryHasMore = Boolean(page?.hasMore);
            codexHistoryLoading = false;
        }

        function handleCodexHistoryScroll(event) {
            if (event?.isTrusted) codexHistoryUserScrolled = true;
            if (!codexHistoryUserScrolled || !codexHistoryHasMore || codexHistoryLoading) return;
            const container = event?.currentTarget || document.getElementById('codex-chat-container');
            const scrollRange = Math.max(0, container.scrollHeight - container.clientHeight);
            if (container.scrollTop > scrollRange * 0.5) return;
            if (!codexHistoryBeforeId || currentSocket?.readyState !== 1) return;
            codexHistoryLoading = true;
            currentSocket.send(JSON.stringify({ type: 'codex-history-before', beforeId: codexHistoryBeforeId }));
        }

        function applyCodexHistoryPage(page = {}) {
            const older = Array.isArray(page.messages) ? page.messages : [];
            const knownIds = new Set(codexMessages.map(item => String(item.id || '')));
            const uniqueOlder = older.filter(item => item?.id && !knownIds.has(String(item.id)));
            const container = document.getElementById('codex-chat-container');
            if (uniqueOlder.length && container) {
                codexHistoryPrependAnchor = {
                    scrollTop: container.scrollTop,
                    scrollHeight: container.scrollHeight
                };
                codexMessages = [...uniqueOlder, ...codexMessages];
            }
            applyCodexHistoryPageMeta(page);
            if (uniqueOlder.length) renderCodexChat();
        }

        function applyCodexState(state = {}) {
            const presentationChanged = state.presentation !== undefined && state.presentation !== codexState.presentation;
            codexState = { ...codexState, ...state };
            const permission = document.getElementById('codex-permission-select');
            if (permission) {
                const defaultOption = permission.querySelector('option[value="default"]');
                const labels = { untrusted: 'Untrusted', 'on-request': 'On request', never: 'Never ask' };
                if (defaultOption) defaultOption.textContent = codexState.effectivePermissionMode
                    ? `Default (${labels[codexState.effectivePermissionMode] || codexState.effectivePermissionMode})`
                    : 'Default';
                permission.value = codexState.permissionMode || 'default';
            }
            const sandbox = document.getElementById('codex-sandbox-select');
            if (sandbox) {
                const defaultOption = sandbox.querySelector('option[value="default"]');
                const labels = { 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'Full access' };
                if (defaultOption) defaultOption.textContent = codexState.effectiveSandboxMode
                    ? `Default (${labels[codexState.effectiveSandboxMode] || codexState.effectiveSandboxMode})`
                    : 'Default';
                sandbox.value = codexState.sandboxMode || 'default';
            }
            const modelButton = document.getElementById('codex-model-btn');
            if (modelButton) modelButton.textContent = 'Model';
            const abort = document.getElementById('codex-abort-btn');
            if (abort) abort.disabled = !codexState.canAbort;
            const compact = document.getElementById('codex-compact-btn');
            if (compact) { compact.disabled = !codexState.canCompact; compact.textContent = codexState.compacting ? 'Compacting' : 'Compact'; }
            const skills = document.getElementById('codex-skills-btn');
            if (skills) { skills.disabled = !(codexState.presentation === 'structured' && codexState.status === 'idle'); skills.classList.toggle('primary', Boolean(selectedCodexSkill)); }
            const fork = document.getElementById('codex-fork-btn');
            if (fork) fork.disabled = !(codexState.presentation === 'structured' && codexState.status === 'idle');
            const terminal = document.getElementById('codex-terminal-switch');
            if (terminal) { terminal.textContent = codexState.presentation === 'terminal' ? 'CHAT' : 'TERM'; terminal.disabled = codexState.presentation === 'structured' && !codexState.canSwitchToTerminal; terminal.title = codexState.presentation === 'terminal' ? 'Return to Codex chat' : 'Switch to Codex terminal'; }
            renderCodexStateBar();
            renderCodexModelPanel();
            if (presentationChanged) setClaudeModeEnabled(isClaudeSession());
            renderCodexChat();
        }

        function renderCodexStateBar() {
            const el = document.getElementById('codex-state-bar');
            if (!el) return;
            const pending = Number(codexState.pendingPermissionCount || codexPendingPermissions.filter(item => item.status === 'pending').length) || 0;
            const subagents = Number(codexState.activeSubagentCount || 0) || 0;
            const parts = [];
            if (pending || codexState.status === 'waiting_approval') parts.push(`<button type="button" class="claude-state-pill warn codex-approval-jump" onclick="jumpToCodexApproval()" title="Jump to pending approval" aria-label="Jump to pending approval">${pending || 1} approval${pending === 1 ? '' : 's'}<span aria-hidden="true">↓</span></button>`);
            if (subagents) parts.push(`<span class="claude-state-pill">${subagents} subagent${subagents === 1 ? '' : 's'} running</span>`);
            el.innerHTML = parts.join('');
            el.style.display = parts.length ? 'flex' : 'none';
        }

        function jumpToCodexApproval() {
            const pending = codexPendingPermissions.filter(item => item && item.status === 'pending');
            if (!pending.length) return false;
            const request = pending[codexApprovalJumpIndex % pending.length];
            codexApprovalJumpIndex = (codexApprovalJumpIndex + 1) % pending.length;
            return focusCodexApproval(String(request.id || ''));
        }

        function focusCodexApproval(permissionId, retry = true) {
            const target = Array.from(document.querySelectorAll('[data-codex-permission-id]'))
                .find(element => element.dataset.codexPermissionId === permissionId);
            if (!target) {
                if (!retry) return false;
                commitCodexChatRender();
                requestAnimationFrame(() => focusCodexApproval(permissionId, false));
                return false;
            }

            for (let parent = target.parentElement; parent; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS') parent.open = true;
            }
            target.classList.remove('codex-approval-focus');
            void target.offsetWidth;
            target.classList.add('codex-approval-focus');
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
            target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            setTimeout(() => target.classList.remove('codex-approval-focus'), 1800);
            return true;
        }

        function toggleCodexModelPanel() {
            codexModelPanelOpen = !codexModelPanelOpen;
            codexResumePanelOpen = false;
            codexForkPanelOpen = false;
            codexPromptPanelOpen = false;
            codexSkillPanelOpen = false;
            codexModelCandidate = codexState.model || codexState.models?.[0]?.id || null;
            document.getElementById('codex-resume-panel').classList.remove('active');
            document.getElementById('codex-fork-panel').classList.remove('active');
            document.getElementById('codex-prompt-panel').classList.remove('active');
            document.getElementById('codex-skill-panel').classList.remove('active');
            renderCodexModelPanel();
            updateTerminalControlsHeight();
        }

        function renderCodexModelPanel() {
            const panel = document.getElementById('codex-model-panel');
            if (!panel) return;
            panel.classList.toggle('active', codexModelPanelOpen);
            if (!codexModelPanelOpen) { panel.innerHTML = ''; return; }
            const models = codexState.models || [];
            const candidate = models.find(item => item.id === codexModelCandidate) || models.find(item => item.id === codexState.model) || models[0];
            if (!candidate) { panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">Loading models...</div>'; return; }
            codexModelCandidate = candidate.id;
            const efforts = candidate.efforts?.length ? candidate.efforts : [candidate.defaultEffort || 'medium'];
            panel.innerHTML = `<div class="codex-picker-column">${models.map(item => `<button class="codex-picker-option${item.id === candidate.id ? ' selected' : ''}" onclick="selectCodexModelCandidate(decodePathValue('${encodePathValue(item.id)}'))">${escapeHtml(item.label || item.id)}</button>`).join('')}</div><div class="codex-picker-column">${efforts.map(effort => `<button class="codex-picker-option${candidate.id === codexState.model && effort === codexState.effort ? ' selected' : ''}" onclick="chooseCodexModelEffort(decodePathValue('${encodePathValue(candidate.id)}'), decodePathValue('${encodePathValue(effort)}'))">${escapeHtml(effort)}</button>`).join('')}</div>`;
        }

        function selectCodexModelCandidate(model) { codexModelCandidate = model; renderCodexModelPanel(); }
        function chooseCodexModelEffort(model, effort) {
            codexModelPanelOpen = false;
            applyCodexState({ model, effort });
            sendCodexSettings({ model, effort });
            updateTerminalControlsHeight();
        }

        function applyCodexEvent(event) {
            if (!event) return;
            if (event.type === 'message' && event.message) codexMessages.push(event.message);
            else if (event.type === 'message-updated' && event.message) { const i = codexMessages.findIndex(item => item.id === event.message.id); if (i >= 0) codexMessages[i] = event.message; else codexMessages.push(event.message); }
            else if (event.type === 'history-reset') {
                codexMessages = event.messages || [];
                codexHistoryUserScrolled = false;
                codexHistoryPrependAnchor = null;
                applyCodexHistoryPageMeta(event.historyPage);
            }
            else if (event.type === 'permission-request' && event.request) { codexPendingPermissions = [...codexPendingPermissions.filter(item => item.id !== event.request.id), event.request]; }
            else if (event.type === 'permission-updated' && event.request) codexPendingPermissions = codexPendingPermissions.map(item => item.id === event.request.id ? event.request : item);
            if (event.state) applyCodexState(event.state); else renderCodexChat();
        }

        function sendCodexSettings(settings) { if (currentSocket?.readyState === 1) currentSocket.send(JSON.stringify({ type: 'codex-settings', settings })); }
        function updateCodexSettingsFromControls() {
            const permissionMode = document.getElementById('codex-permission-select').value;
            const sandboxMode = document.getElementById('codex-sandbox-select').value;
            applyCodexState({ permissionMode, sandboxMode });
            sendCodexSettings({ permissionMode, sandboxMode });
        }
        function abortCodexSession() { if (currentSocket?.readyState === 1) currentSocket.send(JSON.stringify({ type: 'codex-abort' })); }
        function requestCodexStatus() { if (currentSocket?.readyState === 1) currentSocket.send(JSON.stringify({ type: 'codex-status' })); }
        function compactCodexContext() {
            if (!codexState.canCompact || currentSocket?.readyState !== 1) return false;
            currentSocket.send(JSON.stringify({ type: 'codex-compact' }));
            applyCodexState({ canCompact: false, compacting: true });
            return true;
        }
        function respondCodexPermission(id, decision) { if (currentSocket?.readyState === 1) currentSocket.send(JSON.stringify({ type: 'codex-permission', id, decision })); }
        async function toggleCodexResumePanel() {
            codexResumePanelOpen = !codexResumePanelOpen;
            codexModelPanelOpen = false;
            codexForkPanelOpen = false;
            codexPromptPanelOpen = false;
            codexSkillPanelOpen = false;
            document.getElementById('codex-model-panel').classList.remove('active');
            document.getElementById('codex-fork-panel').classList.remove('active');
            document.getElementById('codex-prompt-panel').classList.remove('active');
            document.getElementById('codex-skill-panel').classList.remove('active');
            const panel = document.getElementById('codex-resume-panel');
            panel.classList.toggle('active', codexResumePanelOpen);
            updateTerminalControlsHeight();
            if (!codexResumePanelOpen) return;
            await loadCodexThreadPanel(panel, 'resume');
        }
        async function toggleCodexForkPanel() {
            if (!(codexState.presentation === 'structured' && codexState.status === 'idle')) return;
            codexForkPanelOpen = !codexForkPanelOpen;
            codexModelPanelOpen = false;
            codexResumePanelOpen = false;
            codexPromptPanelOpen = false;
            codexSkillPanelOpen = false;
            document.getElementById('codex-model-panel').classList.remove('active');
            document.getElementById('codex-resume-panel').classList.remove('active');
            document.getElementById('codex-prompt-panel').classList.remove('active');
            document.getElementById('codex-skill-panel').classList.remove('active');
            const panel = document.getElementById('codex-fork-panel');
            panel.classList.toggle('active', codexForkPanelOpen);
            updateTerminalControlsHeight();
            if (!codexForkPanelOpen) return;
            await loadCodexThreadPanel(panel, 'fork');
        }
        async function loadCodexThreadPanel(panel, action) {
            panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">Loading sessions...</div>';
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-resume-threads`, {}, 30000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load Codex sessions');
                const items = data.items || [];
                panel.innerHTML = items.length ? items.map(item => {
                    const questions = Array.isArray(item.questions) ? item.questions : [];
                    const handler = action === 'fork' ? 'selectCodexForkThread' : 'selectCodexResumeThread';
                    return `<button class="claude-resume-item" onclick="${handler}(decodePathValue('${encodePathValue(item.id)}'))"><div class="claude-resume-title"><span>${escapeHtml((questions[0] || 'Codex session').slice(0, 120))}${item.current ? ' · current' : ''}</span><span>${escapeHtml(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '')}</span></div><div class="codex-resume-question-secondary">${escapeHtml((questions[1] || '').slice(0, 120))}</div></button>`;
                }).join('') : '<div class="claude-resume-meta" style="padding:12px;">No Codex sessions found for this folder.</div>';
            } catch (e) { panel.innerHTML = `<div class="claude-resume-meta" style="padding:12px;color:#ff6b61;">${escapeHtml(e.message)}</div>`; }
            updateTerminalControlsHeight();
        }
        function formatCodexPromptTime(timestamp) {
            const value = Number(timestamp || 0);
            if (!value) return '';
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        }
        function renderCodexPromptPanel(error = '') {
            const panel = document.getElementById('codex-prompt-panel');
            if (!panel) return;
            const previousScrollTop = panel.scrollTop;
            panel.classList.toggle('active', codexPromptPanelOpen);
            if (!codexPromptPanelOpen) return;
            const countLabel = codexPromptTotal ? `${codexPromptItems.length} / ${codexPromptTotal}${codexPromptTotal >= 200 ? ' max' : ''}` : '';
            const items = codexPromptItems.map((item, index) => {
                const expanded = codexExpandedPrompts.has(index);
                return `<div class="codex-prompt-item"><button type="button" class="codex-prompt-text${expanded ? ' expanded' : ''}" onclick="toggleCodexPromptExpanded(${index})" title="${expanded ? 'Collapse prompt' : 'Expand prompt'}">${escapeHtml(item.text || '')}</button><div class="codex-prompt-actions"><span class="codex-prompt-time">${escapeHtml(formatCodexPromptTime(item.createdAt))}</span><button type="button" class="small-btn codex-prompt-copy" data-codex-prompt-copy="${index}" onclick="copyCodexPrompt(${index})">Copy</button></div></div>`;
            }).join('');
            const empty = !items && !codexPromptLoading && !error
                ? '<div class="claude-resume-meta" style="padding:12px;">No text prompts found for this folder.</div>' : '';
            const footer = codexPromptHasMore || codexPromptLoading
                ? `<div class="codex-prompt-footer"><button type="button" class="small-btn primary" onclick="loadMoreCodexPrompts()"${codexPromptLoading ? ' disabled' : ''}>${codexPromptLoading ? 'Loading…' : 'Load more'}</button></div>` : '';
            panel.innerHTML = `<div class="codex-prompt-header"><span>Prompt history</span><span>${escapeHtml(countLabel)}</span></div>${error ? `<div class="claude-resume-meta" style="padding:12px;color:#ff6b61;">${escapeHtml(error)}</div>` : ''}${items}${empty}${footer}`;
            panel.scrollTop = previousScrollTop;
            updateTerminalControlsHeight();
        }
        async function toggleCodexPromptPanel() {
            codexPromptPanelOpen = !codexPromptPanelOpen;
            codexModelPanelOpen = false;
            codexResumePanelOpen = false;
            codexForkPanelOpen = false;
            codexSkillPanelOpen = false;
            document.getElementById('codex-model-panel').classList.remove('active');
            document.getElementById('codex-resume-panel').classList.remove('active');
            document.getElementById('codex-fork-panel').classList.remove('active');
            document.getElementById('codex-skill-panel').classList.remove('active');
            if (!codexPromptPanelOpen) {
                document.getElementById('codex-prompt-panel').classList.remove('active');
                updateTerminalControlsHeight();
                return;
            }
            codexPromptItems = [];
            codexPromptNextOffset = 0;
            codexPromptHasMore = false;
            codexPromptTotal = 0;
            codexExpandedPrompts = new Set();
            renderCodexPromptPanel();
            await loadMoreCodexPrompts();
        }
        async function loadMoreCodexPrompts() {
            if (codexPromptLoading || !codexPromptPanelOpen || codexPromptNextOffset >= 200) return;
            codexPromptLoading = true;
            renderCodexPromptPanel();
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-prompts?offset=${codexPromptNextOffset}&limit=30`, {}, 60000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load prompt history');
                codexPromptItems.push(...(data.items || []));
                codexPromptNextOffset = Number(data.nextOffset || codexPromptItems.length);
                codexPromptHasMore = Boolean(data.hasMore) && codexPromptNextOffset < 200;
                codexPromptTotal = Math.min(200, Number(data.total || codexPromptItems.length));
                codexPromptLoading = false;
                renderCodexPromptPanel();
            } catch (error) {
                codexPromptLoading = false;
                renderCodexPromptPanel(error.message);
            }
        }
        function toggleCodexPromptExpanded(index) {
            if (codexExpandedPrompts.has(index)) codexExpandedPrompts.delete(index);
            else codexExpandedPrompts.add(index);
            renderCodexPromptPanel();
        }
        async function copyCodexPrompt(index) {
            const prompt = codexPromptItems[index]?.text;
            if (!prompt) return;
            try {
                await copyTextToClipboard(prompt);
                const button = document.querySelector(`[data-codex-prompt-copy="${index}"]`);
                if (!button) return;
                button.textContent = 'Copied';
                setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1200);
            } catch (_) {
                alert('Copy failed.');
            }
        }

        const CODEX_RECENT_SKILLS_KEY = 'glad.codex.recentSkills';

        function codexSkillIdentity(skill) {
            return `${String(skill?.name || '')}\n${String(skill?.path || '')}`;
        }

        function codexSkillDisplayName(skill) {
            return String(skill?.interface?.displayName || skill?.name || 'Unknown skill');
        }

        function codexSkillDescription(skill) {
            return String(skill?.interface?.shortDescription || skill?.shortDescription || skill?.description || '');
        }

        function codexSkillDirectory(skill) {
            const path = String(skill?.path || '').replace(/\\/g, '/');
            const separator = path.lastIndexOf('/');
            const directory = separator > 0 ? path.slice(0, separator) : path;
            const skillRoot = directory.toLowerCase().lastIndexOf('/skills/');
            return skillRoot >= 0 ? directory.slice(skillRoot + '/skills/'.length) : directory.split('/').filter(Boolean).pop() || directory;
        }

        function codexSkillSource(skill) {
            const scope = String(skill?.scope || '').toLowerCase();
            const path = String(skill?.path || '').replace(/\\/g, '/').toLowerCase();
            if (['repo', 'project', 'workspace'].includes(scope)) return { group: 'project', label: 'Project' };
            if (['user', 'personal'].includes(scope)) return { group: 'personal', label: 'Personal' };
            if (scope === 'plugin') return { group: 'other', label: 'Plugin' };
            if (['system', 'admin', 'builtin', 'built-in'].includes(scope)) return { group: 'other', label: 'System' };
            if (path.includes('/plugins/')) return { group: 'other', label: 'Plugin' };
            if (path.includes('/.system/')) return { group: 'other', label: 'System' };
            if (path.includes('/.codex/skills/')) return { group: 'personal', label: 'Personal' };
            if (path.includes('/.agents/skills/')) return { group: 'project', label: 'Project' };
            return { group: 'other', label: scope ? scope[0].toUpperCase() + scope.slice(1) : 'Other' };
        }

        function compareCodexSkills(left, right) {
            return codexSkillDisplayName(left).localeCompare(codexSkillDisplayName(right), undefined, {
                sensitivity: 'base',
                numeric: true
            }) || String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base', numeric: true })
                || String(left.path || '').localeCompare(String(right.path || ''), undefined, { sensitivity: 'base', numeric: true });
        }

        function readRecentCodexSkills() {
            try {
                const value = JSON.parse(localStorage.getItem(CODEX_RECENT_SKILLS_KEY) || '[]');
                return Array.isArray(value) ? value.filter(item => item?.name && item?.path).slice(0, 3) : [];
            } catch (_) {
                return [];
            }
        }

        function rememberCodexSkill(skill) {
            const key = codexSkillIdentity(skill);
            const recent = readRecentCodexSkills().filter(item => codexSkillIdentity(item) !== key);
            recent.unshift({ name: skill.name, path: skill.path });
            try { localStorage.setItem(CODEX_RECENT_SKILLS_KEY, JSON.stringify(recent.slice(0, 3))); } catch (_) {}
        }

        function scoreCodexSkillSearch(skill, query) {
            const tokens = String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
            if (!tokens.length) return 0;
            const source = codexSkillSource(skill);
            const fields = [
                String(skill.name || '').toLocaleLowerCase(),
                codexSkillDisplayName(skill).toLocaleLowerCase(),
                codexSkillDescription(skill).toLocaleLowerCase(),
                source.label.toLocaleLowerCase(),
                String(skill.scope || '').toLocaleLowerCase(),
                String(skill.path || '').toLocaleLowerCase()
            ];
            let score = 0;
            for (const token of tokens) {
                let tokenScore = Number.POSITIVE_INFINITY;
                fields.forEach((field, fieldIndex) => {
                    const position = field.indexOf(token);
                    if (position < 0) return;
                    const exactBonus = field === token ? -4 : position === 0 ? -2 : 0;
                    tokenScore = Math.min(tokenScore, fieldIndex * 10 + position + exactBonus);
                });
                if (!Number.isFinite(tokenScore)) return null;
                score += tokenScore;
            }
            return score;
        }

        function codexSkillItemHtml(item, index) {
            const selected = selectedCodexSkill?.name === item.name && selectedCodexSkill?.path === item.path;
            const displayName = codexSkillDisplayName(item);
            const description = codexSkillDescription(item);
            const source = codexSkillSource(item);
            const fullName = String(item.name || displayName);
            const directory = codexSkillDirectory(item);
            return `<button type="button" class="codex-skill-item${selected ? ' selected' : ''}" data-codex-skill-path="${escapeHtml(item.path || '')}" title="${escapeHtml(item.path || displayName)}" onclick="selectCodexSkill(${index})"><span class="codex-skill-item-name"><span>${escapeHtml(fullName)}</span><span class="codex-skill-source">${escapeHtml(source.label)}</span></span>${description ? `<span class="codex-skill-description">${escapeHtml(description)}</span>` : ''}<span class="codex-skill-meta"><span class="codex-skill-directory" title="${escapeHtml(directory)}">Dir · ${escapeHtml(directory)}</span></span></button>`;
        }

        function codexSkillSectionHtml(title, entries) {
            if (!entries.length) return '';
            return `<section class="codex-skill-section"><div class="codex-skill-section-title"><span>${escapeHtml(title)}</span><span>${entries.length}</span></div>${entries.map(entry => codexSkillItemHtml(entry.item, entry.index)).join('')}</section>`;
        }

        function codexSkillResultsHtml() {
            const entries = codexSkillItems.map((item, index) => ({ item, index }));
            const query = codexSkillQuery.trim();
            let sections = '';
            if (query) {
                const matches = entries.map(entry => ({ ...entry, score: scoreCodexSkillSearch(entry.item, query) }))
                    .filter(entry => entry.score != null)
                    .sort((left, right) => left.score - right.score || compareCodexSkills(left.item, right.item));
                sections = codexSkillSectionHtml('Search results', matches);
            } else {
                const byIdentity = new Map(entries.map(entry => [codexSkillIdentity(entry.item), entry]));
                const recent = readRecentCodexSkills().map(item => byIdentity.get(codexSkillIdentity(item))).filter(Boolean);
                const recentKeys = new Set(recent.map(entry => codexSkillIdentity(entry.item)));
                const remaining = entries.filter(entry => !recentKeys.has(codexSkillIdentity(entry.item)));
                const group = name => remaining.filter(entry => codexSkillSource(entry.item).group === name)
                    .sort((left, right) => compareCodexSkills(left.item, right.item));
                sections = codexSkillSectionHtml('Recently used', recent)
                    + codexSkillSectionHtml('Current project', group('project'))
                    + codexSkillSectionHtml('Personal', group('personal'))
                    + codexSkillSectionHtml('Other', group('other'));
            }
            const emptyText = query ? 'No skills match your search.' : 'No enabled skills found for this folder.';
            const empty = !sections && !codexSkillLoading && !codexSkillError
                ? `<div class="claude-resume-meta codex-skill-empty">${emptyText}</div>` : '';
            return `${codexSkillError ? `<div class="claude-resume-meta codex-skill-error">${escapeHtml(codexSkillError)}</div>` : ''}${sections}${empty}`;
        }

        function renderCodexSkillPanel(focusSearch = false) {
            const panel = document.getElementById('codex-skill-panel');
            if (!panel) return;
            panel.classList.toggle('active', codexSkillPanelOpen);
            if (!codexSkillPanelOpen) { panel.innerHTML = ''; return; }
            panel.innerHTML = `<div class="codex-skill-header"><div class="codex-skill-header-row"><span>Available skills</span><span>${codexSkillLoading ? 'Loading…' : codexSkillItems.length}</span></div><input id="codex-skill-search" class="codex-skill-search" type="search" aria-label="Search skills" placeholder="Search skills…" value="${escapeHtml(codexSkillQuery)}" oninput="updateCodexSkillQuery(this.value)" autocomplete="off" spellcheck="false"></div><div id="codex-skill-results">${codexSkillResultsHtml()}</div>`;
            if (focusSearch) {
                requestAnimationFrame(() => {
                    const search = document.getElementById('codex-skill-search');
                    if (!search) return;
                    search.focus({ preventScroll: true });
                    search.setSelectionRange(search.value.length, search.value.length);
                });
            }
            updateTerminalControlsHeight();
        }

        function updateCodexSkillQuery(value) {
            codexSkillQuery = String(value || '');
            const results = document.getElementById('codex-skill-results');
            if (results) results.innerHTML = codexSkillResultsHtml();
            else renderCodexSkillPanel(true);
            updateTerminalControlsHeight();
        }

        async function toggleCodexSkillPanel() {
            if (!(codexState.presentation === 'structured' && codexState.status === 'idle')) return;
            codexSkillPanelOpen = !codexSkillPanelOpen;
            codexModelPanelOpen = false;
            codexResumePanelOpen = false;
            codexForkPanelOpen = false;
            codexPromptPanelOpen = false;
            document.getElementById('codex-model-panel').classList.remove('active');
            document.getElementById('codex-resume-panel').classList.remove('active');
            document.getElementById('codex-fork-panel').classList.remove('active');
            document.getElementById('codex-prompt-panel').classList.remove('active');
            if (!codexSkillPanelOpen) {
                renderCodexSkillPanel();
                updateTerminalControlsHeight();
                return;
            }
            codexSkillLoading = true;
            codexSkillQuery = '';
            codexSkillError = '';
            codexSkillItems = [];
            renderCodexSkillPanel(true);
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-skills?forceReload=true`, {}, 30000);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load skills');
                codexSkillItems = data.skills || [];
                codexSkillLoading = false;
                codexSkillError = (data.errors || []).map(item => item.message || String(item)).filter(Boolean).join(' · ');
                renderCodexSkillPanel(true);
            } catch (error) {
                codexSkillLoading = false;
                codexSkillError = error.message;
                renderCodexSkillPanel(true);
            }
        }

        function selectCodexSkill(index) {
            const skill = codexSkillItems[index];
            if (!skill) return;
            const alreadySelected = selectedCodexSkill?.name === skill.name && selectedCodexSkill?.path === skill.path;
            selectedCodexSkill = alreadySelected ? null : { name: skill.name, path: skill.path };
            if (selectedCodexSkill) rememberCodexSkill(skill);
            codexSkillPanelOpen = false;
            renderCodexSkillPanel();
            applyCodexState({});
            updateTerminalControlsHeight();
        }

        function clearCodexSkillSelection() {
            selectedCodexSkill = null;
            applyCodexState({});
        }
        async function selectCodexResumeThread(threadId) {
            const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }) }, 30000);
            if (!res.ok) { alert((await res.json()).error || 'Unable to resume Codex thread'); return; }
            codexResumePanelOpen = false;
            document.getElementById('codex-resume-panel').classList.remove('active');
            updateTerminalControlsHeight();
        }
        async function selectCodexForkThread(threadId) {
            const panel = document.getElementById('codex-fork-panel');
            panel.innerHTML = '<div class="claude-resume-meta" style="padding:12px;">Forking and switching this conversation...</div>';
            updateTerminalControlsHeight();
            const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }) }, 60000);
            const data = await res.json();
            if (!res.ok || !data.success) {
                panel.innerHTML = `<div class="claude-resume-meta" style="padding:12px;color:#ff6b61;">${escapeHtml(data.error || 'Unable to fork Codex thread')}</div>`;
                updateTerminalControlsHeight();
                return;
            }
            codexForkPanelOpen = false;
            panel.classList.remove('active');
            panel.innerHTML = '';
            updateTerminalControlsHeight();
        }
        async function toggleCodexPresentation() {
            const presentation = codexState.presentation === 'terminal' ? 'structured' : 'terminal';
            const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/codex-presentation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presentation }) }, 30000);
            if (!res.ok) alert((await res.json()).error || 'Unable to switch Codex interface');
        }
