const claudeQuestionDrafts = new Map();

function claudeQuestionDraft(id) {
    const key = `${activeSessionId}:${id}`;
    if (!claudeQuestionDrafts.has(key)) claudeQuestionDrafts.set(key, { answers: {}, custom: {}, pending: false, error: '' });
    return claudeQuestionDrafts.get(key);
}

function renderClaudeQuestion(item, interactive = true) {
    const pending = item.questionStatus === 'pending';
    const draft = interactive && pending ? claudeQuestionDraft(item.id) : { answers: item.answers || {}, custom: {} };
    const disabled = !interactive || !pending || draft.pending || currentSocket?.readyState !== WebSocket.OPEN;
    const status = item.questionStatus === 'answered' ? 'Answer sent'
        : item.questionStatus === 'cancelled' ? 'Question closed'
        : item.questionStatus === 'historical' ? 'Earlier question'
        : interactive ? 'Waiting for your answer' : 'Open this session to answer';
    const fields = (item.questions || []).map((question, index) => {
        const key = String(question.question || `Question ${index + 1}`);
        const values = Array.isArray(draft.answers[key]) ? draft.answers[key] : draft.answers[key] ? [draft.answers[key]] : [];
        const options = (question.options || []).map(option => {
            const selected = values.includes(option.label);
            return `<button type="button" class="codex-question-option" data-claude-question-option="${index}" data-question-value="${escapeHtml(option.label)}" aria-pressed="${selected}"${disabled ? ' disabled' : ''}><span>${escapeHtml(option.label)}</span>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</button>`;
        }).join('');
        const custom = draft.custom[key] || '';
        return `<fieldset class="codex-question-field" data-claude-question-index="${index}"><legend>${escapeHtml(question.header || 'Question')}</legend><label>${escapeHtml(key)}</label><div class="codex-question-options">${options}</div><input type="text" data-claude-question-custom="${index}" value="${escapeHtml(custom)}" placeholder="Other answer"${disabled ? ' disabled' : ''}><small>${question.multiSelect ? 'Choose one or more options, or type another answer.' : 'Choose one option, or type another answer.'}</small></fieldset>`;
    }).join('');
    return `<form class="codex-question-card claude-question-card" data-claude-key="question-${escapeHtml(item.id)}" data-claude-question-id="${escapeHtml(item.id)}"><div class="codex-question-status" role="status">${escapeHtml(status)}</div>${fields}${pending && interactive ? `<div class="codex-question-error" role="alert">${escapeHtml(draft.error || '')}</div><button type="submit" class="small-btn primary"${disabled ? ' disabled' : ''}>${draft.pending ? 'Sending answer…' : 'Submit answer'}</button>` : ''}</form>`;
}

function installClaudeQuestionHandlers(container) {
    if (!container || container.dataset.claudeQuestionHandlers === 'true') return;
    container.dataset.claudeQuestionHandlers = 'true';
    container.addEventListener('click', event => {
        const option = event.target.closest('[data-claude-question-option]');
        if (!option || option.disabled) return;
        const form = option.closest('[data-claude-question-id]');
        const item = claudeMessages.find(message => message.id === form?.dataset.claudeQuestionId);
        const index = Number(option.dataset.claudeQuestionOption);
        const question = item?.questions?.[index];
        if (!question) return;
        const key = String(question.question || `Question ${index + 1}`);
        const draft = claudeQuestionDraft(item.id);
        const current = Array.isArray(draft.answers[key]) ? [...draft.answers[key]] : draft.answers[key] ? [draft.answers[key]] : [];
        const value = option.dataset.questionValue;
        if (question.multiSelect) {
            draft.answers[key] = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
        } else {
            draft.answers[key] = value;
        }
        draft.custom[key] = '';
        draft.error = '';
        renderClaudeChat();
    });
    container.addEventListener('input', event => {
        const input = event.target.closest('[data-claude-question-custom]');
        if (!input) return;
        const form = input.closest('[data-claude-question-id]');
        const item = claudeMessages.find(message => message.id === form?.dataset.claudeQuestionId);
        const index = Number(input.dataset.claudeQuestionCustom);
        const question = item?.questions?.[index];
        if (!question) return;
        const key = String(question.question || `Question ${index + 1}`);
        const draft = claudeQuestionDraft(item.id);
        draft.custom[key] = input.value;
        if (input.value.trim()) draft.answers[key] = input.value.trim();
        draft.error = '';
    });
    container.addEventListener('submit', event => {
        const form = event.target.closest('[data-claude-question-id]');
        if (!form) return;
        event.preventDefault();
        submitClaudeQuestion(form.dataset.claudeQuestionId);
    });
}

function submitClaudeQuestion(id) {
    const item = claudeMessages.find(message => message.id === id);
    const draft = claudeQuestionDraft(id);
    if (!item || item.questionStatus !== 'pending' || draft.pending || currentSocket?.readyState !== WebSocket.OPEN) return false;
    const answers = {};
    for (let index = 0; index < (item.questions || []).length; index++) {
        const question = item.questions[index];
        const key = String(question.question || `Question ${index + 1}`);
        const custom = String(draft.custom[key] || '').trim();
        const answer = custom || draft.answers[key];
        if (!answer || Array.isArray(answer) && !answer.length) {
            draft.error = 'Answer every question before submitting.';
            renderClaudeChat();
            return false;
        }
        answers[key] = answer;
    }
    draft.pending = true;
    draft.error = '';
    draft.clientMessageId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(() => settleClaudeQuestionReply(id, draft.clientMessageId, 'Reply result is unconfirmed. Check the question before retrying.'), 65000);
    try { currentSocket.send(JSON.stringify({ type: 'claude-user-input', id, answers, clientMessageId: draft.clientMessageId })); }
    catch (error) { settleClaudeQuestionReply(id, draft.clientMessageId, error.message || 'Connection unavailable. Your answer has been kept.'); return false; }
    renderClaudeChat();
    return true;
}

function jumpToClaudeQuestion() {
    const item = claudeMessages.find(message => message.kind === 'question' && message.questionStatus === 'pending');
    if (!item) return false;
    commitClaudeChatRender();
    const form = document.querySelector(`#claude-chat-container [data-claude-question-id="${CSS.escape(item.id)}"]`);
    if (!form) return false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.querySelector('input, button')?.focus({ preventScroll: true });
    return true;
}

function settleClaudeQuestionReply(id, clientMessageId, error = '') {
    const draft = claudeQuestionDrafts.get(`${activeSessionId}:${id}`);
    if (!draft || draft.clientMessageId !== clientMessageId) return;
    clearTimeout(draft.timer); draft.pending = false; draft.error = error;
    renderClaudeChat();
}
function disconnectClaudeQuestionReplies() {
    for (const [key, draft] of claudeQuestionDrafts) {
        if (!key.startsWith(`${activeSessionId}:`) || !draft.pending) continue;
        clearTimeout(draft.timer); draft.pending = false;
        draft.error = 'Reply result is unconfirmed. Your answer has been kept; check the question after reconnecting.';
    }
}
