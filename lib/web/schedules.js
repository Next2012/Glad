        async function ensureScheduleTools() {
            if (scheduleTools.length) return;
            const res = await fetchWithTimeout('/api/tools');
            scheduleTools = await res.json();
        }

        function defaultSchedule() {
            return {
                id: null,
                name: 'Scheduled Task',
                enabled: true,
                schedule: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
                target: { toolKey: (scheduleTools[0] && scheduleTools[0].key) || 'demo', workingDirectory: '' },
                steps: [
                    { type: 'sleep', seconds: 60 },
                    { type: 'sendText', text: 'hello' },
                    { type: 'sleep', seconds: 1 },
                    { type: 'sendKey', key: 'enter' },
                    { type: 'sleep', seconds: 60 },
                    { type: 'closeSession' }
                ]
            };
        }

        async function showScheduleModal(job = null) {
            try {
                await ensureScheduleTools();
                loadAppConfig();
            } catch (e) {
                alert('Failed to load tools');
                return;
            }

            const data = job || defaultSchedule();
            editingScheduleId = data.id || null;
            editingSteps = (data.steps || []).map(step => ({ ...step }));
            selectedWeekdays = [...(data.schedule.weekdays || [1, 2, 3, 4, 5])];
            document.getElementById('schedule-modal-title').textContent = editingScheduleId ? 'Edit Scheduled Task' : 'New Scheduled Task';
            document.getElementById('schedule-name').value = data.name || 'Scheduled Task';
            document.getElementById('schedule-cwd').value = data.target.workingDirectory || '';
            document.getElementById('schedule-time').value = data.schedule.time || '09:00';

            const toolSelect = document.getElementById('schedule-tool');
            toolSelect.innerHTML = scheduleTools.map(t => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.displayName)}</option>`).join('');
            const requestedTool = data.target.toolKey || '';
            toolSelect.value = scheduleTools.some(t => t.key === requestedTool) ? requestedTool : ((scheduleTools[0] && scheduleTools[0].key) || 'demo');
            renderWeekdays();
            renderScheduleSteps();
            document.getElementById('schedule-modal-overlay').style.display = 'flex';
        }

        function closeScheduleModal(e) {
            if (!e || e.target.id === 'schedule-modal-overlay') {
                document.getElementById('schedule-modal-overlay').style.display = 'none';
            }
        }

        function renderWeekdays() {
            const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            document.getElementById('schedule-weekdays').innerHTML = labels.map((label, day) => {
                const active = selectedWeekdays.includes(day);
                return `<button type="button" class="weekday-btn ${active ? 'active' : ''}" onclick="toggleWeekday(${day})">${label}</button>`;
            }).join('');
        }

        function toggleWeekday(day) {
            if (selectedWeekdays.includes(day)) {
                selectedWeekdays = selectedWeekdays.filter(value => value !== day);
            } else {
                selectedWeekdays.push(day);
                selectedWeekdays.sort((a, b) => a - b);
            }
            renderWeekdays();
        }

        function addScheduleStep(type) {
            if (!type) return;
            const defaults = {
                sleep: { type: 'sleep', seconds: 1 },
                sendText: { type: 'sendText', text: '' },
                sendKey: { type: 'sendKey', key: 'enter' },
                keyDown: { type: 'keyDown', key: 'ctrl' },
                keyUp: { type: 'keyUp', key: 'ctrl' },
                stop: { type: 'stop' },
                closeSession: { type: 'closeSession' }
            };
            editingSteps.push(defaults[type] || { type });
            renderScheduleSteps();
        }

        function updateStep(index, field, value) {
            if (!editingSteps[index]) return;
            if (field === 'seconds') editingSteps[index][field] = Math.max(0, Number(value) || 0);
            else editingSteps[index][field] = value;
        }

        function moveStep(index, delta) {
            const nextIndex = index + delta;
            if (nextIndex < 0 || nextIndex >= editingSteps.length) return;
            const [step] = editingSteps.splice(index, 1);
            editingSteps.splice(nextIndex, 0, step);
            renderScheduleSteps();
        }

        function copyStep(index) {
            editingSteps.splice(index + 1, 0, { ...editingSteps[index] });
            renderScheduleSteps();
        }

        function removeStep(index) {
            editingSteps.splice(index, 1);
            renderScheduleSteps();
        }

        function stepInputHtml(step, index) {
            if (step.type === 'sleep') {
                return `<input type="number" min="0" step="0.1" value="${escapeHtml(step.seconds || 0)}" onchange="updateStep(${index}, 'seconds', this.value)">`;
            }
            if (step.type === 'sendText') {
                return `<textarea rows="2" placeholder="Text to send" onchange="updateStep(${index}, 'text', this.value)" oninput="updateStep(${index}, 'text', this.value)">${escapeHtml(step.text || '')}</textarea>`;
            }
            if (step.type === 'sendKey') {
                return `<select onchange="updateStep(${index}, 'key', this.value)">
                    ${['enter','tab','esc','up','down','left','right','backspace','delete','home','end','ctrl+c','ctrl+d','ctrl+l'].map(key => `<option value="${key}" ${step.key === key ? 'selected' : ''}>${key}</option>`).join('')}
                </select>`;
            }
            if (step.type === 'keyDown' || step.type === 'keyUp') {
                return `<select onchange="updateStep(${index}, 'key', this.value)">
                    ${['ctrl','alt'].map(key => `<option value="${key}" ${step.key === key ? 'selected' : ''}>${key}</option>`).join('')}
                </select>`;
            }
            if (step.type === 'closeSession') {
                return '<span style="color:var(--text-dim); font-size:13px;">Close the session and end this run</span>';
            }
            return '<span style="color:var(--text-dim); font-size:13px;">End this run</span>';
        }

        function renderScheduleSteps() {
            const container = document.getElementById('schedule-steps');
            if (!editingSteps.length) {
                container.innerHTML = '<p style="color:var(--text-dim);">No steps yet.</p>';
                return;
            }
            container.innerHTML = editingSteps.map((step, index) => `
                <div class="step-card">
                    <div class="step-grid">
                        <select onchange="editingSteps[${index}] = { type: this.value }; addDefaultStepFields(${index}); renderScheduleSteps();">
                            ${['sleep','sendText','sendKey','keyDown','keyUp','stop','closeSession'].map(type => `<option value="${type}" ${step.type === type ? 'selected' : ''}>${type}</option>`).join('')}
                        </select>
                        <div>${stepInputHtml(step, index)}</div>
                        <div style="display:flex; gap:6px; justify-content:flex-end;">
                            <button class="small-btn" onclick="moveStep(${index}, -1)">↑</button>
                            <button class="small-btn" onclick="moveStep(${index}, 1)">↓</button>
                            <button class="small-btn" onclick="copyStep(${index})">Copy</button>
                            <button class="small-btn danger" onclick="removeStep(${index})">Del</button>
                        </div>
                    </div>
                </div>
            `).join('');
        }

        function addDefaultStepFields(index) {
            const type = editingSteps[index].type;
            if (type === 'sleep') editingSteps[index].seconds = 1;
            if (type === 'sendText') editingSteps[index].text = '';
            if (type === 'sendKey') editingSteps[index].key = 'enter';
            if (type === 'keyDown' || type === 'keyUp') editingSteps[index].key = 'ctrl';
        }

        function collectSchedulePayload() {
            if (!selectedWeekdays.length) throw new Error('Select at least one weekday');
            return {
                name: document.getElementById('schedule-name').value.trim() || 'Scheduled Task',
                enabled: true,
                schedule: {
                    time: document.getElementById('schedule-time').value || '09:00',
                    weekdays: selectedWeekdays
                },
                target: {
                    toolKey: document.getElementById('schedule-tool').value,
                    workingDirectory: document.getElementById('schedule-cwd').value.trim()
                },
                steps: editingSteps
            };
        }

        async function saveSchedule() {
            try {
                const payload = collectSchedulePayload();
                const url = editingScheduleId ? `/api/schedules/${editingScheduleId}` : '/api/schedules';
                const method = editingScheduleId ? 'PATCH' : 'POST';
                const res = await fetchWithTimeout(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
                closeScheduleModal();
                switchLobbyTab('schedules');
            } catch (e) {
                alert(e.message);
            }
        }

        async function editSchedule(id) {
            const res = await fetchWithTimeout(`/api/schedules/${id}`);
            if (!res.ok) return alert('Failed to load schedule');
            showScheduleModal(await res.json());
        }

        async function simulateSchedule(id) {
            try {
                const res = await fetchWithTimeout(`/api/schedules/${id}/simulate`, { method: 'POST' }, 30000);
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Test failed');
                await loadSchedules();
                if (data.sessionId) {
                    const jobRes = await fetchWithTimeout(`/api/schedules/${id}`).catch(() => null);
                    const job = jobRes && jobRes.ok ? await jobRes.json() : null;
                    joinSession(data.sessionId, 'Schedule Test', job?.target?.toolKey || null);
                }
            } catch (e) {
                alert(e.message);
            }
        }

        async function duplicateSchedule(id) {
            await fetchWithTimeout(`/api/schedules/${id}/duplicate`, { method: 'POST' });
            loadSchedules();
        }

        async function toggleSchedule(id, enabled) {
            await fetchWithTimeout(`/api/schedules/${id}/enabled`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            loadSchedules();
        }

        async function deleteSchedule(id) {
            if (!confirm('Delete scheduled task?')) return;
            await fetchWithTimeout(`/api/schedules/${id}`, { method: 'DELETE' });
            loadSchedules();
        }
