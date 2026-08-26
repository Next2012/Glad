        const inputEl = document.getElementById('cmd-input');
        const imageFileInput = document.getElementById('image-file-input');
        const attachmentStrip = document.getElementById('attachment-strip');
        let selectedImageAttachments = [];
        let keepTerminalBottomForNextInput = false;

        function isStructuredImageAttachmentAvailable() {
            return isClaudeSession() || (isCodexSession() && codexState.presentation === 'structured');
        }

        function syncComposerButtonState() {
            const menuOpen = document.getElementById('composer-menu').classList.contains('active');
            const timerOpen = document.getElementById('timed-send-panel').classList.contains('active');
            document.getElementById('timer-btn').classList.toggle('active', menuOpen || timerOpen);
        }

        function renderImageAttachments() {
            attachmentStrip.innerHTML = selectedImageAttachments.map(item => (
                `<div class="attachment-chip${item.uploading ? ' uploading' : ''}"><span aria-hidden="true">▧</span><span class="attachment-chip-content"><span class="attachment-chip-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${item.uploading ? `<span class="attachment-progress${item.progressKnown ? '' : ' estimated'}"><span style="width:${Math.max(0, Math.min(100, item.progress || 0))}%"></span></span><span class="attachment-status">${escapeHtml(item.status || (item.progressKnown ? `Uploading ${Math.round(item.progress || 0)}%` : 'Uploading original image…'))}</span>` : ''}</span><button class="attachment-remove" type="button" title="Remove image" aria-label="Remove ${escapeHtml(item.name)}" onclick="removeImageAttachment('${item.id}')">×</button></div>`
            )).join('');
            attachmentStrip.classList.toggle('active', selectedImageAttachments.length > 0);
            updateTerminalControlsHeight();
        }

        window.removeImageAttachment = async function(attachmentId) {
            const attachment = selectedImageAttachments.find(item => item.id === attachmentId);
            selectedImageAttachments = selectedImageAttachments.filter(item => item.id !== attachmentId);
            renderImageAttachments();
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

        async function clearImageAttachments() {
            const pending = selectedImageAttachments;
            selectedImageAttachments = [];
            renderImageAttachments();
            for (const item of pending) item.abortUpload?.();
            await Promise.all(pending.filter(item => !item.uploading).map(item => fetchWithTimeout(
                `/api/sessions/${item.sessionId}/attachments/images/${encodeURIComponent(item.id)}`,
                { method: 'DELETE' }
            ).catch(() => null)));
        }

        const IMAGE_UPLOAD_CHUNK_BYTES = 512 * 1024;

        function uploadImageInChunks(sessionId, file, onProgress) {
            let xhr = null;
            let cancelled = false;
            const uploadId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const chunkTotal = Math.ceil(file.size / IMAGE_UPLOAD_CHUNK_BYTES);
            return {
                abort: () => {
                    cancelled = true;
                    xhr?.abort();
                    void fetch(`/api/sessions/${sessionId}/attachments/images/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => null);
                },
                promise: (async () => {
                    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
                        if (cancelled) throw new Error('Image upload cancelled');
                        const start = chunkIndex * IMAGE_UPLOAD_CHUNK_BYTES;
                        const chunk = file.slice(start, Math.min(file.size, start + IMAGE_UPLOAD_CHUNK_BYTES));
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
                const chunkTotal = Math.ceil(file.size / IMAGE_UPLOAD_CHUNK_BYTES);
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
                renderImageAttachments();
                try {
                    const upload = uploadImageInChunks(activeSessionId, file, progress => {
                        pending.progress = progress;
                        pending.status = `${progress}%`;
                        renderImageAttachments();
                    });
                    pending.abortUpload = upload.abort;
                    const attachment = await upload.promise;
                    const index = selectedImageAttachments.indexOf(pending);
                    if (index < 0) {
                        await fetchWithTimeout(`/api/sessions/${activeSessionId}/attachments/images/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
                        continue;
                    }
                    selectedImageAttachments[index] = { ...attachment, name: file.name || attachment.name, sessionId: activeSessionId };
                    renderImageAttachments();
                } catch (e) {
                    selectedImageAttachments = selectedImageAttachments.filter(item => item !== pending);
                    renderImageAttachments();
                    if (e.message === 'Image upload cancelled') continue;
                    alert(`Could not add ${file.name}: ${e.message}`);
                }
            }
        }

        function closeComposerMenu() {
            document.getElementById('composer-menu').classList.remove('active');
            syncComposerButtonState();
            updateTerminalControlsHeight();
        }

        function openTimedSendPanel() {
            closeComposerMenu();
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
            const val = inputEl.value;
            const readyImageAttachments = selectedImageAttachments.filter(item => !item.uploading);
            if (selectedImageAttachments.some(item => item.uploading)) {
                alert('Wait for image uploads to finish before sending.');
                return;
            }
            if ((val || readyImageAttachments.length) && isClaudeSession()) {
                if (currentSocket && currentSocket.readyState === 1) {
                    currentSocket.send(JSON.stringify({
                        type: 'claude-input',
                        text: val,
                        attachmentIds: readyImageAttachments.map(item => item.id)
                    }));
                }
                inputEl.value = '';
                inputEl.style.height = '38px';
                selectedImageAttachments = [];
                renderImageAttachments();
                return;
            }
            if ((val || readyImageAttachments.length) && isCodexSession() && codexState.presentation === 'structured') {
                if (!codexReadyForInput()) return;
                if (currentSocket && currentSocket.readyState === 1) {
                    currentSocket.send(JSON.stringify({
                        type: 'codex-input',
                        text: val,
                        attachmentIds: readyImageAttachments.map(item => item.id),
                        skills: selectedCodexSkill ? [{ name: selectedCodexSkill.name, path: selectedCodexSkill.path }] : []
                    }));
                }
                inputEl.value = '';
                inputEl.style.height = '38px';
                selectedImageAttachments = [];
                selectedCodexSkill = null;
                renderImageAttachments();
                renderCodexChat();
                return;
            }
            if (val) {
                const formattedVal = val.replace(/\n/g, '\r');
                sendWS(formattedVal);
                inputEl.value = '';
                inputEl.style.height = '38px';
                restoreTerminalBottomSoon();
                setTimeout(() => { sendWS('\r'); }, 1000);
            }
        }
