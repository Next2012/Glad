# Architecture Optimization Plan

## Goals

Glad currently works as a compact Node.js CLI plus local web app. The main architectural pressure is that backend web orchestration and frontend browser logic have grown into large, mixed-responsibility files. This plan keeps behavior stable while moving responsibilities into clearer modules.

## Current Issues

1. `lib/commands/web.js` owns server boot, route handlers, WebSocket handling, session lifecycle, schedule polling, Git commands, file browsing, history compression, and diagnostics.
2. Session lifecycle is stored inside the `webCommand` closure, which makes it hard for HTTP routes, WebSocket handlers, and scheduled jobs to share a stable interface.
3. Git and workspace file operations are embedded in route handlers, making them harder to test and audit.
4. Schedule persistence, runtime state, and timer triggering are split across `JobStore`, `JobRunner`, and `web.js` without one scheduler boundary.
5. `lib/web/index.html` contains HTML, CSS, app state, API calls, terminal behavior, schedule editing, and Git UI in one file.
6. There is no automated test harness, so refactors need small steps and syntax/runtime checks.

## Target Shape

Backend:

- `lib/commands/web.js`: thin command entry point that wires services and starts the server.
- `lib/session/session-manager.js`: owns session creation, mutation, lifecycle, diagnostics, and output events.
- `lib/git/service.js`: owns Git command execution and parsing.
- `lib/workspace/service.js`: owns workspace path safety and file listing/reading.
- `lib/schedule/scheduler-service.js`: owns interval polling and scheduled job triggering.
- Route modules can be added after the service layer is stable.

Frontend:

- Keep `index.html` unchanged during the backend service extraction.
- Later split browser code into app state, API client, terminal view, schedule view, history view, and Git view modules.

## Execution Steps

1. Add this document as the local source of truth.
2. Extract Git service:
   - Move `execFilePromise` and `parseGitStatusZ` logic out of `web.js`.
   - Provide methods for log, show, status, diff numstat, and diff file.
3. Extract workspace service:
   - Centralize path resolution and workspace boundary checks.
   - Provide methods for file reads and directory listings with Git status decoration.
4. Extract session manager:
   - Move session map, creation, deletion, rename, write, resize, history, diagnostics, and completion tracking out of `web.js`.
   - Expose narrow methods for routes, WebSocket, and scheduled jobs.
5. Extract scheduler service:
   - Move `setInterval` polling out of `web.js`.
   - Provide `start()` and `stop()`.
6. Update `web.js` to wire services together while preserving API behavior.
7. Run basic verification:
   - `node --check` on changed JavaScript files.
   - `node bin/cli.js --help`.
   - Start the web server if practical and hit basic endpoints.

## Guardrails

- Keep public API routes and response shapes unchanged.
- Avoid frontend refactoring in the same pass as backend service extraction.
- Prefer dependency injection over new global singletons.
- Preserve CommonJS style because the project currently uses `require`.
- Make path boundary checks stricter using `path.relative`, not string prefix checks.
- Keep changes small enough to inspect with `git diff`.

## Follow-Up Work

After backend extraction is stable:

1. Add a test runner and cover pure logic first:
   - `computeNextRunAt`
   - `normalizeJob`
   - Git status parsing
   - workspace path checks
   - `TextHistory`
   - `JobRunner`
2. Split frontend JavaScript out of `index.html`.
3. Consider a lightweight bundler only after browser modules are separated.
