// Background views keep their transport and reducers, but defer expensive DOM
// work until their conversation is actually on screen.
(() => {
    const pending = new Map();
    function visible() {
        if (document.hidden) return false;
        if (window.gladTabs?.isHosted()) return window.gladTabs.visible(window.gladTabs.ownKind, window.gladTabs.ownId);
        return Boolean(document.querySelector('#terminal-view.active, #room-view.active'));
    }
    function flush() {
        if (!visible()) return;
        const work = [...pending.values()]; pending.clear();
        for (const render of work) render();
        document.dispatchEvent(new Event('glad:view-visible'));
    }
    function defer(key, render) {
        if (visible()) { pending.delete(key); return false; }
        pending.set(key, render); return true;
    }
    window.gladPresentation = Object.freeze({ visible, defer, flush });
    const observer = new MutationObserver(() => {
        if (visible()) {
            flush();
            for (const [id, revision] of pendingCompletionRevisions) {
                if (isSessionCompletionVisible(id)) void markCompletionRead(id, revision);
            }
            window.gladTabView?.report();
        }
    });
    for (const id of ['terminal-view', 'room-view']) observer.observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', flush);
})();
