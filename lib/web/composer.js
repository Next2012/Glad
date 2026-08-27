        const inputEl = document.getElementById('cmd-input');
        const attachmentFileInput = document.getElementById('attachment-file-input');
        const attachmentStrip = document.getElementById('attachment-strip');
        let selectedImageAttachments = [];
        let selectedFileAttachments = [];
        let keepTerminalBottomForNextInput = false;
        const composerActionTooltip = document.getElementById('composer-action-tooltip');
        let composerActionTooltipTimer = null;
        let composerTouchGesture = null;
        let suppressTouchFocusUntil = 0;
        let composerSendPending = false;

        function composerExecutionInProgress() {
            if (composerSendPending) return true;
            if (isClaudeSession()) return claudeStatus === 'thinking';
            if (isCodexSession()) return !codexReadyForInput();
            return false;
        }

        function syncComposerSendState({ acknowledgeProviderState = false } = {}) {
            if (acknowledgeProviderState) composerSendPending = false;
            const sendButton = document.getElementById('send-btn');
            const executing = composerExecutionInProgress();
            sendButton.disabled = executing;
            sendButton.title = executing ? 'Wait for the current run to finish' : 'Send';
            sendButton.setAttribute('aria-label', executing ? 'Send disabled while running' : 'Send');
        }

        function markComposerSendPending() {
            composerSendPending = true;
            syncComposerSendState();
        }

        function resetComposerSendState() {
            composerSendPending = false;
            syncComposerSendState();
        }

        function composerActionControl(target) {
            const control = target instanceof Element ? target.closest('button, label') : null;
            if (!control || !document.getElementById('terminal-controls').contains(control)) return null;
            return control.querySelector('.action-icon') ? control : null;
        }

        function composerActionName(control) {
            return control?.querySelector('.action-label')?.textContent?.trim()
                || control?.getAttribute('aria-label')
                || control?.getAttribute('title')
                || '';
        }

        function hideComposerActionTooltip() {
            clearTimeout(composerActionTooltipTimer);
            composerActionTooltipTimer = null;
            composerActionTooltip.classList.remove('visible');
        }

        function showComposerActionTooltip(control, autoHide = false) {
            const label = composerActionName(control);
            if (!label) return;
            clearTimeout(composerActionTooltipTimer);
            composerActionTooltip.textContent = label;
            composerActionTooltip.classList.add('visible');
            const controlBox = control.getBoundingClientRect();
            const tooltipBox = composerActionTooltip.getBoundingClientRect();
            const left = Math.max(8, Math.min(window.innerWidth - tooltipBox.width - 8,
                controlBox.left + controlBox.width / 2 - tooltipBox.width / 2));
            const above = controlBox.top - tooltipBox.height - 8;
            composerActionTooltip.style.left = `${left}px`;
            composerActionTooltip.style.top = `${above >= 8 ? above : controlBox.bottom + 8}px`;
            if (autoHide) composerActionTooltipTimer = setTimeout(hideComposerActionTooltip, 1400);
        }

        const terminalControls = document.getElementById('terminal-controls');
        terminalControls.addEventListener('focusin', event => {
            if (performance.now() < suppressTouchFocusUntil) return;
            const control = composerActionControl(event.target);
            if (control) showComposerActionTooltip(control);
        });
        terminalControls.addEventListener('focusout', hideComposerActionTooltip);
        terminalControls.addEventListener('pointerover', event => {
            const control = composerActionControl(event.target);
            if (control && event.pointerType !== 'touch') showComposerActionTooltip(control);
        });
        terminalControls.addEventListener('pointerout', event => {
            const control = composerActionControl(event.target);
            if (control && !control.contains(event.relatedTarget)) hideComposerActionTooltip();
        });
        terminalControls.addEventListener('pointerdown', event => {
            const control = composerActionControl(event.target);
            if (control && event.pointerType === 'touch') {
                composerTouchGesture = { pointerId: event.pointerId, control, x: event.clientX, y: event.clientY, moved: false };
                suppressTouchFocusUntil = performance.now() + 800;
                hideComposerActionTooltip();
            }
        });
        terminalControls.addEventListener('pointermove', event => {
            if (!composerTouchGesture || event.pointerId !== composerTouchGesture.pointerId) return;
            if (Math.hypot(event.clientX - composerTouchGesture.x, event.clientY - composerTouchGesture.y) > 8) {
                composerTouchGesture.moved = true;
                hideComposerActionTooltip();
            }
        });
        terminalControls.addEventListener('pointerup', event => {
            if (!composerTouchGesture || event.pointerId !== composerTouchGesture.pointerId) return;
            const gesture = composerTouchGesture;
            composerTouchGesture = null;
            suppressTouchFocusUntil = performance.now() + 800;
            if (!gesture.moved) showComposerActionTooltip(gesture.control, true);
        });
        terminalControls.addEventListener('pointercancel', () => {
            composerTouchGesture = null;
            hideComposerActionTooltip();
        });
        terminalControls.addEventListener('scroll', hideComposerActionTooltip, true);

        function isStructuredImageAttachmentAvailable() {
            return isClaudeSession() || isCodexSession();
        }

        function isSupportedImageFile(file) {
            const type = String(file?.type || '').toLowerCase();
            const name = String(file?.name || '').toLowerCase();
            return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)
                || /\.(png|jpe?g|gif|webp)$/.test(name);
        }

        function syncComposerButtonState() {
            const timerOpen = document.getElementById('timed-send-panel').classList.contains('active');
            document.getElementById('schedule-send-btn').classList.toggle('active', timerOpen);
            document.getElementById('attachment-btn').classList.toggle('active', selectedImageAttachments.length + selectedFileAttachments.length > 0);
        }

        function renderComposerAttachments() {
            const chip = (item, kind) => `<div class="attachment-chip ${kind}${item.uploading ? ' uploading' : ''}"><svg class="attachment-chip-icon action-icon" aria-hidden="true"><use href="#icon-${kind === 'image' ? 'image' : 'file'}"></use></svg><span class="attachment-chip-content"><span class="attachment-chip-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${item.uploading ? `<span class="attachment-progress${item.progressKnown ? '' : ' estimated'}"><span style="width:${Math.max(0, Math.min(100, item.progress || 0))}%"></span></span><span class="attachment-status">${escapeHtml(item.status || `Uploading ${kind}…`)}</span>` : ''}</span><button class="attachment-remove" type="button" title="Remove ${kind}" aria-label="Remove ${escapeHtml(item.name)}" onclick="${kind === 'image' ? 'removeImageAttachment' : 'removeFileAttachment'}('${item.id}')">×</button></div>`;
            attachmentStrip.innerHTML = [
                ...selectedImageAttachments.map(item => chip(item, 'image')),
                ...selectedFileAttachments.map(item => chip(item, 'file'))
            ].join('');
            attachmentStrip.classList.toggle('active', selectedImageAttachments.length + selectedFileAttachments.length > 0);
            syncComposerButtonState();
            updateTerminalControlsHeight();
        }

        window.removeImageAttachment = async function(attachmentId) {
            const attachment = selectedImageAttachments.find(item => item.id === attachmentId);
            selectedImageAttachments = selectedImageAttachments.filter(item => item.id !== attachmentId);
            renderComposerAttachments();
            if (!attachment) return;
            clearInterval(attachment.indicatorTimer);
            attachment.abortUpload?.();
            if (attachment.uploading) return;
            try {
                await fetchWithTimeout(`/api/sessions/${attachment.sessionId}/attachments/images/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
            } catch (_) {
                // The server also removes all attachments when the session ends.
            }
        };

        window.removeFileAttachment = async function(attachmentId) {
            const attachment = selectedFileAttachments.find(item => item.id === attachmentId);
            selectedFileAttachments = selectedFileAttachments.filter(item => item.id !== attachmentId);
            renderComposerAttachments();
            if (!attachment) return;
            attachment.abortUpload?.();
            if (attachment.uploading) return;
            try {
                await fetchWithTimeout(`/api/sessions/${attachment.sessionId}/attachments/files/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
            } catch (_) {}
        };

        async function clearComposerAttachments() {
            const pending = selectedImageAttachments;
            const pendingFiles = selectedFileAttachments;
            selectedImageAttachments = [];
            selectedFileAttachments = [];
            renderComposerAttachments();
            for (const item of pending) item.abortUpload?.();
            for (const item of pendingFiles) item.abortUpload?.();
            await Promise.all(pending.filter(item => !item.uploading).map(item => fetchWithTimeout(
                `/api/sessions/${item.sessionId}/attachments/images/${encodeURIComponent(item.id)}`,
                { method: 'DELETE' }
            ).catch(() => null)));
            await Promise.all(pendingFiles.filter(item => !item.uploading).map(item => fetchWithTimeout(
                `/api/sessions/${item.sessionId}/attachments/files/${encodeURIComponent(item.id)}`,
                { method: 'DELETE' }
            ).catch(() => null)));
        }

        const ATTACHMENT_UPLOAD_CHUNK_BYTES = 512 * 1024;

        function uploadImageInChunks(sessionId, file, onProgress) {
            let xhr = null;
            let cancelled = false;
            const uploadId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const chunkTotal = Math.ceil(file.size / ATTACHMENT_UPLOAD_CHUNK_BYTES);
            return {
                abort: () => {
                    cancelled = true;
                    xhr?.abort();
                    void fetch(`/api/sessions/${sessionId}/attachments/images/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => null);
                },
                promise: (async () => {
                    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
                        if (cancelled) throw new Error('Image upload cancelled');
                        const start = chunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES;
                        const chunk = file.slice(start, Math.min(file.size, start + ATTACHMENT_UPLOAD_CHUNK_BYTES));
                        const result = await new Promise((resolve, reject) => {
                            xhr = new XMLHttpRequest();
                            xhr.open('POST', `/api/sessions/${sessionId}/attachments/images/chunks`);
                            xhr.timeout = 60_000;
                            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
                            xhr.setRequestHeader('X-Glad-Upload-Id', uploadId);
                            xhr.setRequestHeader('X-Glad-Chunk-Index', String(chunkIndex));
                            xhr.setRequestHeader('X-Glad-Chunk-Total', String(chunkTotal));
                            xhr.onerror = () => reject(new Error('Network error while uploading image'));
                            xhr.ontimeout = () => reject(new Error(`Image upload timed out on chunk ${chunkIndex + 1}/${chunkTotal}`));
                            xhr.onabort = () => reject(new Error('Image upload cancelled'));
                            xhr.onload = () => {
                                let data = {};
                                try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                                if (xhr.status < 200 || xhr.status >= 300 || !data.success) {
                                    reject(new Error(data.error || `Upload failed (HTTP ${xhr.status})`));
                                    return;
                                }
                                resolve(data);
                            };
                            xhr.send(chunk);
                        });
                        const confirmedBytes = Math.min(file.size, start + chunk.size);
                        onProgress(Math.round((confirmedBytes / file.size) * 100), chunkIndex + 1, chunkTotal);
                        if (result.complete) return result.attachment;
                    }
                    throw new Error('Image upload did not complete');
                })()
            };
        }

        async function uploadImageFiles(files) {
            if (!isStructuredImageAttachmentAvailable()) {
                alert('Image attachments are available only in structured chat mode.');
                return;
            }
            const remaining = 5 - selectedImageAttachments.length;
            const batch = Array.from(files).slice(0, remaining);
            if (files.length > remaining) alert('You can attach up to 5 images at a time.');
            for (const file of batch) {
                if (file.size > 50 * 1024 * 1024) {
                    alert(`${file.name} is larger than 50 MB.`);
                    continue;
                }
                const chunkTotal = Math.ceil(file.size / ATTACHMENT_UPLOAD_CHUNK_BYTES);
                const pending = {
                    id: `uploading-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
                    name: file.name || 'image',
                    sessionId: activeSessionId,
                    uploading: true,
                    progress: 0,
                    progressKnown: true,
                    status: '0%',
                    abortUpload: null
                };
                selectedImageAttachments.push(pending);
                renderComposerAttachments();
                try {
                    const upload = uploadImageInChunks(activeSessionId, file, progress => {
                        pending.progress = progress;
                        pending.status = `${progress}%`;
                        renderComposerAttachments();
                    });
                    pending.abortUpload = upload.abort;
                    const attachment = await upload.promise;
                    const index = selectedImageAttachments.indexOf(pending);
                    if (index < 0) {
                        await fetchWithTimeout(`/api/sessions/${activeSessionId}/attachments/images/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
                        continue;
                    }
                    selectedImageAttachments[index] = { ...attachment, name: file.name || attachment.name, sessionId: activeSessionId };
                    renderComposerAttachments();
                } catch (e) {
                    selectedImageAttachments = selectedImageAttachments.filter(item => item !== pending);
                    renderComposerAttachments();
                    if (e.message === 'Image upload cancelled') continue;
                    alert(`Could not add ${file.name}: ${e.message}`);
                }
            }
        }

        function uploadFileInChunks(sessionId, file, onProgress) {
            let xhr = null;
            let cancelled = false;
            const uploadId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const chunkTotal = Math.ceil(file.size / ATTACHMENT_UPLOAD_CHUNK_BYTES);
            return {
                abort: () => {
                    cancelled = true;
                    xhr?.abort();
                    void fetch(`/api/sessions/${sessionId}/attachments/files/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => null);
                },
                promise: (async () => {
                    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
                        if (cancelled) throw new Error('File upload cancelled');
                        const start = chunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES;
                        const chunk = file.slice(start, Math.min(file.size, start + ATTACHMENT_UPLOAD_CHUNK_BYTES));
                        const result = await new Promise((resolve, reject) => {
                            xhr = new XMLHttpRequest();
                            xhr.open('POST', `/api/sessions/${sessionId}/attachments/files/chunks`);
                            xhr.timeout = 60_000;
                            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                            xhr.setRequestHeader('X-Glad-Upload-Id', uploadId);
                            xhr.setRequestHeader('X-Glad-Chunk-Index', String(chunkIndex));
                            xhr.setRequestHeader('X-Glad-Chunk-Total', String(chunkTotal));
                            xhr.setRequestHeader('X-Glad-File-Name', encodeURIComponent(file.name || 'attachment.bin'));
                            xhr.onerror = () => reject(new Error('Network error while uploading file'));
                            xhr.ontimeout = () => reject(new Error(`File upload timed out on chunk ${chunkIndex + 1}/${chunkTotal}`));
                            xhr.onabort = () => reject(new Error('File upload cancelled'));
                            xhr.onload = () => {
                                let data = {};
                                try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                                if (xhr.status < 200 || xhr.status >= 300 || !data.success) {
                                    reject(new Error(data.error || `Upload failed (HTTP ${xhr.status})`));
                                    return;
                                }
                                resolve(data);
                            };
                            xhr.send(chunk);
                        });
                        onProgress(Math.round((Math.min(file.size, start + chunk.size) / file.size) * 100));
                        if (result.complete) return result.attachment;
                    }
                    throw new Error('File upload did not complete');
                })()
            };
        }

        async function uploadAttachmentFiles(files) {
            const remaining = 8 - selectedFileAttachments.length;
            const batch = Array.from(files).slice(0, remaining);
            if (files.length > remaining) alert('You can attach up to 8 files at a time.');
            for (const file of batch) {
                if (!file.size) {
                    alert(`${file.name || 'File'} is empty.`);
                    continue;
                }
                if (file.size > 50 * 1024 * 1024) {
                    alert(`${file.name} is larger than 50 MB.`);
                    continue;
                }
                const pending = {
                    id: `uploading-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
                    name: file.name || 'attachment.bin',
                    sessionId: activeSessionId,
                    uploading: true,
                    progress: 0,
                    progressKnown: true,
                    status: '0%',
                    abortUpload: null
                };
                selectedFileAttachments.push(pending);
                renderComposerAttachments();
                try {
                    const upload = uploadFileInChunks(activeSessionId, file, progress => {
                        pending.progress = progress;
                        pending.status = `${progress}%`;
                        renderComposerAttachments();
                    });
                    pending.abortUpload = upload.abort;
                    const attachment = await upload.promise;
                    const index = selectedFileAttachments.indexOf(pending);
                    if (index < 0) {
                        await fetchWithTimeout(`/api/sessions/${activeSessionId}/attachments/files/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
                        continue;
                    }
                    selectedFileAttachments[index] = { ...attachment, name: file.name || attachment.name, sessionId: activeSessionId };
                    renderComposerAttachments();
                } catch (e) {
                    selectedFileAttachments = selectedFileAttachments.filter(item => item !== pending);
                    renderComposerAttachments();
                    if (e.message === 'File upload cancelled') continue;
                    alert(`Could not add ${file.name}: ${e.message}`);
                }
            }
        }

        async function uploadSelectedAttachments(files) {
            const selected = Array.from(files || []);
            const images = isStructuredImageAttachmentAvailable()
                ? selected.filter(isSupportedImageFile) : [];
            const regularFiles = selected.filter(file => !images.includes(file));
            if (images.length) await uploadImageFiles(images);
            if (regularFiles.length) await uploadAttachmentFiles(regularFiles);
        }

        function openTimedSendPanel() {
            if (isClaudeSession()) {
                closeClaudePicker();
                claudeResumePanelOpen = false;
                claudeForkPanelOpen = false;
                document.getElementById('claude-resume-panel').classList.remove('active');
                document.getElementById('claude-fork-panel').classList.remove('active');
            }
            initTimedDelaySelectors();
            resetTimedEditor({ keepInput: true });
            document.getElementById('timed-send-panel').classList.add('active');
            updateTimedSendPreview();
            loadTimedInputs();
            syncComposerButtonState();
            updateTerminalControlsHeight();
        }

        function markInputEditStart() {
            keepTerminalBottomForNextInput = keepTerminalBottomForNextInput || isTerminalAtBottom();
        }

        inputEl.addEventListener('beforeinput', markInputEditStart);
        inputEl.addEventListener('input', function() {
            const keepAtBottom = keepTerminalBottomForNextInput || isTerminalAtBottom();
            keepTerminalBottomForNextInput = false;
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 150) + 'px';
            if (keepAtBottom) restoreTerminalBottomSoon();
        });

        function performSend() {
            if (document.getElementById('send-btn').disabled) return;
            const val = inputEl.value;
            const readyImageAttachments = selectedImageAttachments.filter(item => !item.uploading);
            const readyFileAttachments = selectedFileAttachments.filter(item => !item.uploading);
            if (selectedImageAttachments.some(item => item.uploading) || selectedFileAttachments.some(item => item.uploading)) {
                alert('Wait for attachments to finish uploading before sending.');
                return;
            }
            if ((val || readyImageAttachments.length || readyFileAttachments.length) && isClaudeSession()) {
                if (currentSocket && currentSocket.readyState === 1) {
                    currentSocket.send(JSON.stringify({
                        type: 'claude-input',
                        text: val,
                        attachmentIds: readyImageAttachments.map(item => item.id),
                        ...(readyFileAttachments.length ? { fileAttachmentIds: readyFileAttachments.map(item => item.id) } : {})
                    }));
                    markComposerSendPending();
                }
                inputEl.value = '';
                inputEl.style.height = '38px';
                selectedImageAttachments = [];
                selectedFileAttachments = [];
                renderComposerAttachments();
                return;
            }
            if ((val || readyImageAttachments.length || readyFileAttachments.length) && isCodexSession()) {
                if (!codexReadyForInput()) return;
                if (currentSocket && currentSocket.readyState === 1) {
                    currentSocket.send(JSON.stringify({
                        type: 'codex-input',
                        text: val,
                        attachmentIds: readyImageAttachments.map(item => item.id),
                        ...(readyFileAttachments.length ? { fileAttachmentIds: readyFileAttachments.map(item => item.id) } : {}),
                        skills: selectedCodexSkill ? [{ name: selectedCodexSkill.name, path: selectedCodexSkill.path }] : []
                    }));
                    markComposerSendPending();
                }
                inputEl.value = '';
                inputEl.style.height = '38px';
                selectedImageAttachments = [];
                selectedFileAttachments = [];
                selectedCodexSkill = null;
                renderComposerAttachments();
                renderCodexChat();
                return;
            }
            if (val || readyFileAttachments.length) {
                if (readyFileAttachments.length) {
                    if (currentSocket && currentSocket.readyState === 1) {
                        currentSocket.send(JSON.stringify({
                            type: 'file-input',
                            text: val,
                            fileAttachmentIds: readyFileAttachments.map(item => item.id)
                        }));
                    }
                    inputEl.value = '';
                    inputEl.style.height = '38px';
                    selectedFileAttachments = [];
                    renderComposerAttachments();
                    return;
                }
                const formattedVal = val.replace(/\n/g, '\r');
                sendWS(formattedVal);
                inputEl.value = '';
                inputEl.style.height = '38px';
                restoreTerminalBottomSoon();
                setTimeout(() => { sendWS('\r'); }, 1000);
            }
        }
