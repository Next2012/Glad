        const codexQuestionDrafts = new Map();
        let codexQuestionReplyId = null;

        function codexQuestionDraft(id) {
            const key = `${activeSessionId}:${id}`;
            if (!codexQuestionDrafts.has(key)) codexQuestionDrafts.set(key, { answers: {}, images: [], uploading: false, pending: false, error: '' });
            return codexQuestionDrafts.get(key);
        }

        function renderCodexQuestion(item, interactive = true, expanded = false) {
            const pending = item.questionStatus === 'pending';
            if (interactive && !pending) codexQuestionDrafts.delete(`${activeSessionId}:${item.id}`);
            const draft = interactive && pending ? codexQuestionDraft(item.id) : { answers: {} };
            const available = interactive && pending;
            const disabled = !available || draft.pending || currentSocket?.readyState !== WebSocket.OPEN
                || codexState.aborting || codexState.resuming || codexState.forking;
            const status = item.questionStatus === 'answered' ? 'Answer sent'
                : item.questionStatus === 'historical' ? 'Earlier question · You can reply in the message box'
                : !pending ? 'Question closed'
                : !interactive ? 'Open this session to answer'
                : item.blocking ? 'Waiting for your answer' : 'You can answer while Codex continues working';
            if (available && !expanded && window.matchMedia('(max-width: 640px)').matches) {
                const title = (item.questions || []).map(question => question.question).join(' · ');
                return `<div class="codex-question-card codex-question-preview" data-codex-key="question-${escapeHtml(item.id)}" data-codex-question-id="${escapeHtml(item.id)}"><div class="codex-question-status">${escapeHtml(status)}</div><div class="codex-question-preview-text">${escapeHtml(title)}</div><button type="button" class="small-btn primary" data-open-codex-question="${escapeHtml(item.id)}">Answer question${draft.images.length ? ` · ${draft.images.length} image${draft.images.length === 1 ? '' : 's'}` : ''}</button></div>`;
            }
            const questions = (item.questions || []).map((question, index) => {
                const value = draft.answers[question.id] || '';
                const fieldID = `question-${item.id}-${index}`;
                const options = available ? (question.options || []).map(option => `<button type="button" class="codex-question-option" data-question-option="${index}" data-question-value="${escapeHtml(option.label)}" aria-pressed="${value === option.label}"${disabled ? ' disabled' : ''}><span>${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</button>`).join('') : '';
                const input = !available ? '' : question.isSecret
                    ? `<input id="${escapeHtml(fieldID)}" data-question-index="${index}" type="password" autocomplete="off" required aria-label="Your answer" value="${escapeHtml(value)}"${disabled ? ' disabled' : ''}>`
                    : `<textarea id="${escapeHtml(fieldID)}" data-question-index="${index}" rows="2" required aria-label="Your answer" placeholder="Choose an option or type your answer"${disabled ? ' disabled' : ''}>${escapeHtml(value)}</textarea>`;
                return `<div class="codex-question-field"><label for="${escapeHtml(fieldID)}">${escapeHtml(question.question)}</label>${options ? `<div class="codex-question-options">${options}</div>` : ''}${input}</div>`;
            }).join('');
            const attachments = available && !item.blocking ? renderCodexQuestionAttachments(draft, disabled) : '';
            const actions = available ? `<div class="codex-question-actions">${attachments}<div class="codex-question-error" role="alert">${escapeHtml(draft.error || '')}</div><button type="submit" class="small-btn primary"${disabled || draft.uploading ? ' disabled' : ''}>${draft.pending ? 'Sending answer…' : 'Submit answer'}</button></div>` : '';
            return `<form class="codex-question-card${expanded ? ' codex-question-expanded' : ''}" data-codex-key="question-${escapeHtml(item.id)}" data-codex-question-id="${escapeHtml(item.id)}"><div class="codex-question-body"><div class="codex-question-status" role="status">${escapeHtml(status)}</div>${questions}</div>${actions}</form>`;
        }

        function renderCodexQuestionAttachments(draft, disabled) {
            const images = (draft.images || []).map(image => {
                const remove = `<button type="button" data-remove-codex-question-image="${escapeHtml(image.id)}" aria-label="Remove ${escapeHtml(image.name || 'image')}"${disabled ? ' disabled' : ''}>×</button>`;
                return `<span class="codex-question-image">${escapeHtml(image.name || 'Screenshot')}${remove}</span>`;
            }).join('');
            const uploading = draft.uploading ? '<span class="codex-question-uploading">Uploading image…</span>' : '';
            const input = '<input type="file" accept="image/*" multiple hidden data-codex-question-file>';
            const attach = `<button type="button" class="small-btn codex-question-attach" data-add-codex-question-image${disabled || draft.uploading ? ' disabled' : ''}>Attach screenshot</button>`;
            return `<div class="codex-question-images">${images}${uploading}</div>${input}${attach}`;
        }

        function installCodexQuestionHandlers(container) {
            if (!container || container.dataset.codexQuestionHandlers === 'true') return;
            container.dataset.codexQuestionHandlers = 'true';
            container.addEventListener('input', event => {
                const field = event.target.closest('[data-question-index]');
                const form = field?.closest('[data-codex-question-id]');
                if (!form) return;
                const item = codexMessages.find(item => item.id === form.dataset.codexQuestionId);
                const question = item?.questions?.[Number(field.dataset.questionIndex)];
                if (!question) return;
                const draft = codexQuestionDraft(item.id);
                draft.answers[question.id] = field.value;
                draft.error = '';
                for (const option of field.closest('.codex-question-field').querySelectorAll('[data-question-option]')) {
                    option.setAttribute('aria-pressed', String(option.dataset.questionValue === field.value));
                }
            });
            container.addEventListener('click', event => {
                const open = event.target.closest('[data-open-codex-question]');
                if (open) {
                    openCodexQuestionReply(open.dataset.openCodexQuestion);
                    return;
                }
                const addImage = event.target.closest('[data-add-codex-question-image]');
                if (addImage && !addImage.disabled) {
                    addImage.closest('[data-codex-question-id]')?.querySelector('[data-codex-question-file]')?.click();
                    return;
                }
                const removeImage = event.target.closest('[data-remove-codex-question-image]');
                if (removeImage && !removeImage.disabled) {
                    const form = removeImage.closest('[data-codex-question-id]');
                    void removeCodexQuestionImage(form.dataset.codexQuestionId, removeImage.dataset.removeCodexQuestionImage);
                    return;
                }
                if (event.target.closest('[data-close-codex-question]')) {
                    closeCodexQuestionReply();
                    return;
                }
                const option = event.target.closest('[data-question-option]');
                if (!option || option.disabled) return;
                const field = option.closest('.codex-question-field').querySelector('[data-question-index]');
                field.value = option.dataset.questionValue;
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.focus();
            });
            container.addEventListener('change', event => {
                const input = event.target.closest('[data-codex-question-file]');
                if (!input) return;
                const form = input.closest('[data-codex-question-id]');
                const files = Array.from(input.files || []);
                input.value = '';
                if (form && files.length) void addCodexQuestionImages(form.dataset.codexQuestionId, files);
            });
            container.addEventListener('submit', event => {
                const form = event.target.closest('[data-codex-question-id]');
                if (!form) return;
                event.preventDefault();
                void submitCodexQuestion(form.dataset.codexQuestionId);
            });
        }

        function openCodexQuestionReply(id) {
            const item = codexMessages.find(message => message.id === id && message.questionStatus === 'pending');
            if (!item) return;
            codexQuestionReplyId = id;
            renderCodexQuestionReply();
        }

        function closeCodexQuestionReply() {
            codexQuestionReplyId = null;
            const controls = document.getElementById('terminal-controls');
            controls?.classList.remove('question-reply-open');
            const panel = document.getElementById('codex-question-reply');
            if (panel) panel.innerHTML = '';
        }

        function renderCodexQuestionReply() {
            const panel = document.getElementById('codex-question-reply');
            if (!panel || !codexQuestionReplyId) return;
            const item = codexMessages.find(message => message.id === codexQuestionReplyId && message.questionStatus === 'pending');
            if (!item) { closeCodexQuestionReply(); return; }
            const next = panel.cloneNode(false);
            next.innerHTML = `<div class="codex-question-reply-heading"><strong>Answer question</strong><button type="button" data-close-codex-question aria-label="Close answer panel">Done</button></div>${renderCodexQuestion(item, true, true)}`;
            // Patch existing fields so connection/stream/upload updates do not
            // replace the focused textarea or discard its selection.
            syncCodexDom(panel, next);
            document.getElementById('terminal-controls')?.classList.add('question-reply-open');
            installCodexQuestionHandlers(panel);
        }

        async function addCodexQuestionImages(id, files) {
            const item = codexMessages.find(message => message.id === id);
            if (item?.questionStatus !== 'pending' || item.blocking) return;
            const draft = codexQuestionDraft(id);
            if (draft.pending || draft.uploading) return;
            const sessionId = activeSessionId;
            const batch = files.slice(0, Math.max(0, 5 - draft.images.length));
            draft.error = batch.length !== files.length ? 'You can attach up to 5 images.' : '';
            draft.uploading = true;
            renderCodexChat();
            try {
                for (const file of batch) {
                    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
                    const upload = uploadImageInChunks(sessionId, file, () => {});
                    const image = await upload.promise;
                    if (activeSessionId !== sessionId || !codexMessages.some(message => message.id === id && message.questionStatus === 'pending')) {
                        await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/attachments/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' }).catch(() => null);
                        break;
                    }
                    draft.images.push({ ...image, name: file.name || image.name });
                    renderCodexChat();
                }
            } catch (error) {
                draft.error = `Could not attach screenshot: ${error.message}`;
            } finally {
                draft.uploading = false;
                if (activeSessionId === sessionId) renderCodexChat();
            }
        }

        async function removeCodexQuestionImage(id, imageId) {
            const draft = codexQuestionDraft(id);
            if (draft.pending) return;
            draft.images = draft.images.filter(image => image.id !== imageId);
            renderCodexChat();
            try {
                await fetchWithTimeout(`/api/sessions/${encodeURIComponent(activeSessionId)}/attachments/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
            } catch (_) { /* The session also cleans up temporary attachments. */ }
        }

        async function submitCodexQuestion(id) {
            const item = codexMessages.find(item => item.id === id);
            const draft = codexQuestionDraft(id);
            if (item?.questionStatus !== 'pending' || draft.pending || currentSocket?.readyState !== WebSocket.OPEN
                || codexState.aborting || codexState.resuming || codexState.forking) return false;
            const answers = Object.fromEntries((item.questions || []).map(question => [question.id, (draft.answers[question.id] || '').trim()]));
            if (Object.values(answers).some(answer => !answer)) {
                draft.error = 'Answer every question before submitting.';
                renderCodexChat();
                return false;
            }
            const images = [...(draft.images || [])];
            if (draft.uploading) return false;
            const signature = JSON.stringify([answers, images.map(image => image.id)]);
            if (signature !== draft.signature) {
                draft.clientMessageId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                draft.signature = signature;
            }
            const sessionId = activeSessionId;
            draft.pending = true;
            draft.error = '';
            renderCodexChat();
            try {
                const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/codex-user-input`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, answers, clientMessageId: draft.clientMessageId, attachmentIds: images.map(image => image.id) })
                }, 65000);
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Could not send your answer');
                codexQuestionDrafts.delete(`${sessionId}:${id}`);
                if (activeSessionId === sessionId) {
                    const current = codexMessages.find(message => message.id === id);
                    if (current) current.questionStatus = 'answered';
                    if (codexQuestionReplyId === id) closeCodexQuestionReply();
                }
                return true;
            } catch (error) {
                draft.error = `${error.message || 'Could not send your answer'}. Your answer has been kept.`;
                return false;
            } finally {
                draft.pending = false;
                if (activeSessionId === sessionId) {
                    renderCodexStateBar();
                    renderCodexChat();
                }
            }
        }

        function jumpToCodexQuestion() {
            const item = codexMessages.find(message => message.kind === 'question' && message.questionStatus === 'pending');
            if (!item) return;
            if (window.matchMedia('(max-width: 640px)').matches) {
                openCodexQuestionReply(item.id);
                return;
            }
            commitCodexChatRender();
            const form = Array.from(document.querySelectorAll('#codex-chat-container [data-codex-question-id]'))
                .find(form => form.dataset.codexQuestionId === item.id);
            if (!form) return;
            for (let parent = form.parentElement; parent; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS') parent.open = true;
            }
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            form.querySelector('[data-question-index]')?.focus({ preventScroll: true });
        }
