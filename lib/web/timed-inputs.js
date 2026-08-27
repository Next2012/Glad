        let timedInputs = [];

        function initTimedDelaySelectors() {
            const hours = document.getElementById('timed-hours');
            const minutes = document.getElementById('timed-minutes');
            if (hours.options.length) return;
            for (let i = 0; i <= 23; i++) {
                hours.add(new Option(`${i} hr`, String(i)));
            }
            for (let i = 0; i <= 59; i++) {
                minutes.add(new Option(`${i} min`, String(i)));
            }
            hours.value = '0';
            minutes.value = '5';
        }

        function getTimedDelayMs() {
            const hours = Number(document.getElementById('timed-hours').value);
            const minutes = Number(document.getElementById('timed-minutes').value);
            const delayMs = ((hours * 60) + minutes) * 60 * 1000;
            return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
        }

        function parseSendAt() {
            const delayMs = getTimedDelayMs();
            return delayMs > 0 ? Date.now() + delayMs : null;
        }

        function setTimedDelayFromMs(ms) {
            const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
            const hours = Math.min(23, Math.floor(totalMinutes / 60));
            const minutes = Math.min(59, totalMinutes - hours * 60);
            document.getElementById('timed-hours').value = String(hours);
            document.getElementById('timed-minutes').value = String(minutes);
        }

        function updateTimedSendPreview() {
            const preview = document.getElementById('timed-preview');
            const sendAt = parseSendAt();
            preview.textContent = sendAt
                ? `Will run at ${new Date(sendAt).toLocaleString()}`
                : 'Choose at least 1 minute.';
        }

        function formatCountdown(sendAt) {
            const remaining = Math.max(0, sendAt - Date.now());
            const totalSeconds = Math.ceil(remaining / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            if (hours > 0) return `${hours}h\n${String(minutes).padStart(2, '0')}m`;
            return `${minutes}:${String(seconds).padStart(2, '0')}`;
        }

        function renderTimedTags() {
            const rail = document.getElementById('timed-tag-rail');
            const now = Date.now();
            const activeItems = timedInputs.filter(item => item.sendAt > now);
            rail.innerHTML = activeItems.map(item => {
                const encodedId = encodePathValue(item.id);
                return `<button class="timed-tag${item.id === editingTimedInputId ? ' active' : ''}" title="${escapeHtml(item.text)}" onclick="editTimedInput(decodePathValue('${encodedId}'))">${escapeHtml(formatCountdown(item.sendAt))}</button>`;
            }).join('');
        }

        function closeTimedSendPanel() {
            document.getElementById('timed-send-panel').classList.remove('active');
            editingTimedInputId = null;
            renderTimedTags();
            syncComposerButtonState();
            updateTerminalControlsHeight();
        }

        function stopTimedInputTimers() {
            clearTimeout(timedSendRefreshTimer);
            timedSendRefreshTimer = null;
            if (timedTagTimer) clearInterval(timedTagTimer);
            timedTagTimer = null;
            timedInputs = [];
            renderTimedTags();
        }

        function resetTimedEditor(options = {}) {
            editingTimedInputId = null;
            document.getElementById('timed-save-btn').textContent = 'Add Timer';
            document.getElementById('timed-cancel-edit-btn').style.display = 'none';
            document.getElementById('timed-delete-btn').style.display = 'none';
            if (!options.keepInput) {
                inputEl.value = '';
                inputEl.style.height = '38px';
            }
            setTimedDelayFromMs(5 * 60 * 1000);
            updateTimedSendPreview();
            renderTimedTags();
        }

        async function loadTimedInputs() {
            clearTimeout(timedSendRefreshTimer);
            timedSendRefreshTimer = null;
            if (!activeSessionId) return;

            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/timed-inputs`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                timedInputs = data.items || [];
                renderTimedTags();
                if (!timedTagTimer) timedTagTimer = setInterval(renderTimedTags, 1000);
                timedSendRefreshTimer = setTimeout(loadTimedInputs, 15000);
            } catch (e) {
                timedInputs = [];
                renderTimedTags();
            }
        }

        function editTimedInput(id) {
            const item = timedInputs.find(value => value.id === id);
            if (!item) return;
            initTimedDelaySelectors();
            editingTimedInputId = id;
            inputEl.value = item.text || '';
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
            setTimedDelayFromMs(item.sendAt - Date.now());
            document.getElementById('timed-save-btn').textContent = 'Update Timer';
            document.getElementById('timed-cancel-edit-btn').style.display = '';
            document.getElementById('timed-delete-btn').style.display = '';
            document.getElementById('timed-send-panel').classList.add('active');
            updateTimedSendPreview();
            renderTimedTags();
            syncComposerButtonState();
            updateTerminalControlsHeight();
        }

        async function saveTimedSend() {
            if (!activeSessionId) return alert('No active session');
            const text = inputEl.value;
            if (!text.trim()) return alert('Type a message first');
            const sendAt = parseSendAt();
            if (!sendAt) return alert('Choose at least 1 minute');

            try {
                const url = editingTimedInputId
                    ? `/api/sessions/${activeSessionId}/timed-inputs/${editingTimedInputId}`
                    : `/api/sessions/${activeSessionId}/timed-inputs`;
                const res = await fetchWithTimeout(url, {
                    method: editingTimedInputId ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, sendAt })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save timer');
                resetTimedEditor();
                await loadTimedInputs();
            } catch (e) {
                alert('Save failed: ' + e.message);
            }
        }

        async function cancelTimedInput(id) {
            if (!activeSessionId) return;
            try {
                await fetchWithTimeout(`/api/sessions/${activeSessionId}/timed-inputs/${id}`, { method: 'DELETE' });
                if (editingTimedInputId === id) resetTimedEditor();
                loadTimedInputs();
            } catch (e) {
                alert('Delete failed');
            }
        }

        function deleteEditingTimedInput() {
            if (editingTimedInputId) cancelTimedInput(editingTimedInputId);
        }

        document.getElementById('send-btn').addEventListener('click', performSend);
        document.getElementById('attach-image-btn').addEventListener('click', () => {
            imageFileInput.click();
        });
        document.getElementById('attach-file-btn').addEventListener('click', () => {
            attachmentFileInput.click();
        });
        document.getElementById('schedule-send-btn').addEventListener('click', () => {
            if (document.getElementById('timed-send-panel').classList.contains('active')) closeTimedSendPanel();
            else openTimedSendPanel();
        });
        imageFileInput.addEventListener('change', () => {
            const files = imageFileInput.files;
            if (files?.length) void uploadImageFiles(files);
            imageFileInput.value = '';
        });
        attachmentFileInput.addEventListener('change', () => {
            const files = attachmentFileInput.files;
            if (files?.length) void uploadAttachmentFiles(files);
            attachmentFileInput.value = '';
        });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); performSend(); }
            else if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') {
                markInputEditStart();
                if (keepTerminalBottomForNextInput) requestAnimationFrame(restoreTerminalBottomSoon);
            }
        });

        document.getElementById('shortcut-rail').addEventListener('click', (e) => {
            const commandBtn = e.target.closest('.command-key');
            if (commandBtn) {
                const command = commandBtn.dataset.command;
                if (command) {
                    sendWS(command);
                    setTimeout(() => { sendWS('\r'); }, 1000);
                }
                return;
            }

            const keyBtn = e.target.closest('.key-btn'); if (!keyBtn) return;
            const key = keyBtn.dataset.key;
            if (key === 'ctrl') { modifiers[key] = !modifiers[key]; keyBtn.classList.toggle('active', modifiers[key]); return; }
            if (key === 'codex-perm') {
                sendWS('/perm');
                setTimeout(() => { sendWS('\r'); }, 1000);
                return;
            }
            const sequences = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', 'ctrl-y': '\x19' };
            if (sequences[key]) sendWS(sequences[key]);
        });
