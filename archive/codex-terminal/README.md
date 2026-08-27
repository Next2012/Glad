# Archived Codex terminal presentation

Glad previously allowed a running Codex structured session to switch from the
app-server chat presentation into a resumed Codex terminal (PTY), then switch
back after the terminal became idle. The active runtime path was removed to
keep Codex on one reliable structured-chat transport.

The last complete implementation is preserved in Git commit `0622c2b`.
Nothing in this archive is included in the npm package or loaded at runtime.

## Restore map

- `lib/codex/structured-session.js`
  - `terminalSession`, `terminalOutput`, and the PTY facade
  - `switchToTerminal()` / `switchToStructured()`
  - presentation-aware control state, catch-up, resize, write, and shutdown
- `lib/session/session-manager.js`
  - `switchCodexPresentation()` and Codex PTY resize routing
- `lib/server/routes/providers.js`
  - `POST /api/sessions/:id/codex-presentation`
- `lib/commands/web.js`
  - presentation-aware WebSocket snapshots and catch-up
- `lib/web/index.html`, `lib/web/session.js`, `lib/web/claude.js`, `lib/web/codex.js`
  - TERM/CHAT switch affordance and presentation event handling

To inspect or restore a file, use for example:

```bash
git show 0622c2b:lib/codex/structured-session.js
git diff 0622c2b..HEAD -- lib/codex/structured-session.js
```

If this feature returns, restore it behind an explicit capability boundary and
add tests for process ownership, concurrent writers, terminal exit, reconnect,
and structured-session resumption before exposing the UI control.
