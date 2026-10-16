let roomBrowsingHistory = false;
let roomPageLoading = false;
const roomQuoteEntries = new Map();
let roomPageRequest = 0;

function resetRoomContent() {
    roomPageRequest++;
    roomPageLoading = false;
    roomBrowsingHistory = false;
    roomQuoteEntries.clear(); roomExpandedEntries.clear(); roomTurnDetailCache.clear(); roomHistoryPreviews.clear();
    roomEntryContextState = null;
    document.getElementById('room-message-list').replaceChildren();
    document.getElementById('room-page-controls').hidden = true;
    for (const id of ['room-context-overlay', 'room-quotes-overlay']) document.getElementById(id)?.classList.remove('active');
    document.getElementById('room-context-conversation')?.replaceChildren();
    document.getElementById('room-quotes-list')?.replaceChildren();
}

function renderRoomPageControls() {
    const nav = document.getElementById('room-page-controls');
    nav.hidden = !activeRoom?.paged || (!activeRoom.hasBefore && !roomBrowsingHistory);
    nav.innerHTML = `<button class="small-btn" onclick="loadRoomPage('earlier')"${!activeRoom?.hasBefore || roomPageLoading ? ' disabled' : ''}>Earlier messages</button><span>${roomBrowsingHistory ? 'Reading history' : 'Latest messages'}</span>${roomBrowsingHistory ? `<button class="small-btn" onclick="loadRoomPage('later')"${roomPageLoading ? ' disabled' : ''}>Later messages</button><button class="small-btn primary" onclick="loadRoomPage('latest')"${roomPageLoading ? ' disabled' : ''}>Latest</button>` : ''}`;
}

async function loadRoomPage(direction, around = '') {
    if (!activeRoomId || roomPageLoading) return;
    const id = activeRoomId, request = ++roomPageRequest;
    roomPageLoading = true; renderRoomPageControls();
    const query = new URLSearchParams();
    if (direction === 'earlier' && activeRoom.entries.length) query.set('before', activeRoom.entries[0].id);
    if (direction === 'later' && activeRoom.entries.length) query.set('after', activeRoom.entries.at(-1).id);
    if (around) query.set('around', around);
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}?${query}`);
        const room = await response.json();
        if (!response.ok) throw new Error(room.error || 'Could not load history');
        if (id !== activeRoomId || request !== roomPageRequest) return;
        roomBrowsingHistory = Boolean(room.hasAfter);
        roomExpandedEntries.clear(); roomTurnDetailCache.clear();
        applyRoomSnapshot(room, { page: true, force: true });
        const list = document.getElementById('room-message-list');
        list.scrollTo({ top: direction === 'earlier' || direction === 'latest' ? list.scrollHeight : 0, behavior: 'instant' });
    } catch (error) { showAppToast(error.message); }
    finally { if (request === roomPageRequest) { roomPageLoading = false; renderRoomPageControls(); } }
}

async function loadRoomEntryText(entryId, offset = 0) {
    const id = activeRoomId;
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/text?offset=${offset}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not read message');
        if (activeRoomId !== id) return;
        document.getElementById('room-quotes-title').textContent = 'Full message';
        document.getElementById('room-quotes-subtitle').textContent = 'Read in parts';
        document.getElementById('room-quotes-list').innerHTML = `<pre class="room-full-text">${escapeHtml(data.text)}</pre><div class="room-full-text-actions">${offset ? `<button class="small-btn" onclick="loadRoomEntryText('${escapeHtml(entryId)}',${Math.max(0, offset - 32768)})">Previous part</button>` : ''}${data.hasMore ? `<button class="small-btn primary" onclick="loadRoomEntryText('${escapeHtml(entryId)}',${data.nextOffset})">Next part</button>` : ''}</div>`;
        document.getElementById('room-quotes-overlay').classList.add('active');
    } catch (error) { showAppToast(error.message); }
}
