# Contributing to Glad

Thanks for your interest in contributing to Glad.

Glad is a local-first Web interface for terminal-based AI coding tools. Contributions that improve stability, UX, compatibility, documentation, and release quality are welcome.

## Code of Conduct

Be respectful, specific, and constructive.

## Getting Started

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://gitee.com/YOUR_USERNAME/glad.git
   cd glad
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start Glad locally:
   ```bash
   node bin/cli.js
   ```

## Project Structure

- `bin/` CLI entrypoint
- `lib/commands/` top-level CLI commands
- `lib/session/` PTY and terminal session management
- `lib/ai-tools/` tool registry and installation detection
- `lib/config/` persisted user settings
- `lib/utils/` shared utilities
- `lib/web/` bundled Web UI
- `scripts/` build and maintenance scripts

## Development Guidelines

- Keep changes focused and easy to review.
- Preserve existing runtime behavior unless the change intentionally alters it.
- Prefer small, explicit modules over broad refactors.
- Follow the existing CommonJS style used in the project.
- Update user-facing docs when behavior changes.

## Testing

Before opening a pull request, run the checks that apply to your change:

```bash
node bin/cli.js --version
npm pack --dry-run
```

If you changed the packaged binary flow, also test:

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

## AI Tool Support

If you add support for a new AI tool, make sure:

- the tool can run interactively in a terminal
- it works correctly under PTY control
- detection is reliable
- the launch command and description are accurate

Registry changes belong in `lib/ai-tools/registry.js`.

## Documentation

Please update these files when appropriate:

- `README.md` for user-facing behavior
- `README.zh-CN.md` for Chinese documentation parity
- `CHANGELOG.md` for release-facing changes

## Issues

For bug reports and feature requests, use the repository issue templates.

Security-sensitive issues should avoid full public exploit details until a fix is available.
