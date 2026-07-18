        let currentGitTab = 'changes';
        let currentDirPath = '';

        function switchGitTab(tab) {
            currentGitTab = tab;
            document.getElementById('tab-changes').classList.toggle('active', tab === 'changes');
            document.getElementById('tab-directories').classList.toggle('active', tab === 'directories');
            document.getElementById('tab-graph').classList.toggle('active', tab === 'graph');
            if (tab === 'changes') {
                loadGitStatus();
            } else if (tab === 'directories') {
                loadDirectories(currentDirPath);
            } else if (tab === 'graph') {
                loadGitGraph();
            }
        }


        let currentCommitDiffHTML = '';
        let currentCommitHash = '';

        window.loadCommitDiff = async function(hash) {
            if (!activeSessionId) return;
            const content = document.getElementById('git-content');
            content.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Loading diff...</div>';
            currentCommitHash = hash;

            try {
                const res = await fetch(`/api/sessions/${activeSessionId}/git-show/${hash}`);
                const data = await res.json();
                if (data.success) {
                    let fileBlocks = [];
                    let currentBlock = { name: 'Commit Details', lines: [] };
                    fileBlocks.push(currentBlock);

                    const lines = data.stdout.split('\n');
                    for (const line of lines) {
                        const diffMatch = line.match(/^diff --git a\/(.+?) b\//);
                        if (diffMatch) {
                            currentBlock = { name: diffMatch[1], lines: [] };
                            fileBlocks.push(currentBlock);
                        }
                        currentBlock.lines.push(line);
                    }

                    let diffHTML = '';
                    for (const block of fileBlocks) {
                        if (block.lines.length === 0 || (block.lines.length === 1 && !block.lines[0])) continue;

                        let blockContent = '';
                        let addCount = 0;
                        let subCount = 0;
                        for (const line of block.lines) {
                            let color = '#ccc', bg = 'transparent', borderLeft = '2px solid transparent';
                            if (line.startsWith('+') && !line.startsWith('+++')) { color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.1)'; borderLeft = '2px solid #4ade80'; addCount++; }
                            else if (line.startsWith('-') && !line.startsWith('---')) { color = '#f87171'; bg = 'rgba(248, 113, 113, 0.1)'; borderLeft = '2px solid #f87171'; subCount++; }
                            else if (line.startsWith('@@')) { color = '#60a5fa'; bg = 'rgba(96, 165, 250, 0.1)'; }
                            else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('commit') || line.startsWith('Author') || line.startsWith('Date')) color = '#fff';

                            blockContent += `<div style="color:${color}; background:${bg}; border-left:${borderLeft}; padding:2px 8px; white-space:pre-wrap; word-break:break-all;">${line.replace(/</g, '&lt;').replace(/>/g, '&gt;') || ' '}</div>`;
                        }

                        const isOpen = block.name === 'Commit Details';
                        const statHTML = block.name !== 'Commit Details' ? `<span style="margin-left: 12px; font-family: monospace; font-size: 12px;"><span style="color:#4ade80;">+${addCount}</span> <span style="color:#f87171; margin-left:6px;">-${subCount}</span></span>` : '';
                        diffHTML += `
                            <details ${isOpen ? 'open' : ''} style="margin-bottom: 8px; border: 1px solid #333; border-radius: 4px; overflow: hidden;">
                                <summary style="background: #1e1e1e; padding: 6px 10px; cursor: pointer; color: #fff; font-weight: 500; font-size: 13px; outline: none; user-select: none;">
                                    ${block.name === 'Commit Details' ? '📝 ' : '📄 '}${block.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}${statHTML}
                                </summary>
                                <div style="background: #0d0d0d; overflow-x: auto; font-family: monospace; font-size: 12px; line-height: 1.5; padding: 4px 0;">
                                    ${blockContent}
                                </div>
                            </details>
                        `;
                    }
                    currentCommitDiffHTML = diffHTML;
                    renderCommitDiffFullView();
                } else {
                    content.innerHTML = `<p style="color:#ff3b30; padding:10px;">Error loading diff</p>`;
                }
            } catch (e) {
                content.innerHTML = `<p style="color:#ff3b30; padding:10px;">Network error</p>`;
            }
        };

        function renderCommitDiffFullView() {
            const content = document.getElementById('git-content');
            let html = `
            <div style="display:flex; align-items:center; background: var(--card-bg); padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.05); position: sticky; top: 0; z-index: 10;">
                <button class="icon-btn" onclick="switchGitTab('graph')" style="color: var(--primary); margin-right: 12px; font-weight:600; font-size:14px; display:flex; align-items:center;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg> Back
                </button>
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; font-size:15px; font-family: monospace;">Commit: ${currentCommitHash}</div>
                </div>
            </div>
            <div style="padding: 10px;">
                ${currentCommitDiffHTML}
            </div>`;
            content.innerHTML = html;
        }

        async function loadGitGraph() {

            if (!activeSessionId) return;
            const container = document.getElementById('git-content');
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Loading graph...</div>';
            try {
                const res = await fetch(`/api/sessions/${activeSessionId}/git-log`);
                const data = await res.json();
                if (data.success) {
                    const renderer = new GitGraphRenderer(container);
                    renderer.render(data.commits);
                } else {
                    container.innerHTML = `<div style="padding: 20px; color: #ff3b30;">Error: ${data.error}</div>`;
                }
            } catch (e) {
                container.innerHTML = `<div style="padding: 20px; color: #ff3b30;">Failed to load graph</div>`;
            }
        }

        async function loadDirectories(path = '') {
            currentDirPath = path;
            const content = document.getElementById('git-content');
            content.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">Loading...</p>';
            if (!activeSessionId) return;
            try {
                const res = await fetchWithTimeout(`/api/sessions/${activeSessionId}/fs/dir?path=${encodeURIComponent(path)}`);
                const data = await res.json();
                if (!data.success) throw new Error(data.error);

                let html = '<div>';
                if (path !== '') {
                    const parts = path.split('/');
                    parts.pop();
                    const parentPath = parts.join('/');
                    html += `<div class="list-item" onclick="loadDirectories(decodePathValue('${encodePathValue(parentPath)}'))">
                        <svg class="dir-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                        <div style="font-size:14px; font-weight:500;">..</div>
                    </div>`;
                }

                if (data.files.length === 0) {
                     html += '<p style="color:var(--text-dim); text-align:center; padding: 20px;">Empty directory</p>';
                } else {
                    data.files.forEach(f => {
                        const fullPath = path ? `${path}/${f.name}` : f.name;
                        const encodedPath = encodePathValue(fullPath);
                        const escapedName = escapeHtml(f.name);
                        let colorStyle = '';
                        let badgeHtml = '';
                        if (f.gitStatus) {
                             let color = '#fff';
                             let label = f.gitStatus.trim();
                             if (label.includes('U') || label.includes('?')) { colorStyle = 'color: #4ade80;'; color = '#4ade80'; if(label === '??') label = 'U'; }
                             else if (label.includes('M')) { colorStyle = 'color: #f59e0b;'; color = '#f59e0b'; }
                             else if (label.includes('D')) { colorStyle = 'color: #f87171;'; color = '#f87171'; }
                             badgeHtml = `<span style="color:${color}; font-weight:700; font-size:10px; border:1px solid ${color}; padding:1px 4px; border-radius:3px; opacity:0.7; margin-left: auto;">${label}</span>`;
                        }

                        if (f.isDirectory) {
                            html += `<div class="list-item" onclick="loadDirectories(decodePathValue('${encodedPath}'))">
                                <svg class="dir-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
                                <div style="font-size:14px; font-weight:500; ${colorStyle}">${escapedName}</div>
                                ${badgeHtml}
                            </div>`;
                        } else {
                            html += `<div class="list-item" onclick="showFileDetails(decodePathValue('${encodedPath}'), false)">
                                <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                                <div style="font-size:14px; font-weight:500; ${colorStyle}">${escapedName}</div>
                                ${badgeHtml}
                            </div>`;
                        }
                    });
                }
                html += '</div>';
                content.innerHTML = html;
            } catch (e) {
                content.innerHTML = `<p style="color:#ff3b30; padding:10px;">${e.message}</p>`;
            }
        }

        async function loadGitStatus() {
            const content = document.getElementById('git-content');
            content.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">Loading...</p>';
            if (!activeSessionId) return;
            try {
                const [resStatus, resUnstaged, resStaged] = await Promise.all([
                    fetchWithTimeout(`/api/sessions/${activeSessionId}/git-status`),
                    fetchWithTimeout(`/api/sessions/${activeSessionId}/git-diff-numstat?staged=false`).catch(() => ({ok:false})),
                    fetchWithTimeout(`/api/sessions/${activeSessionId}/git-diff-numstat?staged=true`).catch(() => ({ok:false}))
                ]);

                const data = await resStatus.json();
                if (!data.success) {
                    content.innerHTML = `<p style="color:#ff3b30; padding:10px;">Git error: ${data.error}</p>`;
                    return;
                }
                const files = Array.isArray(data.files) ? data.files : [];

                if (files.length === 0) {
                    content.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">No changes detected.</p>';
                    return;
                }

                let statsMap = {};
                const parseNumstat = (output) => {
                    if (!output) return;
                    output.split('\n').forEach(line => {
                        const parts = line.split('\t');
                        if (parts.length >= 3) {
                            const added = parseInt(parts[0]) || 0;
                            const removed = parseInt(parts[1]) || 0;
                            const file = parts.slice(2).join('\t');
                            if (!statsMap[file]) statsMap[file] = { added: 0, removed: 0 };
                            statsMap[file].added += added;
                            statsMap[file].removed += removed;
                        }
                    });
                };

                if (resUnstaged.ok) {
                    const unstagedData = await resUnstaged.json();
                    if (unstagedData.success) parseNumstat(unstagedData.stdout);
                }
                if (resStaged.ok) {
                    const stagedData = await resStaged.json();
                    if (stagedData.success) parseNumstat(stagedData.stdout);
                }

                let html = '<div style="padding:10px;">';
                files.forEach((f, idx) => {
                    const encodedPath = encodePathValue(f.path);
                    const escapedPath = escapeHtml(f.path);
                    let color = '#fff';
                    let label = f.status;
                    if (label.includes('M')) { color = '#f59e0b'; }
                    else if (label.includes('A') || label === '??') { color = '#4ade80'; if(label === '??') label = 'U'; }
                    else if (label.includes('D')) { color = '#f87171'; }
                    const isUntracked = f.status === '??';
                    const hasStaged = !isUntracked && f.status[0] && f.status[0] !== ' ';
                    const hasUnstaged = !isUntracked && f.status[1] && f.status[1] !== ' ';

                    let statHTML = '';
                    if (statsMap[f.path]) {
                        const { added, removed } = statsMap[f.path];
                        if (added > 0 || removed > 0) {
                            statHTML = `<span style="margin-left: 12px; font-family: monospace; font-size: 12px; white-space: nowrap;"><span style="color:#4ade80;">+${added}</span> <span style="color:#f87171; margin-left:6px;">-${removed}</span></span>`;
                        }
                    }

                    html += `<div style="margin-bottom: 8px; border: 1px solid #333; border-radius: 4px; background: #1e1e1e; overflow: hidden;">
                        <div onclick="toggleInlineDiff('${encodedPath}', 'inline-diff-${idx}', ${!!hasStaged}, ${!!hasUnstaged}, ${isUntracked})" style="padding: 6px 10px; cursor: pointer; color: #fff; font-weight: 500; font-size: 13px; outline: none; user-select: none; display: flex; align-items: center;">
                            <div style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">📄 ${escapedPath}${statHTML}</div>
                            <span style="color:${color}; font-weight:700; font-size:10px; border:1px solid ${color}; padding:1px 4px; border-radius:3px; opacity:0.8; flex-shrink: 0; margin-left: 8px;">${label}</span>
                        </div>
                        <div id="inline-diff-${idx}" style="display: none;" data-loaded="false"></div>
                    </div>`;
                });
                html += '</div>';
                content.innerHTML = html;
            } catch (e) {
                content.innerHTML = `<p style="color:#ff3b30; padding:10px;">${e.message}</p>`;
            }
        }

        function buildFileDiffUrl(path, staged) {
            return `/api/sessions/${activeSessionId}/git-diff-file?path=${encodeURIComponent(path)}&staged=${staged ? 'true' : 'false'}`;
        }

        async function loadFileChangeData(path, options = {}) {
            const hasStaged = !!options.hasStaged;
            const hasUnstaged = !!options.hasUnstaged;
            const isUntracked = !!options.isUntracked;
            const diffRequests = [];

            if (hasStaged) {
                diffRequests.push({
                    label: 'Staged changes',
                    promise: fetchWithTimeout(buildFileDiffUrl(path, true)).catch(() => ({ok:false}))
                });
            }
            if (hasUnstaged || (!hasStaged && !isUntracked)) {
                diffRequests.push({
                    label: 'Unstaged changes',
                    promise: fetchWithTimeout(buildFileDiffUrl(path, false)).catch(() => ({ok:false}))
                });
            }

            const [diffResponses, fileRes] = await Promise.all([
                Promise.all(diffRequests.map(item => item.promise)),
                fetchWithTimeout(`/api/sessions/${activeSessionId}/file?path=${encodeURIComponent(path)}`).catch(() => ({ok:false}))
            ]);

            const diffParts = [];
            for (let i = 0; i < diffResponses.length; i++) {
                const res = diffResponses[i];
                const data = res.ok ? await res.json() : { success: false };
                if (data.success && data.stdout) {
                    diffParts.push({ label: diffRequests[i].label, stdout: data.stdout });
                }
            }

            const fileData = fileRes.ok ? await fileRes.json() : { success: false };
            const content = fileData.success ? fileData.content : '';
            let diff = diffParts.map(part => (
                diffParts.length > 1 ? `# ${part.label}\n${part.stdout}` : part.stdout
            )).join('\n');
            if (!diff && isUntracked && content) diff = 'Untracked file:\n\n' + content;

            return {
                diff,
                content,
                renderRawDiff: diffParts.length > 1
            };
        }

        window.toggleInlineDiff = async function(encodedPath, containerId, hasStaged = false, hasUnstaged = true, isUntracked = false) {
            const container = document.getElementById(containerId);
            if (container.style.display === 'block') {
                container.style.display = 'none';
                return;
            }
            container.style.display = 'block';
            if (container.dataset.loaded === 'true') return;

            const path = decodePathValue(encodedPath);
            container.innerHTML = '<div style="padding: 10px; color: var(--text-dim); text-align: center; font-size: 12px;">Loading...</div>';

            try {
                const { diff: currentFileDiff, content: currentFileContent } = await loadFileChangeData(path, {
                    hasStaged,
                    hasUnstaged,
                    isUntracked
                });

                if (!currentFileDiff && !currentFileContent) {
                    container.innerHTML = `<div style="padding: 10px; color: #f87171; font-size: 12px; text-align:center;">No diff available</div>`;
                    return;
                }

                let blockContent = '';
                currentFileDiff.split('\n').forEach(line => {
                    let color = '#ccc', bg = 'transparent', borderLeft = '2px solid transparent';
                    if (line.startsWith('+') && !line.startsWith('+++')) { color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.1)'; borderLeft = '2px solid #4ade80'; }
                    else if (line.startsWith('-') && !line.startsWith('---')) { color = '#f87171'; bg = 'rgba(248, 113, 113, 0.1)'; borderLeft = '2px solid #f87171'; }
                    else if (line.startsWith('@@')) { color = '#60a5fa'; bg = 'rgba(96, 165, 250, 0.1)'; }

                    blockContent += `<div style="color:${color}; background:${bg}; border-left:${borderLeft}; padding:2px 8px; white-space:pre-wrap; word-break:break-all;">${escapeHtml(line) || ' '}</div>`;
                });

                container.dataset.loaded = 'true';
                container.innerHTML = `
                    <div style="background: #0d0d0d; overflow-x: auto; font-family: monospace; font-size: 12px; line-height: 1.5; padding: 4px 0; border-top: 1px solid #333; max-height: 400px;">
                        ${blockContent}
                    </div>
                    <div style="padding: 8px; background: #1a1a1a; border-top: 1px solid #333; text-align: center;">
                        <button onclick="showFileDetails(decodePathValue('${encodedPath}'), true, ${!!hasStaged}, ${!!hasUnstaged}, ${!!isUntracked})" style="background: var(--primary); border: none; color: #fff; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                            View Full File
                        </button>
                    </div>
                `;
            } catch (e) {
                container.innerHTML = `<div style="padding: 10px; color: #f87171; font-size: 12px; text-align:center;">Error: ${e.message}</div>`;
            }
        };

        let currentFilePath = '', currentFileDiff = '', currentFileContent = '', currentFileMode = 'diff', currentFileWrap = false, currentFontSize = 12, currentFileRenderRawDiff = false;

        function changeFontSize(delta) {
            if (delta === 0) currentFontSize = 12;
            else currentFontSize = Math.max(8, Math.min(32, currentFontSize + delta));
            renderFileDetails();
        }

        async function showFileDetails(path, isFromChanges = true, hasStaged = false, hasUnstaged = true, isUntracked = false) {
            currentFilePath = path;
            currentFileMode = isFromChanges ? 'diff' : 'file';
            currentFileRenderRawDiff = false;
            const content = document.getElementById('git-content');
            content.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">Loading details...</p>';
            try {
                const detailData = await loadFileChangeData(path, {
                    hasStaged: isFromChanges ? hasStaged : false,
                    hasUnstaged: isFromChanges ? hasUnstaged : true,
                    isUntracked: isFromChanges ? isUntracked : false
                });
                currentFileDiff = detailData.diff;
                currentFileContent = detailData.content;
                currentFileRenderRawDiff = detailData.renderRawDiff;
                if (!currentFileDiff && !currentFileContent) {
                     content.innerHTML = `<p style="color:#ff3b30; padding:10px;">Failed to load details.</p>`;
                     return;
                }
                if (!currentFileDiff && !isFromChanges) currentFileMode = 'file';
                renderFileDetails();
            } catch (e) { content.innerHTML = `<p style="color:#ff3b30; padding:10px;">${e.message}</p>`; }
        }

        function toggleFileMode() { currentFileMode = currentFileMode === 'diff' ? 'file' : 'diff'; renderFileDetails(); }
        function toggleFileWrap() { currentFileWrap = !currentFileWrap; renderFileDetails(); }

        function renderFileDetails() {
            const content = document.getElementById('git-content');
            let html = `
            <div style="display:flex; align-items:center; background: var(--card-bg); padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.05); position: sticky; top: 0; z-index: 10;">
                <button class="icon-btn" onclick="switchGitTab(currentGitTab)" style="color: var(--primary); margin-right: 12px; font-weight:600; font-size:14px; display:flex; align-items:center; flex-shrink: 0;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg> Back
                </button>
                <div style="flex:1; min-width:0; margin-right: 12px;">
                    <div style="font-weight:600; font-size:15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(currentFilePath)}">${escapeHtml(currentFilePath.split('/').pop() || currentFilePath)}</div>
                </div>`;

            if (currentFileDiff && currentFileContent) {
                html += `
                <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                    <div style="display: flex; gap: 2px; margin-right: 8px; background: rgba(0,0,0,0.3); padding: 2px; border-radius: 4px;">
                        <button onclick="changeFontSize(-1)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Zoom Out" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">A-</button>
                        <button onclick="changeFontSize(0)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Reset Size" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">${currentFontSize}</button>
                        <button onclick="changeFontSize(1)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Zoom In" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">A+</button>
                    </div>
                    <button onclick="toggleFileMode()" style="background: ${currentFileMode === 'diff' ? 'var(--primary)' : 'rgba(255,255,255,0.1)'}; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; outline: none;">
                        Diff
                    </button>
                    <button onclick="toggleFileWrap()" style="background: ${currentFileWrap ? 'var(--primary)' : 'rgba(255,255,255,0.1)'}; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; outline: none;">
                        Wrap
                    </button>
                </div>`;
            } else {
                 html += `
                <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                    <div style="display: flex; gap: 2px; margin-right: 8px; background: rgba(0,0,0,0.3); padding: 2px; border-radius: 4px;">
                        <button onclick="changeFontSize(-1)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Zoom Out" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">A-</button>
                        <button onclick="changeFontSize(0)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Reset Size" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">${currentFontSize}</button>
                        <button onclick="changeFontSize(1)" style="background: transparent; border: none; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; outline: none; border-radius: 3px;" title="Zoom In" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff'" onmouseout="this.style.background='transparent';this.style.color='#aaa'">A+</button>
                    </div>
                    <button onclick="toggleFileWrap()" style="background: ${currentFileWrap ? 'var(--primary)' : 'rgba(255,255,255,0.1)'}; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; outline: none;">
                        Wrap
                    </button>
                </div>`;
            }

            html += `</div>`;

            const wrapStyle = currentFileWrap ? 'white-space: pre-wrap; word-break: break-all;' : 'white-space: pre;';
            const innerWrapStyle = currentFileWrap ? '' : 'min-width: max-content;';
            html += `<div style="padding: 10px;">`;
            html += `<div style="background:#0d0d0d; border-radius:8px; overflow-x:auto; font-family:monospace; font-size:${currentFontSize}px; line-height:1.5; padding: 12px 0; margin: 0; -webkit-text-size-adjust: 100%; text-size-adjust: 100%;">`;
            html += `<div style="${innerWrapStyle}">`;

            let mergedLines = [];
            const lines = currentFileContent ? currentFileContent.replace(/\r\n/g, '\n').split('\n') : [];

            if (currentFileMode === 'diff' && currentFileDiff && !currentFileDiff.startsWith('Untracked file:')) {
                let diffHunks = [];
                let currentHunk = null;
                const diffLines = currentFileDiff.replace(/\r\n/g, '\n').split('\n');
                for (const dl of diffLines) {
                    if (dl.startsWith('---') || dl.startsWith('+++')) continue;
                    let match = dl.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                    if (match) {
                        currentHunk = {
                            newStart: parseInt(match[2], 10),
                            lines: []
                        };
                        diffHunks.push(currentHunk);
                    } else if (currentHunk) {
                        currentHunk.lines.push(dl);
                    }
                }

                if (currentFileRenderRawDiff || diffHunks.length === 0) {
                    currentFileDiff.replace(/\r\n/g, '\n').split('\n').forEach(line => {
                        mergedLines.push({ type: 'raw', text: line });
                    });
                } else {
                    let contentLineIdx = 1;
                    for (let hunk of diffHunks) {
                        while (contentLineIdx < hunk.newStart && contentLineIdx <= lines.length) {
                            mergedLines.push({ type: 'normal', text: lines[contentLineIdx - 1], lineNum: contentLineIdx });
                            contentLineIdx++;
                        }
                        for (let dl of hunk.lines) {
                            if (dl.startsWith('-')) {
                                mergedLines.push({ type: 'deleted', text: dl.substring(1) });
                            } else if (dl.startsWith('+')) {
                                mergedLines.push({ type: 'added', text: dl.substring(1), lineNum: contentLineIdx });
                                contentLineIdx++;
                            } else if (dl.startsWith(' ')) {
                                mergedLines.push({ type: 'normal', text: dl.substring(1), lineNum: contentLineIdx });
                                contentLineIdx++;
                            }
                        }
                    }
                    while (contentLineIdx <= lines.length) {
                        mergedLines.push({ type: 'normal', text: lines[contentLineIdx - 1], lineNum: contentLineIdx });
                        contentLineIdx++;
                    }
                }
            } else {
                lines.forEach((line, idx) => {
                    mergedLines.push({ type: 'normal', text: line, lineNum: idx + 1 });
                });
            }

            mergedLines.forEach(item => {
                let color = '#ccc', bg = 'transparent', borderLeft = '2px solid transparent';
                let prefix = ' ';
                if (item.type === 'added') { color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.1)'; borderLeft = '2px solid #4ade80'; prefix = '+'; }
                else if (item.type === 'deleted') { color = '#f87171'; bg = 'rgba(248, 113, 113, 0.1)'; borderLeft = '2px solid #f87171'; prefix = '-'; }
                else if (item.type === 'raw') {
                    if (item.text.startsWith('+') && !item.text.startsWith('+++')) { color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.1)'; borderLeft = '2px solid #4ade80'; }
                    else if (item.text.startsWith('-') && !item.text.startsWith('---')) { color = '#f87171'; bg = 'rgba(248, 113, 113, 0.1)'; borderLeft = '2px solid #f87171'; }
                    else if (item.text.startsWith('@@')) { color = '#60a5fa'; bg = 'rgba(96, 165, 250, 0.1)'; }
                    prefix = '';
                }

                const renderedText = item.type === 'raw' ? item.text : `${prefix} ${item.text}`;
                html += `<div style="color:${color}; background:${bg}; border-left:${borderLeft}; padding: 0 12px 0 8px; display:flex;">`;
                html += `<div style="color:#555; margin-right:16px; user-select:none; flex-shrink:0; width: 36px; text-align:right;">${item.lineNum || ''}</div>`;
                html += `<div style="flex:1; min-width:0; ${wrapStyle}">${escapeHtml(renderedText) || ' '}</div>`;
                html += `</div>`;
            });

            html += `</div></div></div>`;
            content.innerHTML = html;
        }

        document.addEventListener('DOMContentLoaded', () => {
            refreshSessionsNow();
            document.addEventListener('visibilitychange', refreshSessionsNow);
        });
