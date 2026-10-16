function prepareClaudeInfoRequest() {
    closeClaudePicker();
    closeClaudeActionPanels();
    claudeResumePanelOpen = false;
    claudeForkPanelOpen = false;
    document.getElementById('claude-resume-panel').classList.remove('active');
    document.getElementById('claude-fork-panel').classList.remove('active');
}

let claudeInfoTimer = null;
function closeClaudeInfo() {
    document.getElementById('claude-info-overlay')?.classList.remove('active');
    document.getElementById('claude-info-content')?.replaceChildren();
}

function showClaudeInfo(message = null, error = '') {
    const content = document.getElementById('claude-info-content');
    if (!content || !document.getElementById('claude-info-overlay').classList.contains('active')) return;
    content.innerHTML = message ? renderClaudeStatusCard(message) : `<p${error ? ' role="alert"' : ''}>${escapeHtml(error || 'Loading usage and context…')}</p>`;
    document.getElementById('claude-info-retry').disabled = claudeStatusPending;
}

function failClaudeInfo(error) {
    clearTimeout(claudeInfoTimer); claudeInfoTimer = null;
    claudeStatusPending = false;
    showClaudeInfo(null, error);
    applyClaudeState({});
}

function requestClaudeStatus() {
    document.getElementById('claude-info-overlay').classList.add('active');
    if (claudeStatusPending) {
        showClaudeInfo();
        return;
    }
    if (!currentSocket || currentSocket.readyState !== 1) { failClaudeInfo('Connection unavailable. Reconnect and retry.'); return; }
    prepareClaudeInfoRequest();
    closeClaudeActionPanels();
    claudeStatusPending = true;
    showClaudeInfo();
    clearTimeout(claudeInfoTimer);
    const sessionId = activeSessionId;
    claudeInfoTimer = setTimeout(() => { if (activeSessionId === sessionId) failClaudeInfo('Status query timed out. Retry the query.'); }, 70000);
    applyClaudeState({});
    try { currentSocket.send(JSON.stringify({ type: 'claude-status' })); }
    catch (error) { failClaudeInfo(error.message || 'Connection unavailable. Retry the query.'); }
}
