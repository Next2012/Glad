class GitGraphRenderer {
    constructor(container) {
        this.container = container;
        this.colors = ['#ff5252', '#448aff', '#69f0ae', '#ffd740', '#e040fb', '#ffab40', '#18ffff'];
        this.rowHeight = 36;
        this.dotRadius = 5;
        this.lineWidth = 2.5;
    }

    render(commits) {
        this.container.innerHTML = '';
        if (!commits || commits.length === 0) {
            this.container.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No commits found.</div>';
            return;
        }

        let tracks = [];
        
        for (const commit of commits) {
            const hash = commit.hash;
            const parents = commit.parents;
            
            let col = tracks.indexOf(hash);
            let isNewTrack = false;
            if (col === -1) {
                col = tracks.findIndex(t => t === null);
                if (col === -1) col = tracks.length;
                tracks[col] = hash;
                isNewTrack = true;
            }
            
            commit.col = col;
            commit.tracksBefore = [...tracks];
            if (isNewTrack) {
                commit.tracksBefore[col] = null;
            }

            if (parents.length > 0) {
                tracks[col] = parents[0];
                for (let i = 1; i < parents.length; i++) {
                    const p = parents[i];
                    let pCol = tracks.indexOf(p);
                    if (pCol === -1) {
                        let eCol = tracks.findIndex(t => t === null);
                        if (eCol === -1) eCol = tracks.length;
                        tracks[eCol] = p;
                    }
                }
            } else {
                tracks[col] = null;
            }

            for (let i = 0; i < tracks.length; i++) {
                for (let j = i + 1; j < tracks.length; j++) {
                    if (tracks[i] && tracks[i] === tracks[j]) {
                        tracks[j] = null;
                    }
                }
            }

            while (tracks.length > 0 && tracks[tracks.length - 1] === null) {
                tracks.pop();
            }
            
            commit.tracksAfter = [...tracks];
        }

        const maxTracks = Math.max(...commits.map(c => Math.max(c.tracksBefore.length, c.tracksAfter.length)));
        const canvasWidth = Math.max(50, maxTracks * 16 + 24);

        commits.forEach((commit, rowIndex) => {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'gitgraph-row';
            rowDiv.style.display = 'flex';
            rowDiv.style.alignItems = 'center';
            rowDiv.style.height = this.rowHeight + 'px';
            rowDiv.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            rowDiv.style.position = 'relative';
            rowDiv.style.cursor = 'pointer';
            rowDiv.onmouseover = () => rowDiv.style.backgroundColor = 'rgba(255,255,255,0.05)';
            rowDiv.onmouseout = () => rowDiv.style.backgroundColor = 'transparent';

            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth * 2; // HiDPI
            canvas.height = this.rowHeight * 2;
            canvas.style.flexShrink = '0';
            canvas.style.width = canvasWidth + 'px';
            canvas.style.height = this.rowHeight + 'px';
            rowDiv.appendChild(canvas);

            this.drawCanvas(canvas, commit);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'gitgraph-content';
            contentDiv.style.flex = '1';
            contentDiv.style.minWidth = '0';
            contentDiv.style.display = 'flex';
            contentDiv.style.alignItems = 'center';
            contentDiv.style.gap = '8px';
            contentDiv.style.paddingRight = '14px';
            contentDiv.style.whiteSpace = 'nowrap';
            contentDiv.style.overflow = 'hidden';

            const msgSpan = document.createElement('span');
            msgSpan.style.color = '#fff';
            msgSpan.style.fontSize = '13px';
            msgSpan.style.fontWeight = '500';
            msgSpan.style.overflow = 'hidden';
            msgSpan.style.textOverflow = 'ellipsis';
            msgSpan.textContent = commit.subject;
            contentDiv.appendChild(msgSpan);

            if (commit.refs) {
                const refsSpan = document.createElement('span');
                refsSpan.style.color = 'var(--primary)';
                refsSpan.style.fontSize = '11px';
                refsSpan.style.border = '1px solid rgba(0, 122, 255, 0.4)';
                refsSpan.style.background = 'rgba(0, 122, 255, 0.1)';
                refsSpan.style.borderRadius = '4px';
                refsSpan.style.padding = '1px 4px';
                refsSpan.style.flexShrink = '0';
                refsSpan.textContent = commit.refs.replace(/[()]/g, '').trim();
                contentDiv.appendChild(refsSpan);
            }

            const authorSpan = document.createElement('span');
            authorSpan.style.color = 'var(--text-dim)';
            authorSpan.style.fontSize = '12px';
            authorSpan.style.marginLeft = 'auto';
            authorSpan.style.flexShrink = '0';
            authorSpan.textContent = `${commit.author} • ${commit.time}`;
            contentDiv.appendChild(authorSpan);

            const hashSpan = document.createElement('span');
            hashSpan.style.color = 'var(--text-dim)';
            hashSpan.style.fontSize = '12px';
            hashSpan.style.fontFamily = 'monospace';
            hashSpan.style.flexShrink = '0';
            hashSpan.style.width = '60px';
            hashSpan.style.textAlign = 'right';
            hashSpan.textContent = commit.hash;
            contentDiv.appendChild(hashSpan);

            
            rowDiv.onclick = (e) => {
                if (e.target.closest('.gitgraph-details-view')) return;
                
                const existingDetails = rowDiv.nextElementSibling;
                if (existingDetails && existingDetails.classList.contains('gitgraph-details-view')) {
                    existingDetails.remove();
                    rowDiv.style.backgroundColor = 'transparent';
                    return;
                }
                
                // Close others
                document.querySelectorAll('.gitgraph-details-view').forEach(el => {
                    if (el.previousElementSibling) {
                        el.previousElementSibling.style.backgroundColor = 'transparent';
                    }
                    el.remove();
                });
                
                rowDiv.style.backgroundColor = 'rgba(255,255,255,0.05)';
                
                const detailsDiv = document.createElement('div');
                detailsDiv.className = 'gitgraph-details-view';
                detailsDiv.style.backgroundColor = '#121212';
                detailsDiv.style.borderLeft = '2px solid ' + this.getColor(commit.col);
                detailsDiv.style.padding = '16px';
                detailsDiv.style.margin = '4px 0 4px ' + (canvasWidth) + 'px';
                detailsDiv.style.borderRadius = '0 6px 6px 0';
                detailsDiv.style.fontSize = '13px';
                detailsDiv.style.color = 'var(--text)';
                detailsDiv.style.boxShadow = 'inset 0 0 10px rgba(0,0,0,0.5)';
                
                let detailsHTML = `
                    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                        <div>
                            <div style="font-weight:600; font-size:14px; margin-bottom:4px;">${commit.subject.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
                            <div style="color:var(--text-dim);">${commit.author} commited ${commit.time}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-family:monospace; color:var(--text-dim);">Commit: ${commit.hash}</div>
                            ${commit.parents.length > 0 ? `<div style="font-family:monospace; color:var(--text-dim);">Parents: ${commit.parents.join(', ')}</div>` : ''}
                        </div>
                    </div>
                `;
                
                // Add diff placeholder
                detailsHTML += `
                    <div style="border-top:1px solid #333; padding-top:12px; margin-top:12px;">
                        <button onclick="window.loadCommitDiff('${commit.hash}', this)" style="background:var(--primary); border:none; color:#fff; padding:6px 12px; border-radius:4px; font-size:12px; cursor:pointer;">Load Diff</button>
                        <div class="diff-container" style="margin-top:12px; font-family:monospace; font-size:12px; white-space:pre-wrap; overflow-x:auto;"></div>
                    </div>
                `;

                detailsDiv.innerHTML = detailsHTML;
                rowDiv.parentNode.insertBefore(detailsDiv, rowDiv.nextSibling);
            };
            
            rowDiv.appendChild(contentDiv);

            this.container.appendChild(rowDiv);
        });
    }

    drawCanvas(canvas, commit) {
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2); // HiDPI
        
        const h = this.rowHeight;
        const w = canvas.width / 2;
        const midY = h / 2;
        const colSpacing = 16;
        const startX = 20;

        // Pass-through lines
        commit.tracksBefore.forEach((target, i) => {
            if (!target) return;
            const x1 = startX + i * colSpacing;
            
            if (target === commit.hash) {
                const x2 = startX + commit.col * colSpacing;
                this.drawLine(ctx, x1, 0, x2, midY, this.getColor(i));
            } else {
                const nextIdx = commit.tracksAfter.indexOf(target);
                if (nextIdx !== -1) {
                    const x2 = startX + nextIdx * colSpacing;
                    this.drawLine(ctx, x1, 0, x2, h, this.getColor(i));
                }
            }
        });

        // Lines for parents
        commit.parents.forEach((parent, parentIdx) => {
            const nextIdx = commit.tracksAfter.indexOf(parent);
            if (nextIdx !== -1) {
                const x1 = startX + commit.col * colSpacing;
                const x2 = startX + nextIdx * colSpacing;
                const color = parentIdx === 0 ? this.getColor(commit.col) : this.getColor(nextIdx);
                this.drawLine(ctx, x1, midY, x2, h, color);
            }
        });

        // Commit dot
        const cx = startX + commit.col * colSpacing;
        ctx.beginPath();
        ctx.arc(cx, midY, this.dotRadius, 0, 2 * Math.PI);
        ctx.fillStyle = this.getColor(commit.col);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#121212'; // dark background match
        ctx.stroke();
    }

    drawLine(ctx, x1, y1, x2, y2, color) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (x1 === x2) {
            ctx.lineTo(x2, y2);
        } else {
            ctx.bezierCurveTo(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, x2, y2);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = this.lineWidth;
        ctx.stroke();
    }

    getColor(index) {
        return this.colors[index % this.colors.length];
    }
}
window.GitGraphRenderer = GitGraphRenderer;
