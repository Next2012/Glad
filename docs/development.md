# Development guide

## Requirements

- Go 1.24 or newer
- Node.js 18 or newer
- npm
- Chromium for browser tests
- the official Codex and Claude CLIs for live provider testing

Install development dependencies:

```bash
npm ci
```

Run Glad on the browser-test port:

```bash
go run . --port 3001
```

The production default remains port 3000. Port 3001 is reserved by the Playwright configuration and local browser checks.

## Source layout

- `main.go`: thin native entrypoint and embedded Web assets
- `internal/app/`: composition, use cases, HTTP/WebSocket adapters and provider adapters
- `internal/session/`: transport-independent session event contracts and bounded fan-out
- `lib/web/`: browser UI
- `lib/npm/`: npm packaging tests
- `npm/main/`: npm launcher template
- `npm/platforms/`: platform package templates
- `scripts/`: native build and package staging scripts

## Checks

Run the complete Go backend and packaging-tooling suite:

```bash
npm test
```

Run Go's race detector and static checks:

```bash
go test -race ./...
go vet ./...
test -z "$(gofmt -l *.go internal/app/*.go internal/session/*.go)"
```

Run browser tests against port 3001:

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright reuses a server already listening on 3001 outside CI. The manually triggered `Browser E2E` GitHub Actions workflow starts `go run . --port 3001` itself. Browser tests are intentionally separate from the required PR checks; run them locally before release.

## Native builds

```bash
npm run build:linux
npm run build:linux:arm64
npm run build:windows
npm run build:macos:x64
npm run build:macos:arm64
```

Build scripts set `CGO_ENABLED=0`, strip symbols and inject the package version. Generated binaries and staged packages belong in ignored build directories or temporary paths, not in source control.

## Live provider smoke tests

Before a release, verify at least:

1. Codex and Claude can each complete a streamed turn.
2. A command requiring approval pauses and resumes after the Web decision.
3. Resume and fork work for both providers.
4. Claude usage/context and Codex status/compaction cards render.
5. File and image attachments are private and removed with the session.
6. Stopping Glad with an active provider leaves no child process behind.

Do not commit local credentials, `~/.glad` contents, test uploads, Playwright artifacts or generated binaries.
