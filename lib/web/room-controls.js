let roomSocket = null;
let roomSocketRetry = null;
let roomLobbySocket = null;
let roomTimedInputs = [];
let roomTimedEditingId = null;
let roomTimedClock = null;
let roomAbortInFlight = false;
const roomSeenCompletions = new Map();

function roomWebSocketUrl(id = '') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws/rooms${id ? `?roomId=${encodeURIComponent(id)}` : ''}`;
}

function roomCompletionVisible(id) {
    if (document.hidden) return false;
    if (window.gladWorkspace?.isRoomTileVisible(id)) return true;
    return activeRoomId === id && document.getElementById('room-view').classList.contains('active')
        && !window.gladRoomSessionReturn;
}

async function markRoomCompletionRead(room) {
    const revision = Number(room?.completionRevision) || 0;
    if (!room?.hasUnreadCompletion || !roomCompletionVisible(room.id) || (roomSeenCompletions.get(room.id) || 0) >= revision) return;
    roomSeenCompletions.set(room.id, revision);
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(room.id)}/completion/read`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision })
        });
        if (!response.ok) throw new Error('Could not acknowledge completion');
    } catch (_) { if (roomSeenCompletions.get(room.id) === revision) roomSeenCompletions.delete(room.id); }
}

function applyRoomSnapshot(room, options = {}) {
    if (room.id !== activeRoomId) return;
    if (activeRoom?.id === room.id && Number(room.snapshotRevision) < Number(activeRoom.snapshotRevision)) return;
    if (activeRoom?.historyId && activeRoom.historyId !== room.historyId) {
        roomSelectedMentions.clear(); roomSelectedQuotes.clear(); roomPendingSend = null;
    }
    // Transport revisions can change for tool events without changing the
    // visible room. Keep them for ordering, but do not redraw for them alone.
    const signature = JSON.stringify({ ...room, snapshotRevision: undefined });
    activeRoom = room;
    if (options.force || signature !== roomRenderSignature) {
        roomRenderSignature = signature;
        renderActiveRoom(options);
        if (document.getElementById('room-members-overlay').classList.contains('active')) renderRoomMembersList();
    } else syncRoomControls();
    void markRoomCompletionRead(room);
}

function connectRoomSocket() {
    const id = activeRoomId;
    if (!id || roomSocket || window.gladRoomSessionReturn) return;
    clearTimeout(roomSocketRetry);
    const socket = new WebSocket(roomWebSocketUrl(id));
    roomSocket = socket;
    socket.onopen = () => { if (roomSocket === socket) syncRoomControls(); };
    socket.onmessage = event => {
        if (roomSocket !== socket || activeRoomId !== id) return;
        let payload;
        try { payload = JSON.parse(event.data); } catch (_) { return; }
        if (payload.type === 'room-snapshot') {
            roomTimedInputs = payload.timedInputs || [];
            applyRoomSnapshot(payload.room);
            renderRoomTimedTags();
        }
    };
    socket.onclose = () => {
        if (roomSocket !== socket) return;
        roomSocket = null;
        syncRoomControls();
        roomSocketRetry = setTimeout(() => { if (activeRoomId === id) connectRoomSocket(); }, 1500);
    };
}

function disconnectRoomSocket() {
    clearTimeout(roomSocketRetry);
    const socket = roomSocket;
    roomSocket = null;
    socket?.close();
}

function connectRoomLobbySocket() {
    if (roomLobbySocket) return;
    const socket = new WebSocket(roomWebSocketUrl());
    roomLobbySocket = socket;
    socket.onmessage = event => {
        if (roomLobbySocket !== socket) return;
        let payload;
        try { payload = JSON.parse(event.data); } catch (_) { return; }
        if (payload.type === 'room-list') renderRooms(payload.rooms);
    };
    socket.onclose = () => {
        if (roomLobbySocket !== socket) return;
        roomLobbySocket = null;
        setTimeout(connectRoomLobbySocket, 1500);
    };
}

function syncRoomControls() {
    const running = (activeRoom?.members || []).some(roomMemberIsActive) || roomMemberIsActive(activeRoom);
    const recovering = roomLifecycleInFlight || activeRoom?.resuming || activeRoom?.forking;
    const connected = roomSocket?.readyState === WebSocket.OPEN;
    const send = document.getElementById('room-send-button');
    send.disabled = !activeRoomId || roomSending || recovering || running || !connected;
    send.title = !connected ? 'Group connection unavailable' : recovering ? 'Wait for group recovery' : running ? 'Wait for the current run to finish' : 'Send';
    const abort = document.getElementById('room-abort-button');
    abort.disabled = roomAbortInFlight || activeRoom?.aborting || (!activeRoom?.canAbort && !recovering && !running);
    abort.title = recovering ? 'Cancel group recovery' : 'Stop running group sessions';
    abort.setAttribute('aria-label', recovering ? 'Cancel group recovery' : 'Stop group');
    const status = document.getElementById('room-run-status');
    status.textContent = roomAbortInFlight || activeRoom?.aborting ? 'Stopping…' : activeRoom?.forking ? 'Forking group…'
        : activeRoom?.resuming || roomLifecycleInFlight ? 'Restoring group…' : !connected ? 'Connecting…'
        : activeRoom?.status === 'waiting_approval' ? 'Waiting for approval' : activeRoom?.status === 'waiting_input' ? 'Waiting for an answer' : running ? 'Running' : '';
    status.hidden = !status.textContent;
}

async function abortRoom() {
    if (!activeRoomId || roomAbortInFlight) return;
    const id = activeRoomId;
    roomAbortInFlight = true;
    syncRoomControls();
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/abort`, { method: 'POST' }, 35000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not stop group');
        const failed = (data.results || []).filter(item => !item.success);
        if (failed.length && !roomLifecycleInFlight) alert(`${failed.length} session(s) could not be stopped: ${failed.map(item => item.error).join('; ')}`);
    } catch (error) { alert(error.message); }
    finally { roomAbortInFlight = false; syncRoomControls(); }
}

function initRoomTimerEditor() {
    const hours = document.getElementById('room-timed-hours');
    const minutes = document.getElementById('room-timed-minutes');
    if (!hours.options.length) {
        for (let i = 0; i < 24; i++) hours.add(new Option(`${i} hr`, String(i)));
        for (let i = 0; i < 60; i++) minutes.add(new Option(`${i} min`, String(i)));
        hours.value = '0'; minutes.value = '5';
    }
}

function updateRoomTimerPreview() {
    const delay = (Number(document.getElementById('room-timed-hours').value) * 60 + Number(document.getElementById('room-timed-minutes').value)) * 60000;
    document.getElementById('room-timed-preview').textContent = delay > 0 ? `Will run at ${new Date(Date.now() + delay).toLocaleString()}` : 'Choose at least 1 minute.';
    return delay;
}

function toggleRoomTimerPanel() {
    initRoomTimerEditor();
    const panel = document.getElementById('room-timed-send-panel');
    panel.classList.toggle('active');
    if (!panel.classList.contains('active')) resetRoomTimerEditor();
    updateRoomTimerPreview();
}

function resetRoomTimerEditor() {
    roomTimedEditingId = null;
    document.getElementById('room-timed-save-btn').textContent = 'Add Timer';
    document.getElementById('room-timed-editor-actions').hidden = true;
    renderRoomTimedTags();
}

function renderRoomTimedTags() {
    document.getElementById('room-timed-tag-rail').innerHTML = roomTimedInputs.map(item => `<button type="button" class="timed-tag${item.status === 'failed' ? ' failed' : ''}${item.id === roomTimedEditingId ? ' active' : ''}" aria-label="Edit scheduled group message: ${escapeHtml(item.text)}" aria-pressed="${item.id === roomTimedEditingId}" title="${escapeHtml(item.error ? `${item.text}\n${item.error}` : item.text)}" onclick="editRoomTimer('${escapeHtml(item.id)}')">${item.status === 'sending' ? 'Sending…' : timedTagContent(item)}</button>`).join('');
}

function editRoomTimer(id) {
    const item = roomTimedInputs.find(value => value.id === id);
    if (!item || item.status === 'sending') return;
    initRoomTimerEditor();
    roomTimedEditingId = id;
    document.getElementById('room-input').value = item.text;
    roomSelectedMentions = new Set(item.message?.mentionedMemberIds || []);
    roomSelectedQuotes = new Set(item.message?.quotedEntryIds || []);
    const minutes = Math.max(1, Math.ceil((item.sendAt - Date.now()) / 60000));
    document.getElementById('room-timed-hours').value = String(Math.min(23, Math.floor(minutes / 60)));
    document.getElementById('room-timed-minutes').value = String(minutes % 60);
    document.getElementById('room-timed-save-btn').textContent = 'Update Timer';
    document.getElementById('room-timed-editor-actions').hidden = false;
    document.getElementById('room-timed-send-panel').classList.add('active');
    renderRoomContextChips(); renderRoomTimedTags(); updateRoomTimerPreview();
}

async function saveRoomTimer() {
    if (!activeRoomId) return;
    if (roomPendingFiles.length) return alert('Send attachments immediately; scheduled messages contain text and references.');
    const text = document.getElementById('room-input').value;
    if (!text.trim()) return alert('Type a message first');
    const delay = updateRoomTimerPreview();
    if (!delay) return alert('Choose at least 1 minute');
    const id = activeRoomId;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/timed-inputs${roomTimedEditingId ? `/${encodeURIComponent(roomTimedEditingId)}` : ''}`, {
            method: roomTimedEditingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, sendAt: Date.now() + delay, mentionedMemberIds: [...roomSelectedMentions], quotedEntryIds: [...roomSelectedQuotes] })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not save timer');
        if (activeRoomId !== id) return;
        document.getElementById('room-input').value = '';
        roomSelectedMentions.clear(); roomSelectedQuotes.clear();
        renderRoomContextChips(); resetRoomTimerEditor();
        await loadRoomTimers(id);
    } catch (error) { alert(error.message); }
}

async function deleteRoomTimer() {
    if (!activeRoomId || !roomTimedEditingId) return;
    const id = activeRoomId;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/timed-inputs/${encodeURIComponent(roomTimedEditingId)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not delete timer');
        if (activeRoomId === id) { resetRoomTimerEditor(); await loadRoomTimers(id); }
    } catch (error) { alert(error.message); }
}

async function loadRoomTimers(id = activeRoomId) {
    if (!id) return;
    const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/timed-inputs`);
    const data = await response.json();
    if (response.ok && activeRoomId === id) { roomTimedInputs = data.items || []; renderRoomTimedTags(); }
}

function startRoomControls() {
    roomTimedInputs = [];
    resetRoomTimerEditor();
    document.getElementById('room-timed-send-panel').classList.remove('active');
    clearInterval(roomTimedClock);
    roomTimedClock = setInterval(renderRoomTimedTags, 1000);
    connectRoomSocket();
    void loadRoomTimers().catch(() => {});
}

function stopRoomControls() {
    disconnectRoomSocket();
    clearInterval(roomTimedClock); roomTimedClock = null;
    roomTimedInputs = []; resetRoomTimerEditor();
    document.getElementById('room-timed-send-panel').classList.remove('active');
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (activeRoom) void markRoomCompletionRead(activeRoom); connectRoomSocket(); } });
