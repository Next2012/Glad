let activeRoomId = null;
let activeRoom = null;
let roomPollTimer = null;
let roomSending = false;
let roomSelectedMentions = new Set();
let roomSelectedQuotes = new Set();
let roomPendingFiles = [];
let roomExpandedEntries = new Set();
let roomRenderSignature = '';
let roomMentionPickerOpen = false;
let roomLifecycleInFlight = false;
let roomHistoryOpen = false;
let roomHistoryPreferredAction = 'resume';
let roomHistoryItems = [];
const roomHistoryPreviews = new Map();

function roomMemberMap() {
    return new Map((activeRoom?.members || []).map(member => [String(member.id), member]));
}

function activeRoomTitle() {
    const count = (activeRoom?.members || []).filter(member => !member.leftAt).length;
    return `${activeRoom?.name || 'Group'} (${count})`;
}

function roomMemberIsActive(member) {
    return ['running', 'thinking', 'waiting_approval', 'waiting_input'].includes(String(member?.status || ''));
}

function roomAvatar(member, extraClass = '') {
    const name = member?.displayName || '?';
    const fallback = member?.toolKey === 'claude-code' ? '#2563EB' : member?.toolKey === 'codex' ? '#EA580C' : '#7C3AED';
    const color = /^#[0-9a-f]{6}$/i.test(String(member?.avatarColor || '')) ? member.avatarColor : fallback;
    return `<span class="room-avatar ${extraClass}" style="--room-avatar-color:${escapeHtml(color)}" aria-hidden="true">${escapeHtml(Array.from(name.trim())[0] || '?')}</span>`;
}

async function loadRooms() {
    const list = document.getElementById('rooms-list');
    if (!list) return;
    try {
        const response = await fetchWithTimeout('/api/rooms');
        const rooms = await response.json();
        if (!response.ok) throw new Error(rooms.error || `HTTP ${response.status}`);
        list.innerHTML = rooms.length ? rooms.map(room => {
            const encodedName = encodePathValue(room.name || 'New group');
            return `<article class="session-card room-list-card${room.id === activeRoomId ? ' selected' : ''}" data-room-id="${escapeHtml(room.id)}">
                <span class="active-session-dot" title="Current group" aria-label="Current group"></span>
                <div class="session-info">
                    <h3><span class="session-name room-list-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span><button type="button" class="icon-btn session-edit-btn room-list-edit" title="Rename group" aria-label="Rename group" onclick="renameRoomFromLobby('${escapeHtml(room.id)}',decodePathValue('${encodedName}'),event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></h3>
                    <p>Group · ${Number(room.memberCount) || 0} sessions · ${Number(room.messageCount) || 0} messages</p>
                    <p>${new Date(room.updatedAt || room.createdAt).toLocaleTimeString()}</p>
                </div>
                <div class="session-actions">
                    ${renderServerChanRoomAction(room)}
                    <button class="btn-join" type="button" onclick="openRoom('${escapeHtml(room.id)}')">Connect</button>
                    <button class="icon-btn btn-delete session-delete-btn" type="button" onclick="deleteRoom('${escapeHtml(room.id)}', event)" title="Delete group" aria-label="Delete group"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                </div>
            </article>`;
        }).join('') : '<p class="room-empty-lobby">No group chats</p>';
    } catch (error) {
        list.innerHTML = `<div class="room-load-error">Could not load groups: ${escapeHtml(error.message)}<br><button class="small-btn" onclick="loadRooms()">Retry</button></div>`;
    }
}

async function renameRoomFromLobby(id, oldName, event) {
    event?.stopPropagation();
    const name = prompt('Group name', oldName || 'New group');
    if (!name || name.trim() === oldName) return;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        await loadRooms();
    } catch (error) { alert(`Could not rename group: ${error.message}`); }
}

async function createRoomFromLobby() {
    try {
        const response = await fetchWithTimeout('/api/rooms', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'New group' })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        await loadRooms();
        await openRoom(data.id);
    } catch (error) {
        alert(`Could not create group: ${error.message}`);
    }
}

async function renameActiveRoom() {
    if (!activeRoom) return;
    const name = prompt('Group name', activeRoom.name || 'New group');
    if (!name || name.trim() === activeRoom.name) return;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoom.id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        activeRoom.name = data.name;
        document.getElementById('room-title').textContent = activeRoomTitle();
        void loadRooms();
    } catch (error) { alert(`Could not rename group: ${error.message}`); }
}

async function deleteRoom(id, event) {
    event?.stopPropagation();
    if (!confirm('Delete this group index? Sessions and provider histories are not deleted.')) return;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (activeRoomId === id) closeRoom();
        await loadRooms();
    } catch (error) {
        alert(`Could not delete group: ${error.message}`);
    }
}

async function openRoom(id, options = {}) {
    activeRoomId = id;
    document.body.classList.add('room-open');
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
    if (!options.keepSelections) {
        roomSelectedMentions.clear();
        roomSelectedQuotes.clear();
        roomPendingFiles = [];
        roomMentionPickerOpen = false;
    }
    clearTimeout(roomPollTimer);
    if (currentSocket && !window.gladRoomSessionReturn) { currentSocket.close(); currentSocket = null; }
    document.querySelectorAll('#detail-pane > .view').forEach(view => view.classList.remove('active'));
    document.getElementById('room-view').classList.add('active');
    document.getElementById('detail-empty')?.classList.add('room-hidden');
    try {
        await refreshActiveRoom({ force: true, stickBottom: true });
        void restoreLinkedRoomSessions(id);
    } catch (error) {
        document.getElementById('room-message-list').innerHTML = `<div class="room-load-error">${escapeHtml(error.message)}</div>`;
    }
    scheduleRoomPoll();
}

function closeRoom() {
    clearTimeout(roomPollTimer);
    roomPollTimer = null;
    activeRoomId = null;
    activeRoom = null;
    roomRenderSignature = '';
    roomSelectedMentions.clear();
    roomSelectedQuotes.clear();
    roomPendingFiles = [];
    roomMentionPickerOpen = false;
    roomHistoryOpen = false;
    document.body.classList.remove('room-open');
    document.getElementById('detail-empty')?.classList.remove('room-hidden');
    showLobby();
}

async function refreshActiveRoom(options = {}) {
    if (!activeRoomId) return;
    const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoomId)}`, {}, 15000);
    const room = await response.json();
    if (!response.ok) throw new Error(room.error || `HTTP ${response.status}`);
    if (room.id !== activeRoomId) return;
    const signature = JSON.stringify({
        updatedAt: room.updatedAt,
        members: room.members.map(item => [item.id, item.sessionId, item.available, item.leftAt, item.status, item.pendingPermissionCount, item.pendingQuestionCount]),
        entries: room.entries.map(item => [item.id, item.status, item.text, item.error])
    });
    activeRoom = room;
    if (options.force || signature !== roomRenderSignature) {
        roomRenderSignature = signature;
        renderActiveRoom(options);
    } else {
        renderRoomContextChips();
    }
}

function scheduleRoomPoll() {
    clearTimeout(roomPollTimer);
    if (!activeRoomId || window.gladRoomSessionReturn) return;
    const active = (activeRoom?.entries || []).some(entry => ['pending', 'running'].includes(entry.status))
        || (activeRoom?.members || []).some(roomMemberIsActive);
    const delay = document.hidden ? 15000 : active ? 1000 : 5000;
    roomPollTimer = setTimeout(async () => {
        try { await refreshActiveRoom(); } catch (_) {}
        scheduleRoomPoll();
    }, delay);
}

function renderActiveRoom(options = {}) {
    if (!activeRoom) return;
    const activeMembers = activeRoom.members.filter(member => !member.leftAt);
    document.getElementById('room-title').textContent = activeRoomTitle();
    const attention = activeMembers.filter(member => Number(member.pendingPermissionCount) > 0 || Number(member.pendingQuestionCount) > 0);
    const attentionRail = document.getElementById('room-attention-rail');
    attentionRail.innerHTML = attention.map(member => `<button type="button" class="room-attention-pill" onclick="openRoomAttention('${escapeHtml(member.id)}')">
        <span class="room-attention-dot"></span><strong>${escapeHtml(member.displayName)}</strong><span>${Number(member.pendingPermissionCount) > 0 ? 'Permission required' : 'Waiting for answer'}</span>
    </button>`).join('');
    attentionRail.classList.toggle('active', attention.length > 0);

    const list = document.getElementById('room-message-list');
    const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    const members = roomMemberMap();
    list.innerHTML = activeRoom.entries.length ? activeRoom.entries.map(entry => renderRoomEntry(entry, members)).join('')
        : `<div class="room-empty-state"><strong>This group is empty</strong><span>${activeMembers.length ? 'Use the @ button below to choose sessions.' : 'Add a session from Members to begin.'}</span></div>`;
    installRoomMessageHandlers(list);
    renderRoomContextChips();
    renderRoomMentionPicker();
    renderRoomFileChips();
    if (options.stickBottom || wasNearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function renderRoomEntry(entry, members) {
    const user = entry.type === 'user';
    const member = user ? null : members.get(String(entry.memberId));
    const author = user ? 'You' : (member?.displayName || 'Session');
    const providerName = member ? (member.toolName || member.toolKey || 'Provider') : '';
    const selected = roomSelectedQuotes.has(entry.id);
    const expanded = roomExpandedEntries.has(entry.id);
    const unavailable = entry.status === 'unavailable';
    const running = ['pending', 'running'].includes(entry.status);
    let content = entry.text || '';
    if (running && !content) content = `${author} is working…`;
    if (unavailable) content = 'Message unavailable. The original session could not be read.';
    if (entry.status === 'failed') content = entry.error || 'This session could not answer.';
    const quotes = (entry.quotedEntryIds || []).length
        ? `<button type="button" class="room-entry-reference" data-room-quote-bundle="${escapeHtml(entry.id)}"><span>Chat history</span><strong>${entry.quotedEntryIds.length} message${entry.quotedEntryIds.length === 1 ? '' : 's'}</strong><span aria-hidden="true">›</span></button>` : '';
    const mentions = user && (entry.mentionedMemberIds || []).length
        ? `<div class="room-entry-mentions">${entry.mentionedMemberIds.map(id => '@' + (members.get(String(id))?.displayName || 'Session')).map(escapeHtml).join(' ')}</div>` : '';
    const needsPermission = !user && member && Number(member.pendingPermissionCount) > 0;
    const needsAnswer = !user && member && Number(member.pendingQuestionCount) > 0;
    const attention = needsPermission || needsAnswer
        ? `<button type="button" class="room-entry-attention" onclick="openRoomAttention('${escapeHtml(member.id)}')"><span>!</span>${needsPermission ? 'Permission required' : 'Waiting for your answer'} · Open session</button>` : '';
    const userAvatar = user ? roomAvatar({ displayName: 'You', avatarColor: '#0A84FF' }) : '';
    const quoteButton = `<button class="room-quote-button" type="button" title="${selected ? 'Remove from references' : 'Add to references'}" aria-label="${selected ? 'Remove from references' : 'Add to references'}" aria-pressed="${selected}">
        <svg class="room-quote-icon room-quote-icon-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v11M6.5 12h11"/></svg>
        <svg class="room-quote-icon room-quote-icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.5 3.5 7.5-8"/></svg>
    </button>`;
    return `<article class="room-entry ${user ? 'user' : 'session'}${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}${running ? ' running' : ''}" data-room-entry-id="${escapeHtml(entry.id)}">
        ${user ? quoteButton : ''}
        <div class="room-entry-column">
            <div class="room-entry-author">${user ? '' : `<button class="room-entry-avatar" type="button" data-room-member-avatar="${escapeHtml(entry.memberId || '')}" aria-label="Open ${escapeHtml(author)}">${roomAvatar(member, roomMemberIsActive(member) ? 'room-avatar-running' : '')}</button>`}<strong>${escapeHtml(author)}</strong>${providerName ? `<span class="room-provider-label">${escapeHtml(providerName)}</span>` : ''}<time>${new Date(entry.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time>${user ? `<span class="room-entry-avatar user" aria-label="You">${userAvatar}</span>` : quoteButton}</div>
            ${attention}<div class="room-entry-bubble${unavailable || entry.status === 'failed' ? ' unavailable' : ''}">${quotes}${mentions}<div class="room-entry-text">${renderMarkdown(content || 'No final response was produced.', { sessionId: member?.sessionId })}</div></div>
        </div>
    </article>`;
}

function installRoomAvatarHandlers(root) {
    root.querySelectorAll('[data-room-member-avatar]').forEach(button => {
        const memberId = button.dataset.roomMemberAvatar;
        button.addEventListener('click', event => {
            event.stopPropagation();
            openRoomSession(memberId);
        });
    });
}

function installRoomMessageHandlers(list) {
    installRoomAvatarHandlers(list);
    list.querySelectorAll('.room-entry').forEach(element => {
        const entryId = element.dataset.roomEntryId;
        let holdTimer = null;
        let holdOrigin = null;
        const cancelHold = () => {
            if (holdTimer !== null) clearTimeout(holdTimer);
            holdTimer = null;
            holdOrigin = null;
        };
        element.addEventListener('pointerdown', event => {
            if (event.target.closest('button, a, summary')) return;
            holdOrigin = { x: event.clientX, y: event.clientY };
            element.classList.add('room-entry-holding');
            holdTimer = setTimeout(() => {
                holdTimer = null;
                holdOrigin = null;
                element.classList.remove('room-entry-holding');
                element.dataset.longPressConsumed = 'true';
                navigator.vibrate?.(18);
                toggleRoomQuote(entryId);
            }, 550);
        });
        element.addEventListener('pointermove', event => {
            if (!holdOrigin || Math.hypot(event.clientX - holdOrigin.x, event.clientY - holdOrigin.y) <= 9) return;
            element.classList.remove('room-entry-holding');
            cancelHold();
        });
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
            element.addEventListener(eventName, () => {
                element.classList.remove('room-entry-holding');
                cancelHold();
            });
        }
        element.querySelector('.room-entry-bubble')?.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            if (element.dataset.longPressConsumed === 'true') {
                delete element.dataset.longPressConsumed;
                return;
            }
            if (roomExpandedEntries.has(entryId)) roomExpandedEntries.delete(entryId); else roomExpandedEntries.add(entryId);
            element.classList.toggle('expanded', roomExpandedEntries.has(entryId));
        });
        element.querySelector('[data-room-quote-bundle]')?.addEventListener('click', event => {
            event.stopPropagation(); openRoomQuoteBundle(entryId);
        });
        element.querySelector('.room-quote-button')?.addEventListener('click', event => {
            event.stopPropagation(); toggleRoomQuote(entryId);
        });
    });
    gladMarkdownRich.renderDiagrams(list);
}

function toggleRoomMention(memberId) {
    const member = activeRoom?.members.find(item => item.id === memberId && !item.leftAt);
    if (!member) return;
    if (roomSelectedMentions.has(memberId)) roomSelectedMentions.delete(memberId); else roomSelectedMentions.add(memberId);
    renderRoomContextChips();
    renderRoomMentionPicker();
}

function toggleRoomMentionPicker() {
    roomMentionPickerOpen = !roomMentionPickerOpen;
    if (roomMentionPickerOpen) {
        roomHistoryOpen = false;
        renderRoomHistoryPanel();
    }
    renderRoomMentionPicker();
}

function renderRoomMentionPicker() {
    const picker = document.getElementById('room-mention-picker');
    if (!picker || !activeRoom) return;
    const members = activeRoom.members.filter(member => !member.leftAt);
    picker.innerHTML = `<div class="room-mention-picker-title"><strong>Choose sessions</strong><button type="button" onclick="toggleRoomMentionPicker()">Done</button></div>${members.length
        ? members.map(member => `<button type="button" class="room-mention-option${roomSelectedMentions.has(member.id) ? ' selected' : ''}" onclick="toggleRoomMention('${escapeHtml(member.id)}')"${member.available ? '' : ' disabled'}>
            ${roomAvatar(member, roomMemberIsActive(member) ? 'room-avatar-running' : '')}<span><strong>${escapeHtml(member.displayName)}</strong><small>${member.available ? escapeHtml(member.toolName || member.toolKey || 'Provider') : 'Unavailable'}</small></span><i>${roomSelectedMentions.has(member.id) ? '✓' : '+'}</i>
        </button>`).join('')
        : '<p>No sessions in this group.</p>'}`;
    picker.classList.toggle('active', roomMentionPickerOpen);
    document.getElementById('room-mention-button')?.classList.toggle('active', roomMentionPickerOpen || roomSelectedMentions.size > 0);
}

function toggleRoomQuote(entryId) {
    const entry = activeRoom?.entries.find(item => item.id === entryId);
    if (!entry || ['pending', 'running'].includes(entry.status)) {
        if (entry) alert('Wait for this reply to finish before quoting it.');
        return;
    }
    if (roomSelectedQuotes.has(entryId)) roomSelectedQuotes.delete(entryId); else roomSelectedQuotes.add(entryId);
    renderActiveRoom();
}

function openRoomQuoteBundle(entryId) {
    const source = activeRoom?.entries.find(entry => entry.id === entryId);
    if (!source?.quotedEntryIds?.length) return;
    openRoomMessagesPreview(source.quotedEntryIds, 'Chat history', `${source.quotedEntryIds.length} forwarded messages`);
}

function openRoomMessagesPreview(entryIds, title, subtitle, selectionPreview = false) {
    const members = roomMemberMap();
    const entries = new Map(activeRoom.entries.map(entry => [String(entry.id), entry]));
    const list = document.getElementById('room-quotes-list');
    document.getElementById('room-quotes-title').textContent = title;
    document.getElementById('room-quotes-subtitle').textContent = subtitle;
    list.innerHTML = entryIds.map(id => {
        const entry = entries.get(String(id));
        if (!entry) return `<article class="room-forward-item unavailable"><div class="room-forward-author">Unavailable message</div><p>The original message is no longer in this room.</p></article>`;
        const member = entry.type === 'session' ? members.get(String(entry.memberId)) : null;
        const author = entry.type === 'user' ? 'You' : (member?.displayName || 'Session');
        const text = entry.text || (entry.status === 'unavailable' ? 'Message unavailable.' : 'No readable content.');
        return `<article class="room-forward-item${selectionPreview ? ' room-selection-preview-item' : ''}${entry.status === 'unavailable' ? ' unavailable' : ''}" data-room-forward-entry="${escapeHtml(entry.id)}" tabindex="0" role="button">
            <div class="room-forward-author">${member ? roomAvatar(member) : '<span class="room-forward-user">You</span>'}<span><strong>${escapeHtml(author)}</strong><time>${new Date(entry.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></span></div>
            <div class="room-forward-text">${renderMarkdown(text, { sessionId: member?.sessionId })}</div>
        </article>`;
    }).join('');
    list.querySelectorAll('[data-room-forward-entry]').forEach(item => {
        const jump = () => jumpToRoomEntry(item.dataset.roomForwardEntry);
        item.addEventListener('click', jump);
        item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
    });
    gladMarkdownRich.renderDiagrams(list);
    document.getElementById('room-quotes-overlay').classList.add('active');
}

function openSelectedRoomQuotesPreview() {
    if (!activeRoom || roomSelectedQuotes.size === 0) return;
    const ids = [...roomSelectedQuotes];
    openRoomMessagesPreview(ids, 'Selected messages', `${ids.length} message${ids.length === 1 ? '' : 's'} selected`, true);
}

function closeRoomQuoteBundle(event) {
    if (event && event.target.id !== 'room-quotes-overlay') return;
    document.getElementById('room-quotes-overlay').classList.remove('active');
    document.getElementById('room-quotes-title').textContent = 'Chat history';
}

function jumpToRoomEntry(entryId) {
    closeRoomQuoteBundle();
    roomExpandedEntries.add(entryId);
    const entry = document.querySelector(`.room-entry[data-room-entry-id="${CSS.escape(String(entryId))}"]`);
    if (!entry) return;
    entry.classList.add('expanded', 'room-entry-jump');
    entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => entry.classList.remove('room-entry-jump'), 1800);
}

function renderRoomContextChips() {
    const container = document.getElementById('room-context-chips');
    if (!container || !activeRoom) return;
    const members = roomMemberMap();
    const mentionChips = [];
    for (const id of roomSelectedMentions) {
        const member = members.get(String(id));
        if (member) mentionChips.push(`<button type="button" class="room-context-chip mention" onclick="toggleRoomMention('${escapeHtml(id)}')">@${escapeHtml(member.displayName)} ×</button>`);
    }
    const quoteChips = [];
    for (const id of roomSelectedQuotes) {
        const entry = activeRoom.entries.find(item => item.id === id);
        if (entry) quoteChips.push(`<button type="button" class="room-context-chip quote" onclick="toggleRoomQuote('${escapeHtml(id)}')">Message #${entry.sequence} ×</button>`);
    }
    const rows = [];
    if (mentionChips.length) rows.push(`<div class="room-context-row mentions"><span>Sessions</span><div>${mentionChips.join('')}</div></div>`);
    if (quoteChips.length) rows.push(`<div class="room-context-row quotes"><button type="button" class="room-selected-preview-button" onclick="openSelectedRoomQuotesPreview()">Preview <span>${quoteChips.length}</span></button><div>${quoteChips.join('')}</div></div>`);
    container.innerHTML = rows.join('');
    container.classList.toggle('active', rows.length > 0);
}

function renderRoomFileChips() {
    const container = document.getElementById('room-file-chips');
    if (!container) return;
    container.innerHTML = roomPendingFiles.map((file, index) => `<button type="button" class="room-context-chip file" onclick="removeRoomFile(${index})">${escapeHtml(file.name)} ×</button>`).join('');
    container.classList.toggle('active', roomPendingFiles.length > 0);
}

function removeRoomFile(index) {
    roomPendingFiles.splice(index, 1);
    renderRoomFileChips();
}

async function uploadRoomFilesForMember(member, files) {
    const imageIds = [], fileIds = [];
    try {
        for (const file of files) {
            if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} is larger than 50 MB`);
            if (isSupportedImageFile(file)) {
                const upload = uploadImageInChunks(member.sessionId, file, () => {});
                const attachment = await upload.promise;
                imageIds.push(attachment.id);
            } else {
                const upload = uploadFileInChunks(member.sessionId, file, () => {});
                const attachment = await upload.promise;
                fileIds.push(attachment.id);
            }
        }
    } catch (error) {
        await Promise.all([
            ...imageIds.map(id => fetch(`/api/sessions/${encodeURIComponent(member.sessionId)}/attachments/images/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)),
            ...fileIds.map(id => fetch(`/api/sessions/${encodeURIComponent(member.sessionId)}/attachments/files/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null))
        ]);
        throw error;
    }
    return { imageIds, fileIds };
}

async function sendRoomMessage() {
    if (!activeRoom || roomSending) return;
    const input = document.getElementById('room-input');
    const text = input.value.trim();
    const memberIds = Array.from(roomSelectedMentions);
    if (!text && !memberIds.length) return;
    if (roomPendingFiles.length && !memberIds.length) {
        alert('Group attachments are not stored. @mention at least one available session to deliver them.');
        return;
    }
    const unavailable = memberIds.map(id => activeRoom.members.find(item => item.id === id)).filter(member => !member?.available);
    if (unavailable.length) {
        alert(`These sessions are unavailable: ${unavailable.map(item => item.displayName).join(', ')}`);
        return;
    }
    const missingQuotes = Array.from(roomSelectedQuotes).filter(id => {
        const entry = activeRoom.entries.find(item => item.id === id);
        return !entry?.text || entry.status === 'unavailable';
    });
    if (missingQuotes.length && !confirm(`${missingQuotes.length} quoted message(s) cannot be read and will be sent as unavailable references. Continue?`)) return;
    roomSending = true;
    document.getElementById('room-send-button').disabled = true;
    const uploaded = [];
    let dispatchStarted = false;
    try {
        const attachmentsByMember = {};
        if (roomPendingFiles.length) {
            for (const id of memberIds) {
                const member = activeRoom.members.find(item => item.id === id);
                attachmentsByMember[id] = await uploadRoomFilesForMember(member, roomPendingFiles);
                uploaded.push({ sessionId: member.sessionId, ...attachmentsByMember[id] });
            }
        }
        dispatchStarted = true;
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoomId)}/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text, mentionedMemberIds: memberIds,
                quotedEntryIds: Array.from(roomSelectedQuotes), attachmentsByMember
            })
        }, 100000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        input.value = '';
        input.style.height = 'auto';
        roomSelectedMentions.clear();
        roomSelectedQuotes.clear();
        roomPendingFiles = [];
        roomMentionPickerOpen = false;
        activeRoom = data.room;
        roomRenderSignature = '';
        renderActiveRoom({ stickBottom: true });
    } catch (error) {
        if (!dispatchStarted) {
            await Promise.all(uploaded.flatMap(item => [
                ...item.imageIds.map(id => fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}/attachments/images/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)),
                ...item.fileIds.map(id => fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}/attachments/files/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null))
            ]));
        }
        alert(`Could not send group message: ${error.message}`);
    } finally {
        roomSending = false;
        document.getElementById('room-send-button').disabled = false;
        scheduleRoomPoll();
    }
}

function openRoomMembers() {
    if (!activeRoom) return;
    document.getElementById('room-members-overlay').classList.add('active');
    document.getElementById('room-session-picker').innerHTML = '';
    renderRoomMembersList();
}

function closeRoomMembers(event) {
    if (event && event.target.id !== 'room-members-overlay') return;
    document.getElementById('room-members-overlay').classList.remove('active');
}

function renderRoomMembersList() {
    const container = document.getElementById('room-members-list');
    const activeMembers = (activeRoom?.members || []).filter(item => !item.leftAt);
    container.innerHTML = activeMembers.length ? activeMembers.map(member => `<div class="room-manage-member">
        ${roomAvatar(member, roomMemberIsActive(member) ? 'room-avatar-running' : '')}<span><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.toolName || member.toolKey || 'Provider')} · ${member.available ? (roomMemberIsActive(member) ? 'Working' : 'Ready') : 'Unavailable'}</small></span>
        <div class="room-manage-actions"><button class="small-btn" type="button" onclick="renameRoomMember('${escapeHtml(member.id)}')">Rename</button><button class="small-btn danger" type="button" onclick="removeRoomMember('${escapeHtml(member.id)}')">Remove</button></div>
    </div>`).join('') : '<p class="room-modal-empty">No sessions in this group.</p>';
}

async function renameRoomMember(memberId) {
    const member = activeRoom?.members.find(item => item.id === memberId && !item.leftAt);
    if (!member?.available || !member.sessionId) {
        alert('Resume this session before renaming it.');
        return;
    }
    const name = prompt('Session name', member.displayName || 'Session');
    if (!name || name.trim() === member.displayName) return;
    try {
        const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(member.sessionId)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
        }, 35000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        member.displayName = data.name;
        renderRoomMembersList();
        renderActiveRoom();
        await new Promise(resolve => setTimeout(resolve, 80));
        await refreshActiveRoom({ force: true });
        if (data.warning) alert(data.warning);
    } catch (error) { alert(`Could not rename session: ${error.message}`); }
}

async function showRoomExistingSessions() {
    const picker = document.getElementById('room-session-picker');
    picker.innerHTML = '<p class="room-modal-empty">Loading sessions…</p>';
    try {
        const response = await fetchWithTimeout('/api/sessions');
        const sessions = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const joined = new Set((activeRoom?.members || []).filter(item => !item.leftAt).map(item => item.sessionId));
        const available = sessions.filter(session => !joined.has(session.id));
        picker.innerHTML = available.length ? `<div class="room-session-picker-title">Running sessions</div>${available.map(session => `<button type="button" class="room-session-pick" onclick="addSessionToRoom('${escapeHtml(session.id)}')"><span>${escapeHtml(session.name)}</span><small>${escapeHtml(session.tool)} · ${escapeHtml(session.workingDirectory || '')}</small></button>`).join('')}`
            : '<p class="room-modal-empty">Every running session is already in this group.</p>';
    } catch (error) {
        picker.innerHTML = `<p class="room-modal-empty">${escapeHtml(error.message)}</p>`;
    }
}

async function addSessionToRoom(sessionId, roomId = activeRoomId) {
    const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId })
    }, 30000);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    if (roomId === activeRoomId) {
        await refreshActiveRoom({ force: true });
        renderRoomMembersList();
        document.getElementById('room-session-picker').innerHTML = '';
    }
    return data;
}

async function removeRoomMember(memberId) {
    if (!confirm('Remove this session from the group? The session and old group messages remain.')) return;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoomId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        roomSelectedMentions.delete(memberId);
        await refreshActiveRoom({ force: true });
        renderRoomMembersList();
    } catch (error) { alert(error.message); }
}

function createSessionForRoom() {
    window.pendingRoomMemberRoomId = activeRoomId;
    closeRoomMembers();
    showToolModal();
}

function openRoomSession(memberId) {
    const member = activeRoom?.members.find(item => item.id === memberId);
    if (!member?.available || !member.sessionId) {
        alert('This session is unavailable. Resume the group before opening it.');
        return;
    }
    clearTimeout(roomPollTimer);
    window.gladRoomSessionReturn = { roomId: activeRoomId, scrollTop: document.getElementById('room-message-list').scrollTop };
    joinSession(member.sessionId, member.displayName, member.toolKey);
}

function openRoomAttention(memberId) {
    const member = activeRoom?.members.find(item => item.id === memberId);
    openRoomSession(memberId);
    if (!member?.available) return;
    const deadline = Date.now() + 6000;
    const focus = () => {
        if (!window.gladRoomSessionReturn || activeSessionId !== member.sessionId) return;
        if (!activeSessionHydrated) {
            if (Date.now() < deadline) setTimeout(focus, 50);
            return;
        }
        if (member.toolKey === 'codex') {
            const request = codexPendingPermissions.find(item => item?.status === 'pending');
            if (request) void loadAndFocusCodexApproval(request);
            return;
        }
        const request = claudePendingPermissions.find(item => item?.status === 'pending');
        if (request) focusClaudeApproval(String(request.id));
    };
    setTimeout(focus, 0);
}

function closeRoomSessionOverlay() {
    const returning = window.gladRoomSessionReturn;
    if (!returning) return;
    if (currentSocket) { currentSocket.close(); currentSocket = null; }
    closeTimedSendPanel();
    stopTimedInputTimers();
    if (typeof clearComposerAttachments === 'function') void clearComposerAttachments();
    activeSessionId = null;
    window.activeSessionId = null;
    activeToolKey = null;
    activeSessionHydrated = false;
    document.body.classList.remove('room-session-open');
    for (const id of ['terminal-view', 'history-view', 'git-view']) {
        document.getElementById(id)?.classList.remove('active');
    }
    window.gladRoomSessionReturn = null;
    document.getElementById('room-view').classList.add('active');
    refreshActiveRoom({ force: true }).then(() => {
        const list = document.getElementById('room-message-list');
        list.scrollTop = returning.scrollTop || list.scrollHeight;
        scheduleRoomPoll();
    }).catch(() => scheduleRoomPoll());
}

async function toggleRoomHistoryPanel(preferredAction = 'resume') {
    if (roomHistoryOpen && roomHistoryPreferredAction === preferredAction) {
        roomHistoryOpen = false;
        renderRoomHistoryPanel();
        return;
    }
    roomHistoryPreferredAction = preferredAction;
    roomHistoryOpen = true;
    roomMentionPickerOpen = false;
    renderRoomMentionPicker();
    renderRoomHistoryPanel({ loading: true });
    try {
        const response = await fetchWithTimeout('/api/rooms', {}, 15000);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        roomHistoryItems = data;
        renderRoomHistoryPanel();
    } catch (error) {
        renderRoomHistoryPanel({ error: error.message });
    }
}

function renderRoomHistoryPanel(state = {}) {
    const panel = document.getElementById('room-history-panel');
    if (!panel) return;
    panel.classList.toggle('active', roomHistoryOpen);
    document.getElementById('room-history-resume')?.classList.toggle('active', roomHistoryOpen && roomHistoryPreferredAction === 'resume');
    document.getElementById('room-history-fork')?.classList.toggle('active', roomHistoryOpen && roomHistoryPreferredAction === 'fork');
    if (!roomHistoryOpen) { panel.innerHTML = ''; return; }
    const heading = `<header><div><strong>Group history</strong><span>Resume or fork every linked session together.</span></div><button type="button" class="icon-btn" onclick="toggleRoomHistoryPanel('${roomHistoryPreferredAction}')">×</button></header>`;
    if (state.loading) { panel.innerHTML = `${heading}<div class="room-history-state">Loading groups…</div>`; return; }
    if (state.error) { panel.innerHTML = `${heading}<div class="room-history-state error">${escapeHtml(state.error)}</div>`; return; }
    panel.innerHTML = heading + (roomHistoryItems.length ? `<div class="room-history-results">${roomHistoryItems.map(item => {
        const preview = roomHistoryPreviews.get(item.id);
        const expanded = Boolean(preview);
        const current = item.id === activeRoomId;
        return `<article class="room-history-item${current ? ' current' : ''}">
            <div class="room-history-main"><div><strong>${escapeHtml(item.name)}</strong><span>${Number(item.memberCount) || 0} sessions · ${Number(item.messageCount) || 0} messages${current ? ' · current' : ''}</span></div>
            <button type="button" class="small-btn room-history-preview-button" onclick="toggleRoomHistoryPreview('${escapeHtml(item.id)}')">${expanded ? 'Hide preview' : 'Preview'}</button></div>
            ${expanded ? roomHistoryPreviewHTML(item.id, preview) : ''}
            <div class="room-history-actions">${roomHistoryPreferredAction === 'resume'
                ? `<button type="button" class="small-btn primary" onclick="resumeStoredRoom('${escapeHtml(item.id)}')"><svg class="action-icon" aria-hidden="true"><use href="#icon-resume"></use></svg>Resume</button>`
                : `<button type="button" class="small-btn primary" onclick="forkStoredRoom('${escapeHtml(item.id)}')"><svg class="action-icon" aria-hidden="true"><use href="#icon-fork"></use></svg>Fork</button>`}</div>
        </article>`;
    }).join('')}</div>` : '<div class="room-history-state">No saved groups.</div>');
}

function roomHistoryPreviewHTML(roomId, preview) {
    if (preview?.loading) return '<div class="room-history-preview"><span>Loading preview…</span></div>';
    if (preview?.error) return `<div class="room-history-preview error"><span>${escapeHtml(preview.error)}</span></div>`;
    const room = preview?.room;
    if (!room) return '';
    const members = new Map((room.members || []).map(member => [String(member.id), member]));
    const entries = (room.entries || []).slice(-8);
    return `<div class="room-history-preview">${entries.length ? entries.map(entry => {
        const author = entry.type === 'user' ? 'You' : (members.get(String(entry.memberId))?.displayName || 'Session');
        const text = entry.text || (entry.status === 'unavailable' ? 'Message unavailable' : entry.status === 'running' ? 'Still running' : 'No final text');
        return `<button type="button" onclick="openStoredRoomEntry('${escapeHtml(roomId)}','${escapeHtml(entry.id)}')"><strong>${escapeHtml(author)}</strong><span>${escapeHtml(text)}</span></button>`;
    }).join('') : '<span>No messages yet.</span>'}</div>`;
}

async function toggleRoomHistoryPreview(roomId) {
    if (roomHistoryPreviews.has(roomId)) {
        roomHistoryPreviews.delete(roomId);
        renderRoomHistoryPanel();
        return;
    }
    roomHistoryPreviews.set(roomId, { loading: true });
    renderRoomHistoryPanel();
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}`, {}, 15000);
        const room = await response.json();
        if (!response.ok) throw new Error(room.error || `HTTP ${response.status}`);
        roomHistoryPreviews.set(roomId, { room });
    } catch (error) {
        roomHistoryPreviews.set(roomId, { error: error.message });
    }
    renderRoomHistoryPanel();
}

async function openStoredRoomEntry(roomId, entryId) {
    await openRoom(roomId);
    requestAnimationFrame(() => jumpToRoomEntry(entryId));
}

async function resumeStoredRoom(roomId) {
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
    await openRoom(roomId);
}

async function forkStoredRoom(roomId) {
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
    await forkRoomByID(roomId);
}

async function roomOperation(action) {
    if (!activeRoomId) return;
    if (action === 'resume') return restoreLinkedRoomSessions(activeRoomId, true);
    return forkRoomByID(activeRoomId);
}

async function forkRoomByID(roomId) {
    if (!roomId || roomLifecycleInFlight) return;
    roomLifecycleInFlight = true;
    try {
        const statusResponse = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/operation-status`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
        const unavailable = status.members.filter(member => !member.canFork);
        if (unavailable.length && !confirm(`${unavailable.map(item => item.displayName).join(', ')} cannot be forked and will be excluded. Continue?`)) return;
        const body = { excludedMemberIds: unavailable.map(item => item.memberId) };
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/fork`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }, 180000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        const failed = (data.results || []).filter(item => !item.success);
        if (failed.length) alert(`${failed.length} session(s) could not be forked and were left unchanged.`);
        if (activeRoomId === roomId) await refreshActiveRoom({ force: true });
        else await openRoom(roomId);
        if (typeof showAppToast === 'function') showAppToast('Group sessions forked in place');
    } catch (error) { alert(`Could not fork group: ${error.message}`); }
    finally { roomLifecycleInFlight = false; }
}

async function restoreLinkedRoomSessions(roomId, interactive = false) {
    if (roomLifecycleInFlight) return;
    roomLifecycleInFlight = true;
    try {
        const statusResponse = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/operation-status`);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
        const missing = status.members.filter(member => !member.live && !member.canResume);
        const restorable = status.members.filter(member => !member.live && member.canResume);
        if (!restorable.length) {
            if (interactive && missing.length) alert(`${missing.map(item => item.displayName).join(', ')} cannot be resumed because their provider history is unavailable.`);
            return;
        }
        if (interactive && missing.length && !confirm(`${missing.map(item => item.displayName).join(', ')} cannot be resumed and will be excluded. Continue?`)) return;
        if (typeof showAppToast === 'function') showAppToast('Restoring group sessions…');
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/resume`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ excludedMemberIds: missing.map(item => item.memberId) })
        }, 180000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        if (activeRoomId === roomId) await refreshActiveRoom({ force: true });
        const failed = (data.results || []).filter(item => !item.success);
        if (failed.length) alert(`${failed.length} linked session(s) could not be restored.`);
        else if (typeof showAppToast === 'function') showAppToast('Group sessions restored');
    } catch (error) {
        if (interactive) alert(`Could not resume group: ${error.message}`);
        else if (typeof showAppToast === 'function') showAppToast(`Group restore failed: ${error.message}`);
    } finally {
        roomLifecycleInFlight = false;
    }
}

function resumeActiveRoom() { return roomOperation('resume'); }
function forkActiveRoom() { return roomOperation('fork'); }

document.getElementById('room-file-input')?.addEventListener('change', event => {
    const additions = Array.from(event.target.files || []);
    if (roomPendingFiles.length + additions.length > 8) {
        alert('You can attach up to 8 files at a time.');
        additions.splice(Math.max(0, 8 - roomPendingFiles.length));
    }
    roomPendingFiles.push(...additions);
    event.target.value = '';
    renderRoomFileChips();
});

document.getElementById('room-input')?.addEventListener('input', event => {
    event.target.style.height = 'auto';
    event.target.style.height = Math.min(event.target.scrollHeight, 150) + 'px';
});

document.getElementById('room-input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void sendRoomMessage();
    }
});
