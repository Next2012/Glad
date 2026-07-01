# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Glad is a local-first Web interface for terminal-based AI coding tools. It starts a local HTTP server, launches AI CLIs in local PTY sessions, and maps terminal I/O to a browser UI through WebSocket and xterm.js.

Glad does not use a hosted relay, pairing code flow, or end-to-end encryption layer. Browser access is intended for the local machine or trusted local network.

## Development Commands

```bash
# Install dependencies
npm install

# Start the Web UI in the current directory
node bin/cli.js

# Start the Web UI for a specific directory
node bin/cli.js /path/to/project

# Use a custom port
node bin/cli.js . --port 3001

# List or inspect supported tools
node bin/cli.js tools list
node bin/cli.js tools detect
node bin/cli.js tools info codex

# Show or update persisted Glad config
node bin/cli.js config
node bin/cli.js config set defaultAI codex

# Debug mode
DEBUG=1 node bin/cli.js . --port 3001

# View logs
tail -f ~/.glad/logs/cli.log

# Clean local Glad state
rm -rf ~/.glad
```

## Runtime Storage

- Config: `~/.glad/config.json`
- Scheduled tasks: `~/.glad/schedules.json`
- Logs: `~/.glad/logs/cli.log`

The project uses `conf` v10.x because the codebase is CommonJS.

## Architecture

### CLI Entry

- `bin/cli.js` registers the default `web [directory]` command.
- `lib/commands/web.js` owns the Express server, WebSocket server, REST APIs, session map, scheduled task runner, and static Web UI routes.
- `lib/web/index.html` is the browser UI.

### Terminal Data Flow

```text
AI CLI process
  <-> node-pty
  <-> PTYManager
  <-> WebSocket JSON messages
  <-> browser xterm.js
```

Browser to PTY:

```json
{ "type": "input", "data": "..." }
{ "type": "resize", "cols": 120, "rows": 32 }
```

PTY to browser:

```json
{ "type": "output", "data": "..." }
{ "type": "exit" }
```

### Session Lifecycle

1. Browser calls `POST /api/sessions` with `toolKey` and optional `workingDirectory`.
2. `createManagedSession()` creates a session id, output buffer, text history, optional rendered history, and `PTYManager`.
3. `PTYManager` starts the selected tool in a PTY.
4. Browser connects to `ws://host/?sessionId=<id>`.
5. PTY output is streamed to all WebSocket clients attached to that session.
6. Browser input and resize messages are written back to the PTY.

Sessions are in-memory only. If the Glad process exits, running sessions are killed.

### History

- `lib/session/buffer.js` stores recent raw PTY output for WebSocket catchup.
- `lib/session/text-history.js` builds a plain text transcript.
- `lib/session/rendered-history.js` uses `xterm-headless` for rendered terminal snapshots.
- `GET /api/sessions/:id/history` returns rendered history when available, otherwise transcript history.

### TUI Tools

`lib/session/pty-manager.js` has a `tuiTools` list. TUI tools skip circular buffer writes because alternate-screen apps redraw their own screen and raw catchup is usually misleading.

### Git and File Preview APIs

`lib/commands/web.js` exposes session-scoped Git and filesystem read APIs used by the Web UI:

- `/api/sessions/:id/git-log`
- `/api/sessions/:id/git-show/:hash`
- `/api/sessions/:id/git-status`
- `/api/sessions/:id/git-diff`
- `/api/sessions/:id/fs/file`
- `/api/sessions/:id/fs/dir`

Paths are resolved under the session working directory.

### Scheduled Tasks

- `lib/schedule/job-store.js` persists schedules with `conf`.
- `lib/schedule/job-runner.js` creates sessions and sends scripted inputs or key sequences.
- `lib/schedule/key-sequences.js` maps named keys to terminal byte sequences.

## Important Implementation Notes

- The server listens on `0.0.0.0` and prints local network URLs.
- WebSocket clients bind to sessions by `sessionId`.
- Only the first connected WebSocket for a session owns PTY resize events until it disconnects.
- PTY child processes inherit most of the parent environment, but screen-specific variables are removed to avoid false terminal detection by terminal tools.
- Unix tools are launched through `bash -i -c '<tool> <args>'`; Windows uses `cmd.exe /c`.
- `TERM` is forced to `xterm-256color` and `COLORTERM` to `truecolor`.
- `node-pty` is required for interactive terminal semantics and cannot be replaced by plain child processes.
- `chalk` v4.x and `conf` v10.x are used for CommonJS compatibility.

## Files To Check

- CLI commands: `bin/cli.js`, `lib/commands/*.js`
- PTY spawning and I/O: `lib/session/pty-manager.js`
- WebSocket terminal protocol: `lib/commands/web.js`, `lib/web/index.html`
- Terminal history: `lib/session/text-history.js`, `lib/session/rendered-history.js`, `lib/session/buffer.js`
- Tool definitions: `lib/ai-tools/registry.js`
- Tool detection: `lib/ai-tools/detector.js`
- Scheduled tasks: `lib/schedule/*.js`
- Persisted user config: `lib/config/manager.js`
- Logging: `lib/utils/logger.js`

## Adding A New AI Tool

Edit `lib/ai-tools/registry.js`:

```javascript
'tool-name': {
  key: 'tool-name',
  command: 'command-to-run',
  args: ['default', 'args'],
  displayName: 'Tool Display Name',
  description: 'Description',
  website: 'https://tool.website',
  checkInstalled: async () => await commandExists('command-to-run')
}
```

If the tool is an alternate-screen TUI app, also add its key to `tuiTools` in `lib/session/pty-manager.js`.
