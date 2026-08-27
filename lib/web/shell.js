        async function deleteSession(id, e) {
            e?.stopPropagation();
            if (!confirm('Terminate session?')) return;
            const button = e?.currentTarget;
            if (button) button.disabled = true;
            try {
                const response = await fetchWithTimeout('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }, 10000);
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}`);
                }
                if (id === activeSessionId) showLobby();
                else await refreshSessionsNow();
            } catch (error) {
                if (button?.isConnected) button.disabled = false;
                alert(`Failed to delete session: ${error.message}`);
            }
        }

        function showLobby() {
            if (currentSocket) { currentSocket.close(); currentSocket = null; }
            closeTimedSendPanel();
            stopTimedInputTimers();
            activeSessionId = null;
            window.activeSessionId = null;
            activeToolKey = null;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('lobby-view').classList.add('active');
            refreshSessionsNow();
        }

        function updateToolShortcuts(toolKey) {
            const usesUsageCommand = ['antigravity', 'claude-code'].includes(toolKey);
            const usageCommand = usesUsageCommand ? '/usage' : '/stat';
            const defaultShortcuts = [
                { key: 'left', label: '←', special: true },
                { key: 'right', label: '→', special: true },
                { key: 'ctrl-c', label: 'Ctrl+C' },
                { command: '/model' },
                { command: '/resume' },
                { command: usageCommand }
            ];
            const toolShortcuts = {
                codex: [
                    { key: 'ctrl-c', label: 'Ctrl+C' },
                    { key: 'codex-perm', label: '/perm', title: 'Send /perm' },
                    { command: '/model' },
                    { command: '/resume' },
                    { command: '/stat' }
                ]
            };
            const shortcuts = toolShortcuts[toolKey] || defaultShortcuts;
            const shortcutGroup = document.querySelector('[data-role="tool-shortcuts"]');
            if (!shortcutGroup) return;

            shortcutGroup.style.gridTemplateColumns = `repeat(${shortcuts.length}, minmax(0, 1fr))`;
            shortcutGroup.replaceChildren(...shortcuts.map(shortcut => {
                const button = document.createElement(shortcut.command ? 'button' : 'div');
                button.className = shortcut.command
                    ? 'command-key'
                    : `key-btn${shortcut.special ? ' special-key' : ''}`;
                if (shortcut.command) {
                    button.dataset.command = shortcut.command;
                    button.textContent = shortcut.command;
                    button.title = `Send ${shortcut.command}`;
                } else {
                    button.dataset.key = shortcut.key;
                    button.textContent = shortcut.label;
                    button.title = shortcut.title || '';
                }
                return button;
            }));
        }
