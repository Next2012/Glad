function formatAgentTokens(value) {
    const count = Number(value || 0);
    return count >= 1000000 ? `${(count / 1000000).toFixed(1)}M`
        : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
}

function renderAgentContextMeter(context) {
    const total = Number(context?.contextWindow || context?.maxTokens || 0);
    const remaining = Number(context?.remainingTokens || 0);
    if (!(total > 0) || !Number.isFinite(remaining)) return '';
    const reportedPercent = Number(context.remainingPercent ?? Math.round(remaining / total * 100));
    const percent = Math.max(0, Math.min(100, Number.isFinite(reportedPercent) ? reportedPercent : 0));
    const level = percent <= 20 ? ' danger' : percent <= 40 ? ' warn' : '';
    const label = `${formatAgentTokens(remaining)} / ${formatAgentTokens(total)}（${Math.round(percent)}%）`;
    return `<span class="codex-context-meter${level}" style="--context-remaining:${percent}%" title="${escapeHtml(`Context remaining: ${label}`)}" aria-label="${escapeHtml(`Context remaining: ${label}`)}">${escapeHtml(label)}</span>`;
}
