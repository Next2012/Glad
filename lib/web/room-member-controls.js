let memberControlId = null;
let memberControlRoomId = null;
let memberControlPoll = null;
let memberControlReading = false;
let memberControlHistory = false;
let memberControlOffset = 0;
let memberControlTurn = '';
let memberControlSendingId = null;

function stopMemberControlPolling() {
    clearInterval(memberControlPoll); memberControlPoll = null;
}
function resetMemberControls() {
    stopMemberControlPolling(); memberControlId = null;
    document.getElementById('room-members-home').hidden = false;
    document.getElementById('room-member-controls').hidden = true;
    document.getElementById('room-members-title').textContent = 'Group members';
}
function backRoomMembers() {
    if (memberControlId) resetMemberControls(); else closeRoomMembers();
}
async function openMemberControls(memberId) {
    const member = activeRoom?.members.find(item => item.id === memberId && !item.leftAt);
    if (!member) return;
    stopMemberControlPolling(); memberControlId = memberId; memberControlRoomId = activeRoomId;
    memberControlHistory = false; memberControlOffset = 0; memberControlTurn = ''; memberControlSendingId = null;
    document.getElementById('room-members-home').hidden = true;
    document.getElementById('room-member-controls').hidden = false;
    document.getElementById('room-members-title').textContent = member.displayName;
    document.getElementById('member-command').value = '';
    document.getElementById('member-control-output').textContent = '';
    document.getElementById('member-control-error').textContent = '';
    await readMemberOutput(false, 0);
    memberControlPoll = setInterval(() => {
        if (memberControlRoomId !== activeRoomId || !document.getElementById('room-members-overlay').classList.contains('active')) { stopMemberControlPolling(); return; }
        if (!memberControlHistory) void readMemberOutput(false, 0);
    }, 1000);
}
async function memberControlRequest(path, options = {}) {
    const member = activeRoom?.members.find(item => item.id === memberControlId && !item.leftAt);
    if (!member?.available || memberControlRoomId !== activeRoomId) throw new Error('Session unavailable. Resume it before controlling it.');
    const response = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(member.sessionId)}/${path}`, options, 35000);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}
async function readMemberOutput(history = memberControlHistory, offset = memberControlOffset) {
    if (memberControlReading || !memberControlId) return;
    memberControlReading = true; memberControlHistory = history; memberControlOffset = offset;
    const id = memberControlId;
    try {
        const data = await memberControlRequest(`output?limit=30&history=${history}&offset=${offset}`);
        if (id !== memberControlId) return;
        memberControlTurn = data.currentTurnId || '';
        document.getElementById('member-control-status').textContent = data.canAccept ? 'Ready for a command' : data.readinessReason || data.status;
        const output = document.getElementById('member-control-output');
        const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
        output.textContent = data.messages.map(message => `${message.kind}: ${message.text || message.title || message.toolStatus || ''}`).join('\n\n') || 'No output yet.';
        if (!history && follow) output.scrollTop = output.scrollHeight;
        document.getElementById('member-start').disabled = !data.canAccept;
        document.getElementById('member-stop').disabled = data.canAccept;
        document.getElementById('member-history-next').hidden = !history || !data.hasMore;
    } catch (error) {
        if (id === memberControlId) { document.getElementById('member-control-error').textContent = error.message; document.getElementById('member-start').disabled = true; }
    } finally { memberControlReading = false; }
}
async function stopMemberRun() {
    const button = document.getElementById('member-stop'); button.disabled = true;
    try {
        await memberControlRequest('abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedTurnId: memberControlTurn }) });
        document.getElementById('member-control-status').textContent = 'Stopping…';
        await readMemberOutput();
    } catch (error) { document.getElementById('member-control-error').textContent = error.message; button.disabled = false; }
}
async function sendMemberCommand() {
    const input = document.getElementById('member-command');
    if (!input.value.trim()) return;
    const button = document.getElementById('member-start'); button.disabled = true;
    const id = memberControlId, text = input.value;
    if (memberControlSendingId?.text !== text) memberControlSendingId = { text, id: crypto.randomUUID() };
    try {
        await memberControlRequest('input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientMessageId: memberControlSendingId.id }) });
        if (id !== memberControlId) return;
        input.value = ''; memberControlSendingId = null; document.getElementById('member-control-error').textContent = '';
        await readMemberOutput(false, 0);
    } catch (error) { if (id === memberControlId) document.getElementById('member-control-error').textContent = error.message; }
}
