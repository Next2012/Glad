        const codexQuestionDrafts = new Map();

        function codexQuestionDraft(id) {
            const key = `${activeSessionId}:${id}`;
            if (!codexQuestionDrafts.has(key)) codexQuestionDrafts.set(key, { answers: {}, pending: false, error: '' });
            return codexQuestionDrafts.get(key);
        }

        function renderCodexQuestion(item, interactive = true) {
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
            const questions = (item.questions || []).map((question, index) => {
                const value = draft.answers[question.id] || '';
                const fieldID = `question-${item.id}-${index}`;
                const options = available ? (question.options || []).map(option => `<button type="button" class="codex-question-option" data-question-option="${index}" data-question-value="${escapeHtml(option.label)}" aria-pressed="${value === option.label}"${disabled ? ' disabled' : ''}><span>${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</button>`).join('') : '';
                const input = !available ? '' : question.isSecret
                    ? `<input id="${escapeHtml(fieldID)}" data-question-index="${index}" type="password" autocomplete="off" required aria-label="Your answer" value="${escapeHtml(value)}"${disabled ? ' disabled' : ''}>`
                    : `<textarea id="${escapeHtml(fieldID)}" data-question-index="${index}" rows="2" required aria-label="Your answer" placeholder="Choose an option or type your answer"${disabled ? ' disabled' : ''}>${escapeHtml(value)}</textarea>`;
                return `<div class="codex-question-field"><label for="${escapeHtml(fieldID)}">${escapeHtml(question.question)}</label>${options ? `<div class="codex-question-options">${options}</div>` : ''}${input}</div>`;
            }).join('');
            return `<form class="codex-question-card" data-codex-key="question-${escapeHtml(item.id)}" data-codex-question-id="${escapeHtml(item.id)}"><div class="codex-question-status" role="status">${escapeHtml(status)}</div>${questions}${available ? `<div class="codex-question-error" role="alert">${escapeHtml(draft.error || '')}</div><button type="submit" class="small-btn primary"${disabled ? ' disabled' : ''}>${draft.pending ? 'Sending answer…' : 'Submit answer'}</button>` : ''}</form>`;
        }

        function installCodexQuestionHandlers(container) {
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
                const option = event.target.closest('[data-question-option]');
                if (!option || option.disabled) return;
                const field = option.closest('.codex-question-field').querySelector('[data-question-index]');
                field.value = option.dataset.questionValue;
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.focus();
            });
            container.addEventListener('submit', event => {
                const form = event.target.closest('[data-codex-question-id]');
                if (!form) return;
                event.preventDefault();
                void submitCodexQuestion(form.dataset.codexQuestionId);
            });
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
            const signature = JSON.stringify(answers);
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
                    body: JSON.stringify({ id, answers, clientMessageId: draft.clientMessageId })
                }, 65000);
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Could not send your answer');
                codexQuestionDrafts.delete(`${sessionId}:${id}`);
                if (activeSessionId === sessionId) {
                    const current = codexMessages.find(message => message.id === id);
                    if (current) current.questionStatus = 'answered';
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
