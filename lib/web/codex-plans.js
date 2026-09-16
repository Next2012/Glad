        function codexPlanPhase(item) {
            if (item.planTurnStatus === 'cancelled') return 'stopped';
            if (item.planTurnStatus === 'failed') return 'failed';
            const steps = Array.isArray(item.plan) ? item.plan : [];
            if (steps.length && steps.every(step => step.status === 'completed')) return 'completed';
            return item.planTurnStatus === 'running' ? 'running' : 'ended';
        }
        function renderCodexPlan(item, floating = false, initiallyOpen = false) {
            const steps = Array.isArray(item.plan) ? item.plan : [];
            if (!steps.length) return '';
            const phase = codexPlanPhase(item);
            const completed = steps.filter(step => step.status === 'completed').length;
            const current = steps.find(step => step.status === 'inProgress');
            const labels = { running: 'Tasks', completed: 'Completed', stopped: 'Stopped', failed: 'Failed', ended: 'Turn ended' };
            const statuses = { completed: 'Completed', inProgress: 'In progress', pending: 'Pending' };
            const active = phase === 'running';
            const statusText = `${labels[phase]} · ${completed}/${steps.length}`;
            const icon = phase === 'completed' ? '✓' : phase === 'failed' ? '!' : active ? '' : '−';
            return `<details class="codex-plan-card${floating ? ' floating' : ' codex-plan-history'}" data-codex-key="plan-${floating ? 'floating-' : ''}${escapeHtml(item.id)}" data-plan-phase="${phase}"${initiallyOpen && active ? ' open' : ''}>
                <summary class="codex-plan-summary" title="${escapeHtml(statusText + (active && current ? ` · ${current.step}` : ''))}"><span class="codex-plan-icon${active ? ' spinning' : ''}" aria-hidden="true">${icon}</span><span class="codex-plan-label">${labels[phase]}</span><span class="codex-plan-count">${completed}/${steps.length}</span><span class="codex-plan-current">${escapeHtml(active && current ? current.step : '')}</span><span class="codex-plan-chevron" aria-hidden="true">⌄</span></summary>
                <div class="codex-plan-body">${item.explanation ? `<p class="codex-plan-explanation">${escapeHtml(item.explanation)}</p>` : ''}<ol class="codex-plan-steps">${steps.map(step => `<li class="codex-plan-step ${step.status === 'completed' ? 'completed' : step.status === 'inProgress' ? 'current' : 'pending'}"><span class="codex-plan-step-icon${active && step.status === 'inProgress' ? ' spinning' : ''}" aria-label="${escapeHtml(statuses[step.status] || 'Pending')}">${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? active ? '' : '◉' : '○'}</span><span>${escapeHtml(step.step)}</span></li>`).join('')}</ol></div>
            </details>`;
        }
        function codexPlanLayout(messages, rootThreadId) {
            const rootMessages = messages.filter(item => !isCodexSubagentItem(item, rootThreadId));
            const latestTurn = rootMessages.findLast(item => item.kind === 'turn-start');
            const latestPlan = rootMessages.findLast(item => item.kind === 'task-plan'
                && (!latestTurn || item.turnId === latestTurn.turnId));
            const floatingPlan = latestPlan?.plan?.length && latestPlan.planTurnStatus === 'running' ? latestPlan : null;
            const firstUserByTurn = new Map();
            const firstReplyByTurn = new Map();
            let pendingUser = null;
            for (const item of rootMessages) {
                if (item.kind === 'user') {
                    if (item.turnId) {
                        if (!firstUserByTurn.has(item.turnId)) firstUserByTurn.set(item.turnId, item);
                    } else pendingUser = item;
                } else if (item.kind === 'turn-start') {
                    // Local input precedes turn/start and may not have received
                    // its Codex userMessage echo (and turn id) yet.
                    if (pendingUser && !firstUserByTurn.has(item.turnId)) firstUserByTurn.set(item.turnId, pendingUser);
                    pendingUser = null;
                } else if (item.kind === 'turn-end') pendingUser = null;
                else if (item.kind === 'assistant' && !firstReplyByTurn.has(item.turnId)) firstReplyByTurn.set(item.turnId, item);
            }
            const plansAfterUser = new Map();
            const plansBeforeReply = new Map();
            const placedPlans = new Set();
            for (const plan of rootMessages) {
                if (plan.kind !== 'task-plan' || !plan.plan?.length || plan.planTurnStatus === 'running') continue;
                const user = firstUserByTurn.get(plan.turnId);
                const reply = firstReplyByTurn.get(plan.turnId);
                if (user) plansAfterUser.set(user, plan);
                else if (reply) plansBeforeReply.set(reply, plan);
                else continue;
                placedPlans.add(plan);
            }
            return { floatingPlan, plansAfterUser, plansBeforeReply, placedPlans };
        }
