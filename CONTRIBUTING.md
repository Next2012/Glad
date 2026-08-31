# Contributing to Glad

Thanks for your interest in contributing to Glad.

Glad is a local-first Web interface for the official Codex and Claude CLIs. Contributions that improve stability, UX, compatibility, documentation, and release quality are welcome.

## Code of Conduct

Be respectful, specific, and constructive.

## Getting Started

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Glad.git
   cd glad
   ```
3. Install dependencies:
   ```bash
   npm ci
   ```
4. Start Glad locally:
   ```bash
   go run . --port 3001
   ```

## Project Structure

- `main.go` native entrypoint and embedded frontend declaration
- `internal/app/` Go runtime, provider adapters, HTTP and WebSocket contracts
- `lib/web/` browser UI
- `lib/npm/` npm packaging tests
- `npm/` npm launcher and platform-package templates
- `scripts/` native build and release staging scripts
- `docs/` architecture, development and release documentation

## Development Guidelines

- Keep changes focused and easy to review.
- Preserve existing runtime behavior unless the change intentionally alters it.
- Prefer small, explicit modules over broad refactors.
- Format Go with `gofmt`; retain the existing script style in browser and packaging code.
- Keep provider-specific wire details inside `internal/app/claude.go` or `internal/app/codex.go`.
- Preserve the browser HTTP/WebSocket contract unless the UI and tests change in the same pull request.
- Update user-facing docs when behavior changes.

## Testing

Before opening a pull request, run the checks that apply to your change:

```bash
npm run check
npm test
go test -race ./internal/app
go vet ./internal/app .
go run . --version
```

For Web UI or responsive layout changes, install Chromium once and run the browser suite. The suite starts Glad on port `3001` and covers the maintained phone, tablet, and desktop viewports.

```bash
npx playwright install chromium
npm run test:e2e
```

If you changed the packaged binary flow, build the affected targets and stage the npm package as described in `docs/releasing.md`.

```bash
npm run build:linux
```

If you changed the Web UI or Git view, test against a real repository with:

- tracked changes
- untracked files
- nested directories
- non-ASCII filenames when relevant

## Pull Requests

When submitting a pull request:

1. Create a branch with a descriptive name.
2. Explain the problem and the change clearly.
3. Include validation steps.
4. Update screenshots or GIFs if the UI changed.
5. Keep unrelated cleanup out of the same PR.

## Provider Support

Glad intentionally supports Codex and Claude. A proposal to add another provider must include:

- a stable structured protocol rather than terminal scraping
- interactive approval, interruption, resume and cleanup behavior
- browser contract and provider fixture tests
- native-process lifecycle checks on supported operating systems

Provider implementations belong in `internal/app`.

## Documentation

Please update these files when appropriate:

- `README.md` for user-facing behavior
- `README.zh-CN.md` for Chinese documentation parity
- `CHANGELOG.md` for release-facing changes
- `docs/architecture.md` for runtime boundaries
- `docs/releasing.md` for packaging changes

## Issues

For bug reports and feature requests, use the repository issue templates.

Security-sensitive issues should avoid full public exploit details until a fix is available.
