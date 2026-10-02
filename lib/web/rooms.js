let activeRoomId = null;
let activeRoom = null;
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
let roomHistoryRequestId = 0;
const roomHistoryPreviews = new Map();
let roomEntryContextState = null;
const roomTurnDetailCache = new Map();
let roomCreateInFlight = false;
let roomPendingSend = null;
let roomHistorySort = 'updated_at';
let roomHistoryNextOffset = 0;
let roomHistoryHasMore = false;
let roomHistoryLoading = false;
let roomHistoryError = '';
const roomEntryRenderHtml = new WeakMap();

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

function renderRooms(rooms) {
    const list = document.getElementById('rooms-list');
    if (!list) return;
    window.gladWorkspace?.refreshTiledRoomsFromList(rooms);
    list.innerHTML = rooms.length ? rooms.map(room => {
        const encodedName = encodePathValue(room.name || 'New group');
        return `<article class="session-card room-list-card${room.id === activeRoomId ? ' selected' : ''}" data-room-id="${escapeHtml(room.id)}">
            <span class="active-session-dot" title="Current group" aria-label="Current group"></span>
            <div class="session-info">
                <h3>${room.hasUnreadCompletion && (roomSeenCompletions.get(room.id) || 0) < Number(room.completionRevision) && !roomCompletionVisible(room.id) ? '<span class="completion-dot" title="Completed while this group was not visible"></span>' : ''}${Number(room.timedInputCount) ? `<span class="timer-count-badge">${Number(room.timedInputCount)} timers</span>` : ''}<span class="session-name room-list-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span><button type="button" class="icon-btn session-edit-btn room-list-edit" title="Rename group" aria-label="Rename group" onclick="renameRoomFromLobby('${escapeHtml(room.id)}',decodePathValue('${encodedName}'),event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></h3>
                <p>${escapeHtml(tileStatusLabel(room.status))} · Group · ${Number(room.memberCount) || 0} sessions · ${Number(room.messageCount) || 0} messages</p>
                <p>${new Date(room.updatedAt || room.createdAt).toLocaleTimeString()}</p>
            </div>
            <div class="session-actions">
                ${renderServerChanRoomAction(room)}
                <button class="btn-join" type="button" onclick="openRoom('${escapeHtml(room.id)}')">Connect</button>
                <button class="icon-btn btn-delete session-delete-btn" type="button" onclick="deleteRoom('${escapeHtml(room.id)}', event)" title="Delete group" aria-label="Delete group"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </div>
        </article>`;
    }).join('') : '<p class="room-empty-lobby">No group chats</p>';
}

async function loadRooms() {
    connectRoomLobbySocket();
    try {
        const response = await fetchWithTimeout('/api/rooms');
        const rooms = await response.json();
        if (!response.ok) throw new Error(rooms.error || `HTTP ${response.status}`);
        renderRooms(rooms);
    } catch (error) {
        document.getElementById('rooms-list').innerHTML = `<div class="room-load-error">Could not load groups: ${escapeHtml(error.message)}<br><button class="small-btn" onclick="loadRooms()">Retry</button></div>`;
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
    if (roomCreateInFlight) return;
    roomCreateInFlight = true;
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
    } finally { roomCreateInFlight = false; }
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
    if (!confirm('Close this group? Saved group history and member sessions remain available.')) return;
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
    if (roomSending) { alert('Wait for the current message to be accepted before switching groups.'); return; }
    stopRoomControls();
    activeRoomId = id;
    activeRoom = null;
    roomPendingSend = null;
    roomRenderSignature = '';
    roomHistoryRequestId++;
    document.getElementById('room-title').textContent = 'Loading group…';
    document.getElementById('room-message-list').innerHTML = '';
    document.getElementById('room-input').value = '';
    document.body.classList.add('room-open');
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
    if (!options.keepSelections) {
        roomSelectedMentions.clear();
        roomSelectedQuotes.clear();
        roomPendingFiles = [];
        roomMentionPickerOpen = false;
    }
    if (currentSocket && !window.gladRoomSessionReturn) { currentSocket.close(); currentSocket = null; }
    document.querySelectorAll('#detail-pane > .view').forEach(view => view.classList.remove('active'));
    document.getElementById('room-view').classList.add('active');
    if (options.fromTile) document.getElementById('tile-workspace').classList.add('active');
    document.getElementById('detail-empty')?.classList.add('room-hidden');
    try {
        await refreshActiveRoom({ force: true, stickBottom: true });
    } catch (error) {
        document.getElementById('room-message-list').innerHTML = `<div class="room-load-error">${escapeHtml(error.message)}</div>`;
    }
    startRoomControls();
}

function closeRoom() {
    if (roomSending) { alert('Wait for the current message to be accepted before leaving the group.'); return; }
    if (window.gladWorkspace?.isTiledMode()) { returnToTiles(); return; }
    stopRoomControls();
    roomHistoryRequestId++;
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
    applyRoomSnapshot(room, options);
}

function captureRoomScrollState(list) {
    const top = list.getBoundingClientRect().top;
    const entry = Array.from(list.children).find(element => element.dataset.roomEntryId
        && element.getBoundingClientRect().bottom > top);
    return {
        scrollTop: list.scrollTop,
        stickToBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 90,
        entryId: entry?.dataset.roomEntryId,
        offset: entry ? entry.getBoundingClientRect().top - top : 0
    };
}

function restoreRoomScrollState(list, view) {
    const entry = view.entryId && Array.from(list.children).find(element => element.dataset.roomEntryId === view.entryId);
    const top = view.stickToBottom ? list.scrollHeight : entry
        ? list.scrollTop + entry.getBoundingClientRect().top - list.getBoundingClientRect().top - view.offset
        : view.scrollTop;
    list.scrollTo({ top, behavior: 'instant' });
}

function syncRoomMessageList(list, members) {
    const existing = new Map(Array.from(list.children).map(element => [element.dataset.roomEntryId, element]));
    if (!activeRoom.entries.length) {
        const html = `<div class="room-empty-state"><strong>This group is empty</strong><span>${activeRoom.members.some(member => !member.leftAt) ? 'Use the @ button below to choose sessions.' : 'Add a session from Members to begin.'}</span></div>`;
        if (list.innerHTML !== html) list.innerHTML = html;
        return;
    }
    list.querySelector('.room-empty-state')?.remove();
    let cursor = list.firstElementChild;
    for (const entry of activeRoom.entries) {
        const html = renderRoomEntry(entry, members);
        let element = existing.get(entry.id);
        existing.delete(entry.id);
        if (!element || roomEntryRenderHtml.get(element) !== html) {
            const template = document.createElement('template');
            template.innerHTML = html;
            const next = template.content.firstElementChild;
            if (element) {
                // Keep the message itself as the browser's scroll anchor.
                element.className = next.className;
                element.replaceChildren(...next.childNodes);
            } else element = next;
            roomEntryRenderHtml.set(element, html);
            installRoomMessageHandlers(element);
        }
        if (element !== cursor) list.insertBefore(element, cursor);
        cursor = element.nextElementSibling;
    }
    for (const element of existing.values()) element.remove();
    gladMarkdownRich.renderDiagrams(list);
}

function renderActiveRoom(options = {}) {
    if (!activeRoom) return;
    const list = document.getElementById('room-message-list');
    const view = captureRoomScrollState(list);
    if (options.stickBottom) view.stickToBottom = true;
    const activeMembers = activeRoom.members.filter(member => !member.leftAt);
    document.getElementById('room-title').textContent = activeRoomTitle();
    const attention = activeMembers.filter(member => Number(member.pendingPermissionCount) > 0 || Number(member.pendingQuestionCount) > 0);
    const attentionRail = document.getElementById('room-attention-rail');
    attentionRail.innerHTML = attention.map(member => `<button type="button" class="room-attention-pill" onclick="openRoomAttention('${escapeHtml(member.id)}')">
        <span class="room-attention-dot"></span><strong>${escapeHtml(member.displayName)}</strong><span>${Number(member.pendingPermissionCount) > 0 ? 'Permission required' : 'Waiting for answer'}</span>
    </button>`).join('');
    attentionRail.classList.toggle('active', attention.length > 0);

    const members = roomMemberMap();
    syncRoomMessageList(list, members);
    renderRoomContextChips();
    renderRoomMentionPicker();
    renderRoomFileChips();
    renderRoomHistoryPanel();
    syncRoomControls();
    updateRoomEntryFolding(list);
    restoreRoomScrollState(list, view);
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
    const contextButton = entry.hasContext
        ? `<button class="room-source-context-button" type="button" onclick="event.stopPropagation();openRoomEntryContext('${escapeHtml(entry.id)}')">Context</button>` : '';
    return `<article class="room-entry ${user ? 'user' : 'session'}${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}${running ? ' running' : ''}" data-room-entry-id="${escapeHtml(entry.id)}">
        <div class="room-entry-column">
            <div class="room-entry-author">${user ? quoteButton : `<button class="room-entry-avatar" type="button" data-room-member-avatar="${escapeHtml(entry.memberId || '')}" aria-label="Open ${escapeHtml(author)}">${roomAvatar(member, roomMemberIsActive(member) ? 'room-avatar-running' : '')}</button>`}<strong>${escapeHtml(author)}</strong>${providerName ? `<span class="room-provider-label">${escapeHtml(providerName)}</span>` : ''}<time>${new Date(entry.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time>${contextButton}${user ? `<span class="room-entry-avatar user" aria-label="You">${userAvatar}</span>` : quoteButton}</div>
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
    const entries = list.matches('.room-entry') ? [list] : list.querySelectorAll('.room-entry');
    entries.forEach(element => {
        const entryId = element.dataset.roomEntryId;
        let holdTimer = null;
        let holdOrigin = null;
        const cancelHold = () => {
            if (holdTimer !== null) clearTimeout(holdTimer);
            holdTimer = null;
            holdOrigin = null;
        };
        element.onpointerdown = event => {
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
        };
        element.onpointermove = event => {
            if (!holdOrigin || Math.hypot(event.clientX - holdOrigin.x, event.clientY - holdOrigin.y) <= 9) return;
            element.classList.remove('room-entry-holding');
            cancelHold();
        };
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
            element[`on${eventName}`] = () => {
                element.classList.remove('room-entry-holding');
                cancelHold();
            };
        }
        element.querySelector('.room-entry-bubble')?.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            if (element.dataset.longPressConsumed === 'true') {
                delete element.dataset.longPressConsumed;
                return;
            }
            if (!element.classList.contains('collapsible')) return;
            if (roomExpandedEntries.has(entryId)) roomExpandedEntries.delete(entryId); else roomExpandedEntries.add(entryId);
            element.classList.toggle('expanded', roomExpandedEntries.has(entryId));
            const entry = activeRoom?.entries.find(item => item.id === entryId);
            if (entry) roomEntryRenderHtml.set(element, renderRoomEntry(entry, roomMemberMap()));
        });
        element.querySelector('[data-room-quote-bundle]')?.addEventListener('click', event => {
            event.stopPropagation(); openRoomQuoteBundle(entryId);
        });
        element.querySelector('.room-quote-button')?.addEventListener('click', event => {
            event.stopPropagation(); toggleRoomQuote(entryId);
        });
    });
}

function updateRoomEntryFolding(list) {
    const measure = () => {
        const view = captureRoomScrollState(list);
        list.querySelectorAll('.room-entry').forEach(entry => {
            const text = entry.querySelector('.room-entry-text');
            if (!text) return;
            const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
            const threeLines = Number.isFinite(lineHeight) ? lineHeight * 3 : 72;
            const collapsible = text.scrollHeight > threeLines + 1;
            entry.classList.toggle('collapsible', collapsible);
            if (!collapsible) {
                entry.classList.remove('expanded');
                roomExpandedEntries.delete(entry.dataset.roomEntryId);
            }
        });
        restoreRoomScrollState(list, view);
    };
    // Fold before painting; expanding every old reply for one frame moves
    // the browser's scroll anchor even when its content has not changed.
    measure();
    list.querySelectorAll('.room-entry-text img').forEach(image => {
        if (!image.complete && !image.dataset.roomFoldingObserved) {
            image.dataset.roomFoldingObserved = 'true';
            image.addEventListener('load', measure, { once: true });
        }
    });
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
    const list = document.getElementById('room-message-list');
    const view = captureRoomScrollState(list);
    // Selecting a reference must leave the message nodes and focus intact.
    for (const element of list.querySelectorAll('.room-entry')) {
        if (element.dataset.roomEntryId !== entryId) continue;
        const selected = roomSelectedQuotes.has(entryId);
        element.classList.toggle('selected', selected);
        const button = element.querySelector('.room-quote-button');
        const label = selected ? 'Remove from references' : 'Add to references';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(selected));
        roomEntryRenderHtml.set(element, renderRoomEntry(entry, roomMemberMap()));
    }
    renderRoomContextChips();
    // The first reference adds a row to the composer, reducing list height.
    view.stickToBottom = false;
    restoreRoomScrollState(list, view);
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
            <div class="room-forward-text">${renderMarkdown(text, { sessionId: member?.sessionId })}</div>${entry.hasContext ? `<button type="button" class="small-btn room-forward-context" data-room-forward-context="${escapeHtml(entry.id)}">View context</button>` : ''}
        </article>`;
    }).join('');
    list.querySelectorAll('[data-room-forward-entry]').forEach(item => {
        const jump = () => jumpToRoomEntry(item.dataset.roomForwardEntry);
        item.addEventListener('click', jump);
        item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
    });
    list.querySelectorAll('[data-room-forward-context]').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation(); openRoomEntryContext(button.dataset.roomForwardContext);
    }));
    gladMarkdownRich.renderDiagrams(list);
    document.getElementById('room-quotes-overlay').classList.add('active');
}

async function openRoomEntryContext(entryId, before = 3, after = 3) {
    if (!activeRoomId || !entryId) return;
    roomEntryContextState = { entryId, before, after, loading: true };
    renderRoomEntryContext();
    document.getElementById('room-context-overlay').classList.add('active');
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoomId)}/entries/${encodeURIComponent(entryId)}/context?before=${before}&after=${after}`, {}, 20000);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (roomEntryContextState?.entryId !== entryId) return;
        roomEntryContextState = { entryId, before, after, data };
    } catch (error) {
        roomEntryContextState = { entryId, before, after, error: error.message };
    }
    renderRoomEntryContext();
}

function closeRoomEntryContext(event) {
    if (event && event.target.id !== 'room-context-overlay') return;
    document.getElementById('room-context-overlay').classList.remove('active');
    roomEntryContextState = null;
}

function renderRoomEntryContext() {
    const container = document.getElementById('room-context-conversation');
    if (!container || !roomEntryContextState) return;
    const state = roomEntryContextState;
    if (state.loading) { container.innerHTML = '<div class="room-context-state">Loading conversation…</div>'; return; }
    if (state.error) { container.innerHTML = `<div class="room-context-state error">${escapeHtml(state.error)}</div>`; return; }
    const data = state.data;
    document.getElementById('room-context-title').textContent = data.memberName || 'Conversation context';
    document.getElementById('room-context-subtitle').textContent = `${data.totalTurns} turns · selected message stays the only shared reference`;
    const sourceMember = (activeRoom?.members || []).find(member => member.id === data.memberId);
    const markdownOptions = { sessionId: sourceMember?.sessionId };
    const earlier = data.hasBefore ? `<button type="button" class="small-btn room-context-more" onclick="openRoomEntryContext('${escapeHtml(state.entryId)}',${Number(data.before) + 10},${Number(data.after)})">Load earlier</button>` : '';
    const later = data.hasAfter ? `<button type="button" class="small-btn room-context-more" onclick="openRoomEntryContext('${escapeHtml(state.entryId)}',${Number(data.before)},${Number(data.after) + 10})">Load later</button>` : '';
    container.innerHTML = earlier + data.turns.map(turn => renderRoomContextTurn(state.entryId, turn, data.memberName, markdownOptions)).join('') + later;
    gladMarkdownRich.renderDiagrams(container);
}

function renderRoomContextTurn(entryId, turn, memberName, markdownOptions = {}) {
    const key = `${activeRoomId}:${entryId}:${turn.turnId}`;
    const details = roomTurnDetailCache.get(key);
    const encodedTurn = encodePathValue(turn.turnId || '');
    const detailBody = details?.loading ? '<div class="room-turn-detail-state">Loading details…</div>'
        : details?.error ? `<div class="room-turn-detail-state error">${escapeHtml(details.error)}</div>`
        : details?.messages ? renderRoomTurnDetails(details.messages) : '';
    return `<article class="room-context-turn${turn.anchor ? ' anchor' : ''}" data-room-context-turn="${escapeHtml(turn.turnId)}">
        <header><strong>${turn.anchor ? 'Selected turn' : 'Conversation turn'}</strong><time>${new Date(turn.createdAt).toLocaleString()}</time></header>
        ${turn.userText ? `<div class="room-context-message user"><span>You · @${escapeHtml(memberName || 'Session')}</span>${renderMarkdown(turn.userText, markdownOptions)}</div>` : ''}
        ${turn.assistantText ? `<div class="room-context-message assistant"><span>${escapeHtml(memberName || 'Session')}</span>${renderMarkdown(turn.assistantText, markdownOptions)}</div>` : ''}
        <button type="button" class="small-btn room-turn-details-button" onclick="toggleRoomTurnDetails('${escapeHtml(entryId)}',decodePathValue('${encodedTurn}'))">${details?.messages ? 'Hide details' : 'View details'}</button>
        ${detailBody ? `<div class="room-turn-details">${detailBody}</div>` : ''}
    </article>`;
}

async function toggleRoomTurnDetails(entryId, turnId) {
    const key = `${activeRoomId}:${entryId}:${turnId}`;
    if (roomTurnDetailCache.get(key)?.messages) {
        roomTurnDetailCache.delete(key); renderRoomEntryContext(); return;
    }
    roomTurnDetailCache.set(key, { loading: true });
    renderRoomEntryContext();
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(activeRoomId)}/entries/${encodeURIComponent(entryId)}/turns/${encodeURIComponent(turnId)}/details`, {}, 20000);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        roomTurnDetailCache.set(key, { messages: data.messages || [] });
    } catch (error) { roomTurnDetailCache.set(key, { error: error.message }); }
    renderRoomEntryContext();
}

function renderRoomTurnDetails(messages) {
    const visible = messages.filter(message => !['turn-start', 'turn-end'].includes(message.kind));
    return visible.map(message => {
        const kind = String(message.kind || 'event');
        const label = kind === 'reasoning' ? 'Thinking' : kind === 'tool' ? (message.name || message.title || 'Tool')
            : kind === 'tool-result' ? 'Tool result' : kind === 'assistant' ? 'Assistant message' : kind === 'user' ? 'User message' : kind;
        let body = message.text || message.result || message.summary || '';
        if (!body && message.input) { try { body = JSON.stringify(message.input, null, 2); } catch (_) { body = String(message.input); } }
        return `<details class="room-turn-detail-item"${kind === 'user' || kind === 'assistant' ? ' open' : ''}><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(typeof body === 'string' ? body : JSON.stringify(body, null, 2))}</pre></details>`;
    }).join('') || '<div class="room-turn-detail-state">No additional details for this turn.</div>';
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
        if (entry) quoteChips.push(`<button type="button" class="room-context-chip quote" onclick="toggleRoomQuote('${escapeHtml(id)}')">#${entry.sequence} ×</button>`);
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
    if (roomSocket?.readyState !== WebSocket.OPEN) {
        alert('The group is not connected. Your message has been kept.');
        return;
    }
    if (roomLifecycleInFlight || activeRoom.resuming || activeRoom.forking || roomMemberIsActive(activeRoom)
        || (activeRoom.members || []).some(roomMemberIsActive)) {
        alert('Wait for the current run to finish. Your message has been kept.');
        return;
    }
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
    const runtimeId = activeRoomId;
    const intent = JSON.stringify({ text, memberIds, quotes: [...roomSelectedQuotes], files: roomPendingFiles.map(file => [file.name, file.size, file.lastModified]) });
    if (roomPendingSend?.intent !== intent) roomPendingSend = null;
    roomSending = true;
    syncRoomControls();
    const uploaded = [];
    let dispatchStarted = false;
    try {
        const attachmentsByMember = roomPendingSend?.payload.attachmentsByMember || {};
        if (!roomPendingSend && roomPendingFiles.length) {
            for (const id of memberIds) {
                const member = activeRoom.members.find(item => item.id === id);
                attachmentsByMember[id] = await uploadRoomFilesForMember(member, roomPendingFiles);
                uploaded.push({ sessionId: member.sessionId, ...attachmentsByMember[id] });
            }
        }
        if (!roomPendingSend) roomPendingSend = { intent, payload: {
            clientMessageId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text, mentionedMemberIds: memberIds, quotedEntryIds: [...roomSelectedQuotes], attachmentsByMember
        } };
        dispatchStarted = true;
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(runtimeId)}/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(roomPendingSend.payload)
        }, 100000);
        const data = await response.json();
        if (!response.ok || !data.success) {
            if (data.accepted === false) roomPendingSend = null;
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        roomPendingSend = null;
        if (activeRoomId !== runtimeId) return;
        input.value = '';
        input.style.height = 'auto';
        roomSelectedMentions.clear();
        roomSelectedQuotes.clear();
        roomPendingFiles = [];
        roomMentionPickerOpen = false;
        await refreshActiveRoom({ force: true, stickBottom: true });
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
        syncRoomControls();
        connectRoomSocket();
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
        alert('This session is unavailable. Choose Resume before opening it.');
        return;
    }
    disconnectRoomSocket();
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
        connectRoomSocket();
    }).catch(() => connectRoomSocket());
}

function roomReadyForHistory() {
    return Boolean(activeRoomId && activeRoom && !roomSending && !roomLifecycleInFlight
        && !roomMemberIsActive(activeRoom) && !(activeRoom.members || []).some(roomMemberIsActive)
        && !(activeRoom.entries || []).some(entry => ['pending', 'running'].includes(entry.status)));
}

async function toggleRoomHistoryPanel(preferredAction = 'resume') {
    if (roomHistoryOpen && roomHistoryPreferredAction === preferredAction) {
        roomHistoryOpen = false; roomHistoryRequestId++; renderRoomHistoryPanel(); return;
    }
    roomHistoryPreferredAction = preferredAction;
    roomHistoryOpen = true;
    roomMentionPickerOpen = false;
    renderRoomMentionPicker();
    await loadRoomHistoryPage(false);
}

async function loadRoomHistoryPage(append = false) {
    const requestId = ++roomHistoryRequestId;
    const runtimeId = activeRoomId;
    if (!append) { roomHistoryItems = []; roomHistoryNextOffset = 0; roomHistoryPreviews.clear(); }
    roomHistoryLoading = true; roomHistoryError = ''; renderRoomHistoryPanel();
    try {
        const query = new URLSearchParams({ sort: roomHistorySort, offset: String(append ? roomHistoryNextOffset : 0), limit: '20' });
        const response = await fetchWithTimeout(`/api/room-history?${query}`, {}, 15000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        if (requestId !== roomHistoryRequestId || runtimeId !== activeRoomId || !roomHistoryOpen) return;
        const seen = new Set(roomHistoryItems.map(item => item.id));
        for (const item of data.items || []) if (!seen.has(item.id)) { roomHistoryItems.push(item); seen.add(item.id); }
        roomHistoryHasMore = Boolean(data.hasMore); roomHistoryNextOffset = Number(data.nextOffset) || 0;
    } catch (error) {
        if (requestId === roomHistoryRequestId && runtimeId === activeRoomId && roomHistoryOpen) roomHistoryError = error.message;
    } finally {
        if (requestId === roomHistoryRequestId && runtimeId === activeRoomId && roomHistoryOpen) { roomHistoryLoading = false; renderRoomHistoryPanel(); }
    }
}

function changeRoomHistorySort(value) { roomHistorySort = value; void loadRoomHistoryPage(false); }

function renderRoomHistoryPanel() {
    const panel = document.getElementById('room-history-panel');
    if (!panel) return;
    panel.classList.toggle('active', roomHistoryOpen);
    document.getElementById('room-history-resume')?.classList.toggle('active', roomHistoryOpen && roomHistoryPreferredAction === 'resume');
    document.getElementById('room-history-fork')?.classList.toggle('active', roomHistoryOpen && roomHistoryPreferredAction === 'fork');
    if (!roomHistoryOpen) { panel.innerHTML = ''; return; }
    const heading = `<header><div><strong>${roomHistoryPreferredAction === 'fork' ? 'Fork' : 'Resume'} group</strong><span>${roomHistoryPreferredAction === 'fork' ? 'Create a copy and switch this group to it.' : 'Continue saved group history in this group.'}</span></div><button type="button" class="icon-btn" onclick="toggleRoomHistoryPanel('${roomHistoryPreferredAction}')">×</button></header>`;
    const filters = `<div class="room-history-filters"><select aria-label="Group history sort" onchange="changeRoomHistorySort(this.value)"><option value="updated_at"${roomHistorySort === 'updated_at' ? ' selected' : ''}>Recently updated</option><option value="created_at"${roomHistorySort === 'created_at' ? ' selected' : ''}>Recently created</option></select></div>`;
    panel.innerHTML = heading + filters + (roomHistoryItems.length ? `<div class="room-history-results">${roomHistoryItems.map(item => {
        const preview = roomHistoryPreviews.get(item.id);
        const expanded = Boolean(preview);
        const current = item.id === activeRoom?.historyId;
        return `<article class="room-history-item${current ? ' current' : ''}" data-room-history-id="${escapeHtml(item.id)}">
            <div class="room-history-main"><div><strong>${escapeHtml(item.name)}</strong><span>${Number(item.memberCount) || 0} sessions · ${Number(item.messageCount) || 0} messages${current ? ' · current' : ''}</span></div>
            <button type="button" class="small-btn room-history-preview-button" onclick="toggleRoomHistoryPreview('${escapeHtml(item.id)}')">${expanded ? 'Hide preview' : 'Preview'}</button></div>
            ${expanded ? roomHistoryPreviewHTML(item.id, preview) : ''}
            <div class="room-history-actions">${roomHistoryPreferredAction === 'resume'
                ? `<button type="button" class="small-btn primary" onclick="resumeStoredRoom('${escapeHtml(item.id)}')"${roomReadyForHistory() ? '' : ' disabled'}><svg class="action-icon" aria-hidden="true"><use href="#icon-resume"></use></svg>Resume</button>`
                : `<button type="button" class="small-btn primary" onclick="forkStoredRoom('${escapeHtml(item.id)}')"${roomReadyForHistory() ? '' : ' disabled'}><svg class="action-icon" aria-hidden="true"><use href="#icon-fork"></use></svg>Fork</button>`}</div>
        </article>`;
    }).join('')}</div>` : roomHistoryLoading ? '' : '<div class="room-history-state">No saved groups.</div>')
        + (roomHistoryError ? `<div class="room-history-state error">${escapeHtml(roomHistoryError)} <button type="button" class="small-btn" onclick="loadRoomHistoryPage(${roomHistoryItems.length > 0})">Retry</button></div>` : '')
        + `<div class="room-history-footer"><span>${roomHistoryItems.length} groups loaded</span>${roomHistoryLoading ? '<span role="status">Loading groups…</span>' : roomHistoryHasMore ? '<button type="button" class="small-btn" onclick="loadRoomHistoryPage(true)">Load more</button>' : ''}</div>`;
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
        return `<div class="room-history-preview-entry"><strong>${escapeHtml(author)}</strong><span>${escapeHtml(text)}</span></div>`;
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
        const response = await fetchWithTimeout(`/api/room-history/${encodeURIComponent(roomId)}`, {}, 15000);
        const room = await response.json();
        if (!response.ok) throw new Error(room.error || `HTTP ${response.status}`);
        roomHistoryPreviews.set(roomId, { room });
    } catch (error) {
        roomHistoryPreviews.set(roomId, { error: error.message });
    }
    renderRoomHistoryPanel();
}

async function resumeStoredRoom(sourceRoomId) {
    if (!roomReadyForHistory()) return;
    const runtimeId = activeRoomId;
    if (!await restoreLinkedRoomSessions(runtimeId, true, sourceRoomId) || activeRoomId !== runtimeId) return;
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
}

async function forkStoredRoom(sourceRoomId) {
    if (!roomReadyForHistory()) return;
    const runtimeId = activeRoomId;
    if (!await forkRoomByID(runtimeId, sourceRoomId) || activeRoomId !== runtimeId) return;
    roomHistoryOpen = false;
    renderRoomHistoryPanel();
}

async function roomOperation(action) {
    if (!activeRoomId) return;
    if (action === 'resume') return restoreLinkedRoomSessions(activeRoomId, true);
    return forkRoomByID(activeRoomId);
}

async function forkRoomByID(roomId, sourceRoomId = '') {
    if (!roomId || roomLifecycleInFlight) return;
    roomLifecycleInFlight = true;
    syncRoomControls();
    renderRoomHistoryPanel();
    try {
        const statusUrl = sourceRoomId ? `/api/room-history/${encodeURIComponent(sourceRoomId)}/operation-status` : `/api/rooms/${encodeURIComponent(roomId)}/operation-status`;
        const statusResponse = await fetchWithTimeout(statusUrl);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
        const unavailable = status.members.filter(member => !member.canFork);
        if (unavailable.length && !confirm(`${unavailable.map(item => item.displayName).join(', ')} cannot be forked and will be excluded. Continue?`)) return;
        const body = { sourceRoomId, excludedMemberIds: unavailable.map(item => item.memberId) };
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/fork`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }, 180000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        const failed = (data.results || []).filter(item => !item.success);
        if (failed.length) alert(`${failed.length} session(s) could not be forked and were left unchanged.`);
        if (activeRoomId === roomId) await refreshActiveRoom({ force: true });
        if (typeof showAppToast === 'function') showAppToast('Group copied and switched');
        return true;
    } catch (error) { alert(`Could not fork group: ${error.message}`); return false; }
    finally { roomLifecycleInFlight = false; syncRoomControls(); renderRoomHistoryPanel(); }
}

async function restoreLinkedRoomSessions(roomId, interactive = false, sourceRoomId = '') {
    if (roomLifecycleInFlight) return;
    roomLifecycleInFlight = true;
    syncRoomControls();
    renderRoomHistoryPanel();
    try {
        const statusUrl = sourceRoomId ? `/api/room-history/${encodeURIComponent(sourceRoomId)}/operation-status` : `/api/rooms/${encodeURIComponent(roomId)}/operation-status`;
        const statusResponse = await fetchWithTimeout(statusUrl);
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
        const missing = status.members.filter(member => !member.live && !member.canResume);
        if (interactive && missing.length && !confirm(`${missing.map(item => item.displayName).join(', ')} cannot be resumed and will be excluded. Continue?`)) return false;
        if (typeof showAppToast === 'function') showAppToast('Restoring group sessions…');
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(roomId)}/resume`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceRoomId, excludedMemberIds: missing.map(item => item.memberId) })
        }, 180000);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        if (activeRoomId === roomId) await refreshActiveRoom({ force: true });
        const failed = (data.results || []).filter(item => !item.success);
        if (failed.length) alert(`${failed.length} linked session(s) could not be restored.`);
        else if (typeof showAppToast === 'function') showAppToast('Group sessions restored');
        return true;
    } catch (error) {
        if (interactive) alert(`Could not resume group: ${error.message}`);
        else if (typeof showAppToast === 'function') showAppToast(`Group restore failed: ${error.message}`);
        return false;
    } finally {
        roomLifecycleInFlight = false;
        syncRoomControls();
        renderRoomHistoryPanel();
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
    if (event.key === 'Enter' && event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void sendRoomMessage();
    }
});
