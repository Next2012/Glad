(() => {
    if (!document.documentElement.classList.contains('glad-embed')) return;
    const id = new URLSearchParams(window.location.search).get('embedSession');
    document.addEventListener('DOMContentLoaded', async () => {
        if (!id) return;
        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/metadata`);
            if (!response.ok) throw new Error('Conversation is unavailable');
            const session = await response.json();
            joinSession(session.id, session.name, session.toolKey);
        } catch (error) {
            const empty = document.getElementById('detail-empty');
            empty.textContent = error.message;
            empty.style.display = 'flex';
        }
    });
})();
