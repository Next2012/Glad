// 桌面保留左右栏，手机显示设置列表和可返回的详情页面。
function selectSettingsPage(page) {
    const modal = document.getElementById('settings-modal');
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    if (!mobile && !page) page = 'appearance';
    modal.dataset.page = page || '';
    document.querySelectorAll('[data-settings-page]').forEach(section => {
        section.hidden = section.dataset.settingsPage !== page;
    });
    document.querySelectorAll('[data-settings-nav]').forEach(button => {
        const active = button.dataset.settingsNav === page;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('settings-modal-title').textContent = mobile && page
        ? {appearance:'Appearance',serverchan:'ServerChan',skillhub:'SkillHub',agentworkbench:'AgentWorkbench'}[page]
        : 'Settings';
    document.querySelector('.settings-content').scrollTop = 0;
}

window.matchMedia('(max-width: 720px)').addEventListener('change', () => {
    selectSettingsPage(window.matchMedia('(max-width: 720px)').matches ? null : 'appearance');
});
