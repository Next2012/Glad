let roomPageLoading = false;
let roomPageError = '';
const roomQuoteEntries = new Map();
const roomCollapsedEntries = new Set();
const roomEntryBodies = new Map();
const roomEntryBodyRequests = new Map();
const roomEntryBodyErrors = new Map();
let roomPageRequest = 0;
let roomContentGeneration = 0;

function resetRoomContent() {
    roomPageRequest++;
    roomContentGeneration++;
    roomPageLoading = false;
    roomPageError = '';
    roomQuoteEntries.clear(); roomExpandedEntries.clear(); roomCollapsedEntries.clear();
    roomEntryBodies.clear(); roomEntryBodyRequests.clear(); roomEntryBodyErrors.clear();
    roomTurnDetailCache.clear(); roomHistoryPreviews.clear();
    roomEntryContextState = null;
    document.getElementById('room-message-list').replaceChildren();
    document.getElementById('room-history-status').hidden = true;
    for (const id of ['room-context-overlay', 'room-quotes-overlay']) document.getElementById(id)?.classList.remove('active');
    document.getElementById('room-context-conversation')?.replaceChildren();
    document.getElementById('room-quotes-list')?.replaceChildren();
}

function renderRoomHistoryStatus() {
    const status = document.getElementById('room-history-status');
    status.hidden = !activeRoom?.paged || (!activeRoom.hasBefore && !roomPageLoading && !roomPageError);
    status.innerHTML = roomPageLoading ? 'Loading earlier messages…' : roomPageError
        ? `${escapeHtml(roomPageError)} <button type="button" class="small-btn" onclick="loadRoomPage('earlier')">Retry</button>`
        : 'Scroll up to load earlier messages';
}

async function loadRoomPage(direction = 'earlier', around = '') {
    if (direction === 'around') {
        const id = activeRoomId, generation = roomContentGeneration;
        while (id === activeRoomId && generation === roomContentGeneration
            && activeRoom?.hasBefore && !activeRoom.entries.some(entry => entry.id === around)) {
            const previous = activeRoom.entries[0]?.id;
            await loadRoomPage('earlier');
            if (roomPageError || activeRoom?.entries[0]?.id === previous) break;
        }
        return;
    }
    if (!activeRoomId || !activeRoom?.hasBefore || !activeRoom.entries.length || roomPageLoading) return;
    const id = activeRoomId, historyId = activeRoom.historyId, request = ++roomPageRequest;
    roomPageLoading = true; roomPageError = ''; renderRoomHistoryStatus();
    const query = new URLSearchParams({ before: activeRoom.entries[0].id });
    try {
        const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}?${query}`);
        const room = await response.json();
        if (!response.ok) throw new Error(room.error || 'Could not load history');
        if (id !== activeRoomId || request !== roomPageRequest || activeRoom?.historyId !== historyId) return;
        applyRoomSnapshot(room, { page: true });
    } catch (error) {
        if (id === activeRoomId && request === roomPageRequest) roomPageError = error.message;
    } finally {
        if (request === roomPageRequest) { roomPageLoading = false; renderRoomHistoryStatus(); }
    }
}

function maybeLoadRoomHistory() {
    const list = document.getElementById('room-message-list');
    if (list.scrollTop < 240 && activeRoom?.hasBefore && !roomPageLoading && !roomPageError) {
        void loadRoomPage('earlier');
    }
}

document.getElementById('room-message-list').addEventListener('scroll', maybeLoadRoomHistory, { passive: true });

function roomEntryIsExpanded(entry) {
    return roomExpandedEntries.has(entry.id) || (entry.defaultExpanded && !roomCollapsedEntries.has(entry.id));
}

function roomEntryBody(entry) {
    const cached = roomEntryBodies.get(entry.id);
    return cached && cached.version === entry.textVersion ? cached.text : null;
}

async function loadRoomEntryText(entryId, source = null) {
    const entry = source || activeRoom?.entries.find(item => item.id === entryId) || roomQuoteEntries.get(entryId);
    if (!entry) return;
    const cached = roomEntryBody(entry);
    if (cached !== null) return cached;
    const existing = roomEntryBodyRequests.get(entryId);
    if (existing && existing.version === entry.textVersion) return existing.promise;
    const id = activeRoomId, generation = roomContentGeneration;
    const request = { version: entry.textVersion };
    roomEntryBodyErrors.delete(entryId);
    request.promise = (async () => {
        let offset = 0, text = '';
        do {
            const query = new URLSearchParams({ offset: String(offset) });
            if (entry.textVersion) query.set('version', entry.textVersion);
            const response = await fetchWithTimeout(`/api/rooms/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/text?${query}`, {}, 15000);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not read message');
            if (id !== activeRoomId || generation !== roomContentGeneration) return;
            text += data.text;
            if (!data.hasMore) break;
            if (data.nextOffset <= offset) throw new Error('Message loading did not advance');
            offset = data.nextOffset;
        } while (true);
        roomEntryBodies.set(entryId, { version: entry.textVersion, text });
        return text;
    })().catch(error => {
        if (id === activeRoomId && generation === roomContentGeneration) roomEntryBodyErrors.set(entryId, error.message);
    }).finally(() => {
        if (roomEntryBodyRequests.get(entryId) === request) roomEntryBodyRequests.delete(entryId);
        if (id === activeRoomId && generation === roomContentGeneration) renderActiveRoom();
    });
    roomEntryBodyRequests.set(entryId, request);
    renderActiveRoom();
    return request.promise;
}

function toggleRoomEntryExpansion(entryId) {
    const entry = activeRoom?.entries.find(item => item.id === entryId);
    if (!entry) return;
    if (roomEntryIsExpanded(entry)) {
        roomExpandedEntries.delete(entryId); roomCollapsedEntries.add(entryId);
    } else {
        roomExpandedEntries.add(entryId); roomCollapsedEntries.delete(entryId);
    }
    if (roomEntryIsExpanded(entry) && entry.textDeferred && roomEntryBody(entry) === null) {
        void loadRoomEntryText(entryId);
    } else renderActiveRoom();
}
