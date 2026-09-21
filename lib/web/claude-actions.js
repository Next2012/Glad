function closeClaudeActionPanels(except = '') {
    const panels = {
        prompt: 'claude-prompt-panel',
        skill: 'claude-skill-panel',
        command: 'claude-command-panel'
    };
    for (const [name, id] of Object.entries(panels)) {
        if (name === except) continue;
        document.getElementById(id)?.classList.remove('active');
        if (name === 'prompt') claudePromptPanelOpen = false;
        if (name === 'skill') claudeSkillPanelOpen = false;
        if (name === 'command') claudeCommandPanelOpen = false;
    }
}

function prepareClaudeActionPanel(name) {
    closeClaudePicker();
    closeClaudeActionPanels(name);
    claudeResumePanelOpen = false;
    claudeForkPanelOpen = false;
    document.getElementById('claude-resume-panel')?.classList.remove('active');
    document.getElementById('claude-fork-panel')?.classList.remove('active');
}

function normalizeClaudeCommand(raw) {
    if (typeof raw === 'string') {
        const command = raw.startsWith('/') ? raw : `/${raw}`;
        return { name: command.slice(1), command, description: '' };
    }
    if (!raw || typeof raw !== 'object') return null;
    const value = String(raw.name || raw.command || raw.value || '').trim();
    if (!value) return null;
    const command = value.startsWith('/') ? value : `/${value}`;
    const source = String(raw.source || raw.type || raw.kind || '').toLowerCase();
    return {
        name: command.slice(1), command,
        description: String(raw.description || raw.help || raw.argumentHint || ''),
        skill: Boolean(raw.isSkill) || source.includes('skill') || source.includes('plugin')
    };
}

function claudeCommands() {
    const runtime = Array.isArray(claudeState.commands) ? claudeState.commands.map(normalizeClaudeCommand).filter(Boolean) : [];
    const builtins = [
        ['review', 'Review current changes'], ['security-review', 'Review changes for security issues'],
        ['plan', 'Enter plan mode'], ['rewind', 'Rewind to an earlier checkpoint'],
        ['doctor', 'Diagnose Claude configuration']
    ].map(([name, description]) => ({ name, command: `/${name}`, description, skill: false }));
    const byCommand = new Map([...runtime, ...builtins].map(item => [item.command, item]));
    return [...byCommand.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderClaudeActionList(items, emptyText, action) {
    if (!items.length) return `<div class="claude-resume-meta" style="padding:12px;">${escapeHtml(emptyText)}</div>`;
    return items.map((item, index) => `<button type="button" class="claude-resume-item" data-${action}="${index}"><div class="claude-resume-title"><span>${escapeHtml(item.command || item.name)}</span></div>${item.description ? `<div class="claude-resume-meta">${escapeHtml(item.description)}</div>` : ''}</button>`).join('');
}

function toggleClaudePromptPanel() {
    claudePromptPanelOpen = !claudePromptPanelOpen;
    prepareClaudeActionPanel(claudePromptPanelOpen ? 'prompt' : '');
    const panel = document.getElementById('claude-prompt-panel');
    panel.classList.toggle('active', claudePromptPanelOpen);
    if (claudePromptPanelOpen) {
        const prompts = claudeMessages.filter(item => item.kind === 'user' && String(item.text || '').trim())
            .slice(-30).reverse().map(item => ({ name: item.text, command: item.text, description: renderClaudePromptTime(item.createdAt) }));
        panel.innerHTML = renderClaudeActionList(prompts, 'No prompts in this conversation yet.', 'claude-prompt');
        panel.querySelectorAll('[data-claude-prompt]').forEach(button => button.addEventListener('click', () => {
            const prompt = prompts[Number(button.dataset.claudePrompt)]?.command || '';
            document.getElementById('cmd-input').value = prompt;
            document.getElementById('cmd-input').dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('cmd-input').focus();
            toggleClaudePromptPanel();
        }));
    }
    updateTerminalControlsHeight();
}

function renderClaudePromptTime(timestamp) {
    const date = new Date(Number(timestamp || 0));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function toggleClaudeSkillPanel() {
    claudeSkillPanelOpen = !claudeSkillPanelOpen;
    prepareClaudeActionPanel(claudeSkillPanelOpen ? 'skill' : '');
    const panel = document.getElementById('claude-skill-panel');
    panel.classList.toggle('active', claudeSkillPanelOpen);
    if (claudeSkillPanelOpen) {
        const skills = claudeCommands().filter(item => item.skill);
        panel.innerHTML = renderClaudeActionList(skills, 'Claude did not report any available skills.', 'claude-skill');
        panel.querySelectorAll('[data-claude-skill]').forEach(button => button.addEventListener('click', () => {
            selectedClaudeSkill = skills[Number(button.dataset.claudeSkill)] || null;
            toggleClaudeSkillPanel();
            renderComposerSkillPrefix();
            applyClaudeState({});
        }));
    }
    updateTerminalControlsHeight();
}

function clearClaudeSkillSelection() {
    selectedClaudeSkill = null;
    renderComposerSkillPrefix();
    applyClaudeState({});
}

function toggleClaudeCommandPanel() {
    claudeCommandPanelOpen = !claudeCommandPanelOpen;
    prepareClaudeActionPanel(claudeCommandPanelOpen ? 'command' : '');
    const panel = document.getElementById('claude-command-panel');
    panel.classList.toggle('active', claudeCommandPanelOpen);
    if (claudeCommandPanelOpen) {
        const commands = claudeCommands().filter(item => !item.skill);
        panel.innerHTML = renderClaudeActionList(commands, 'No commands available.', 'claude-command');
        panel.querySelectorAll('[data-claude-command]').forEach(button => button.addEventListener('click', () => {
            const command = commands[Number(button.dataset.claudeCommand)]?.command || '';
            const input = document.getElementById('cmd-input');
            input.value = `${command} `;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            toggleClaudeCommandPanel();
        }));
    }
    updateTerminalControlsHeight();
}
