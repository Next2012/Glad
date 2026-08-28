        let serverChanSettings = null;
        let serverChanToastTimer = null;

        function serverChanBellSvg() {
            return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>';
        }

        function renderServerChanSessionAction(session) {
            const enabled = Boolean(session.serverChanNotificationEnabled);
            const title = enabled ? 'Disable ServerChan notifications for this chat' : 'Enable ServerChan notifications for this chat';
            return `<button class="serverchan-toggle${enabled ? ' active' : ''}" type="button"
                data-serverchan-session="${escapeHtml(session.id)}"
                aria-label="${title}" title="${title}"
                onclick="toggleServerChanSession('${session.id}', ${enabled ? 'false' : 'true'}, event)">
                ${serverChanBellSvg()}
            </button>`;
        }

        function showAppToast(message) {
            const toast = document.getElementById('app-toast');
            toast.textContent = message;
            toast.classList.add('visible');
            clearTimeout(serverChanToastTimer);
            serverChanToastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
        }

        async function toggleServerChanSession(sessionId, enabled, event) {
            event?.stopPropagation();
            try {
                const response = await fetchWithTimeout(`/api/sessions/${sessionId}/notifications/serverchan`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                }, 10000);
                const data = await response.json();
                if (!response.ok) {
                    if (data.code === 'SERVERCHAN_NOT_CONFIGURED') {
                        showAppToast('Configure ServerChan in Settings first');
                        return;
                    }
                    throw new Error(data.error || 'Could not update notifications');
                }
                await refreshSessionsNow();
            } catch (error) {
                showAppToast(error.message || 'Could not update notifications');
            }
        }

        async function openSettings(event = null) {
            event?.stopPropagation();
            document.getElementById('settings-modal-overlay').style.display = 'flex';
            if (typeof syncGladThemeControls === 'function') syncGladThemeControls();
            if (typeof loadSkillHubSettings === 'function') void loadSkillHubSettings();
            setServerChanStatus('Loading configuration…');
            try {
                const response = await fetchWithTimeout('/api/notifications/serverchan', {}, 10000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not load configuration');
                serverChanSettings = data;
                document.getElementById('serverchan-client-type').value = data.clientType || 'wechat';
                const keyInput = document.getElementById('serverchan-send-key');
                keyInput.value = '';
                keyInput.placeholder = data.configured ? data.maskedKey : 'SCT...';
                document.getElementById('serverchan-key-hint').textContent = data.configured
                    ? `Saved: ${data.maskedKey}. Leave blank to keep the current SendKey.`
                    : 'The SendKey is stored only on this Glad host.';
                document.getElementById('serverchan-remove-btn').style.display = data.configured ? 'inline-flex' : 'none';
                setServerChanStatus(data.configured ? 'Configuration saved.' : 'ServerChan is not configured.');
            } catch (error) {
                setServerChanStatus(error.message || 'Could not load configuration', 'error');
            }
        }

        function closeSettings(event = null) {
            if (event && event.target.id !== 'settings-modal-overlay') return;
            document.getElementById('settings-modal-overlay').style.display = 'none';
        }

        function currentServerChanForm() {
            return {
                sendKey: document.getElementById('serverchan-send-key').value.trim(),
                clientType: document.getElementById('serverchan-client-type').value
            };
        }

        function setServerChanStatus(message, type = '') {
            const status = document.getElementById('serverchan-settings-status');
            status.textContent = message;
            status.className = `serverchan-settings-status${type ? ` ${type}` : ''}`;
        }

        function setServerChanBusy(busy) {
            document.getElementById('serverchan-save-btn').disabled = busy;
            document.getElementById('serverchan-test-btn').disabled = busy;
            document.getElementById('serverchan-remove-btn').disabled = busy;
        }

        async function saveServerChanSettings() {
            setServerChanBusy(true);
            setServerChanStatus('Saving…');
            try {
                const response = await fetchWithTimeout('/api/notifications/serverchan', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentServerChanForm())
                }, 10000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not save configuration');
                serverChanSettings = data.settings;
                const keyInput = document.getElementById('serverchan-send-key');
                keyInput.value = '';
                keyInput.placeholder = data.settings.maskedKey;
                document.getElementById('serverchan-key-hint').textContent =
                    `Saved: ${data.settings.maskedKey}. Leave blank to keep the current SendKey.`;
                document.getElementById('serverchan-remove-btn').style.display = 'inline-flex';
                setServerChanStatus('Configuration saved. Per-chat notification switches are unchanged.', 'success');
            } catch (error) {
                setServerChanStatus(error.message || 'Could not save configuration', 'error');
            } finally {
                setServerChanBusy(false);
            }
        }

        async function testServerChanSettings() {
            setServerChanBusy(true);
            setServerChanStatus('Sending test message…');
            try {
                const response = await fetchWithTimeout('/api/notifications/serverchan/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentServerChanForm())
                }, 15000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not send test message');
                setServerChanStatus('Test message sent. The test did not save configuration.', 'success');
            } catch (error) {
                setServerChanStatus(error.message || 'Could not send test message', 'error');
            } finally {
                setServerChanBusy(false);
            }
        }

        async function removeServerChanSettings() {
            if (!confirm('Remove ServerChan configuration and disable notifications for every chat?')) return;
            setServerChanBusy(true);
            try {
                const response = await fetchWithTimeout('/api/notifications/serverchan', {
                    method: 'DELETE'
                }, 10000);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not remove configuration');
                serverChanSettings = data.settings;
                document.getElementById('serverchan-send-key').value = '';
                document.getElementById('serverchan-send-key').placeholder = 'SCT...';
                document.getElementById('serverchan-key-hint').textContent = 'The SendKey is stored only on this Glad host.';
                document.getElementById('serverchan-remove-btn').style.display = 'none';
                setServerChanStatus('Configuration removed. Notifications are disabled for every chat.', 'success');
                await refreshSessionsNow();
            } catch (error) {
                setServerChanStatus(error.message || 'Could not remove configuration', 'error');
            } finally {
                setServerChanBusy(false);
            }
        }
