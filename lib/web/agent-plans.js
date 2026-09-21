function agentPlanPhase(item) {
    if (item.planTurnStatus === 'cancelled') return 'stopped';
    if (item.planTurnStatus === 'failed') return 'failed';
    const steps = Array.isArray(item.plan) ? item.plan : [];
    if (steps.length && steps.every(step => step.status === 'completed')) return 'completed';
    return item.planTurnStatus === 'running' ? 'running' : 'ended';
}

function renderAgentPlan(item, { floating = false, initiallyOpen = false, label = 'Tasks', keyPrefix = 'plan' } = {}) {
    const steps = Array.isArray(item.plan) ? item.plan : [];
    if (!steps.length) return '';
    const phase = agentPlanPhase(item);
    const completed = steps.filter(step => step.status === 'completed').length;
    const current = steps.find(step => step.status === 'inProgress');
    const labels = { running: label, completed: 'Completed', stopped: 'Stopped', failed: 'Failed', ended: 'Turn ended' };
    const statuses = { completed: 'Completed', inProgress: 'In progress', pending: 'Pending' };
    const active = phase === 'running';
    const statusText = `${labels[phase]} · ${completed}/${steps.length}`;
    const icon = phase === 'completed' ? '✓' : phase === 'failed' ? '!' : active ? '' : '−';
    const details = steps.map(step => {
        const state = step.status === 'completed' ? 'completed' : step.status === 'inProgress' ? 'current' : 'pending';
        const blocked = Array.isArray(step.blockedBy) && step.blockedBy.length
            ? `<small class="agent-task-blocked">Blocked by ${escapeHtml(step.blockedBy.join(', '))}</small>` : '';
        const text = active && step.status === 'inProgress' && step.activeForm ? step.activeForm : step.step;
        return `<li class="codex-plan-step ${state}"><span class="codex-plan-step-icon${active && step.status === 'inProgress' ? ' spinning' : ''}" aria-label="${escapeHtml(statuses[step.status] || 'Pending')}">${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? active ? '' : '◉' : '○'}</span><span>${escapeHtml(text || 'Task')}${blocked}</span></li>`;
    }).join('');
    return `<details class="codex-plan-card agent-task-card${floating ? ' floating' : ' codex-plan-history'}" data-codex-key="${escapeHtml(keyPrefix)}-${floating ? 'floating-' : ''}${escapeHtml(item.id)}" data-plan-phase="${phase}"${initiallyOpen && active ? ' open' : ''}>
        <summary class="codex-plan-summary" title="${escapeHtml(statusText + (active && current ? ` · ${current.activeForm || current.step}` : ''))}"><span class="codex-plan-icon${active ? ' spinning' : ''}" aria-hidden="true">${icon}</span><span class="codex-plan-label">${labels[phase]}</span><span class="codex-plan-count">${completed}/${steps.length}</span><span class="codex-plan-current">${escapeHtml(active && current ? current.activeForm || current.step : '')}</span><span class="codex-plan-chevron" aria-hidden="true">⌄</span></summary>
        <div class="codex-plan-body">${item.explanation ? `<p class="codex-plan-explanation">${escapeHtml(item.explanation)}</p>` : ''}<ol class="codex-plan-steps">${details}</ol></div>
    </details>`;
}
