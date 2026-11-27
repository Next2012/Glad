(() => {
    if (!document.documentElement.classList.contains('glad-embed')) return;
    const query = new URLSearchParams(location.search);
    const roomId = query.get('embedRoom');
    const id = roomId || query.get('embedSession');
    let anchor = null;
    let activating = 0;
    let disposed = false;

    function container() {
        if (activeRoomId) return document.getElementById('room-message-list');
        if (isCodexSession()) return document.getElementById('codex-chat-container');
        if (isClaudeSession()) return document.getElementById('claude-chat-container');
        if (isAntigravitySession()) return document.getElementById('antigravity-chat-container');
        return document.querySelector('.xterm-viewport');
    }
    function capture() {
        const list = container();
        if (!list || list.clientHeight <= 0 || !list.getClientRects().length) return;
        const top = list.getBoundingClientRect().top;
        const attributes = ['data-room-entry-id', 'data-codex-key', 'data-claude-key', 'data-agy-key'];
        const element = [...list.querySelectorAll(attributes.map(key => `[${key}]`).join(','))]
            .find(item => item.getBoundingClientRect().bottom > top && item.getBoundingClientRect().height > 0
                && !attributes.some(key => item.getAttribute(key) === 'conversation-pages'));
        const attribute = element && attributes.find(key => element.hasAttribute(key));
        anchor = { list, scrollTop: list.scrollTop, bottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 64,
            attribute, id: element?.getAttribute(attribute), offset: element ? element.getBoundingClientRect().top - top : 0 };
    }
    function restore() {
        if (!anchor?.list.isConnected || anchor.list.clientHeight <= 0 || !anchor.list.getClientRects().length) return;
        const { list, attribute } = anchor;
        const element = attribute && [...list.querySelectorAll(`[${attribute}]`)].find(item => item.getAttribute(attribute) === anchor.id);
        const top = anchor.bottom ? list.scrollHeight : element
            ? list.scrollTop + element.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
            : anchor.scrollTop;
        list.scrollTo({ top, behavior: 'instant' });
    }
    function report() {
        if (disposed || !window.gladTabs?.isHosted()) return;
        if (activeRoomId) {
            if (activeRoom) window.gladTabs.update('room', activeRoomId, { name: activeRoom.name, status: activeRoom.status,
                unread: activeRoom.hasUnreadCompletion && !roomCompletionVisible(activeRoomId) });
        } else if (activeSessionId) {
            const status = isCodexSession() ? codexState.status : isClaudeSession() ? claudeStatus : isAntigravitySession() ? antigravityState.status : 'idle';
            window.gladTabs.update('session', activeSessionId, { name: document.getElementById('session-title').textContent, status,
                unread: pendingCompletionRevisions.has(activeSessionId) && !isSessionCompletionVisible(activeSessionId) });
        }
    }
    function activate() {
        window.gladPresentation?.flush();
        const generation = ++activating;
        requestAnimationFrame(() => {
            if (generation !== activating) return;
            syncLayout({ keepAtBottom: false }); restore();
            requestAnimationFrame(() => { if (generation === activating) restore(); });
        });
        for (const [sessionId, revision] of pendingCompletionRevisions) {
            if (isSessionCompletionVisible(sessionId)) void markCompletionRead(sessionId, revision);
        }
        if (activeRoom) void markRoomCompletionRead(activeRoom);
        report();
    }
    function busy() {
        return (composerUploadOwners.get(id) || 0) > 0 || window.gladTabs?.uploading('session', id)
            || composerSendInFlight() || selectedImageAttachments.some(item => item.uploading)
            || selectedFileAttachments.some(item => item.uploading) || roomSending || roomLifecycleInFlight
            || codexResumeInFlight || codexForkInFlight || claudeLifecyclePending
            || antigravityResumePending || antigravityQuestionPending.size > 0 || [...claudeQuestionDrafts.values()].some(draft => draft.pending)
            || [...codexQuestionDrafts.values()].some(draft => draft.uploading || draft.pending);
    }
    function deactivate() {
        capture(); stopTimedInputTimers({ clear: false });
        document.dispatchEvent(new Event('glad:view-hidden'));
    }
    function isConversationVisible() {
        return !disposed && Boolean(document.getElementById(roomId ? 'room-view' : 'terminal-view')?.classList.contains('active'))
            && !window.gladRoomSessionReturn;
    }
    async function dispose() {
        disposed = true;
        ++activating;
        window.gladConversationPages?.close();
        stopTimedInputTimers(); stopRoomControls();
        closeSessionSpeed();
        window.gladAntigravitySubagents?.reset();
        stopMemberControlPolling();
        if (currentSocket) { const socket = currentSocket; currentSocket = null; socket.close(); }
        activeSessionId = null; activeRoomId = null;
        const cleanup = [clearComposerAttachments()];
        for (const draft of codexQuestionDrafts.values()) for (const image of draft.images) {
            cleanup.push(fetchWithTimeout(`/api/sessions/${encodeURIComponent(id)}/attachments/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' }, 3000).catch(() => {}));
        }
        await Promise.allSettled(cleanup);
    }
    function focusAttention() {
        if (!activeSessionHydrated) return false;
        if (isCodexSession()) {
            const request = codexPendingPermissions.find(item => item.status === 'pending');
            if (request) void loadAndFocusCodexApproval(request);
            else jumpToCodexQuestion();
        } else if (isAntigravitySession()) {
            const request = antigravityPendingPermissions.find(item => item.status === 'pending');
            if (request) focusAntigravityApproval(String(request.id));
            else focusAntigravityQuestion();
        } else if (isClaudeSession()) {
            const request = claudePendingPermissions.find(item => item.status === 'pending');
            if (request) focusClaudeApproval(String(request.id));
        }
        return true;
    }
    function refreshDraft() { if (!disposed && activeSessionId === id) renderComposerAttachments(); }
    window.gladTabView = Object.freeze({ refreshDraft, capture, restore, activate, deactivate, isConversationVisible, busy, dispose, report, focusAttention });
    document.addEventListener('DOMContentLoaded', async () => {
        if (!id) return;
        try {
            if (roomId) await openRoom(roomId);
            else {
                const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/metadata`);
                if (!response.ok) throw new Error('Conversation is unavailable');
                const session = await response.json();
                const revision = query.has('completionRevision') ? Number(query.get('completionRevision')) : null;
                joinSession(session.id, session.name, session.toolKey, revision);
            }
            report();
        } catch (error) {
            const empty = document.getElementById('detail-empty');
            empty.textContent = error.message;
            empty.style.display = 'flex';
        }
    });
})();
