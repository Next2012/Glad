<div align="center">
  <img src="./assets/logo.svg" alt="Glad Logo" width="150" height="150" />
  <h1>Glad</h1>
</div>

Glad is a local-first Web interface for terminal-based AI coding tools.

It lets you run interactive CLI tools such as **Claude Code**, **Aider**, **GitHub Copilot CLI**, and **Gemini CLI** on your machine, then access them through a clean browser UI from desktop or mobile devices on your local network.

### Demo Video

Watch how Glad brings terminal AI tools to your mobile device seamlessly:

<video src="assets/Demo.mp4" controls width="100%"></video>

> [!NOTE]
> Glad is derived from [termly-cli](https://github.com/termly-dev/termly-cli), but the current project is intentionally focused on a simpler model: local execution, local network access, and a lightweight Web UI for terminal-native AI tools.

## Design Philosophy & Highlights

Glad was created to enable **vibe coding** on mobile devices. By bringing various CLIs to the web browser, login and authorization are completely aligned with the official tools, ensuring you can fully utilize your paid monthly subscriptions anywhere.

Our design philosophy is **Easy to use, Stable, and Restrained**. Glad focuses strictly on the essentials:
- **Session management:** Run multiple sessions from a single dashboard with per-session working directories.
- **High-fidelity terminal interaction:** A mobile-friendly terminal experience with touch shortcuts.
- **Extreme performance history viewing:** Fast and responsive text history.
- **Simple but effective change checking:** Integrated Git changes preview.
- **Resilient execution:** Client (mobile) disconnections will not interrupt running tasks on the host machine.
- **Simplicity:** One-command Web UI with built-in detection for many popular AI CLIs.
- **Standalone binaries:** Linux and Windows standalone packaging available.

## Quick Start

### Run from source

Requirements:

- Node.js `>=18`

```bash
git clone git@gitee.com:next2012/glad.git
cd glad
npm install
node bin/cli.js
```

### Run as a binary

**Linux:**

```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
```

**Windows:**

Simply double-click `glad-windows-amd64.exe` to run, or execute it in the Command Prompt:

```cmd
glad-windows-amd64.exe
```

## Usage

Glad starts a local Web server on port `3000` by default.

1. Open `http://localhost:3000`.
2. Click `+ New`.
3. Optionally choose a working directory.
4. Pick an installed AI tool.
5. Start the session from the browser UI.

Useful commands:

```bash
glad
glad /path/to/project
glad . --port 8080
glad tools list
glad tools detect
```

## Supported Tools

Glad currently supports detection for 20 terminal AI tools, including:

- Claude Code
- Aider
- OpenAI Codex CLI
- GitHub Copilot CLI
- Cody CLI
- Google Gemini CLI
- Continue CLI
- Cursor Agent CLI
- ChatGPT CLI
- ShellGPT
- Mentat
- Grok CLI
- Ollama
- OpenHands
- OpenCode
- Blackbox AI
- Amazon Q Developer
- Pi Coding Agent
- Kilo Code CLI
- Qoder CLI

## Packaging

Build a Linux standalone binary with:

```bash
npm run build:linux
```

Build a Windows standalone binary with:

```bash
npm run build:windows
```

After building, `glad-linux-amd64` and `glad-windows-amd64.exe` files will be generated respectively.

## Security Model

Glad is designed for trusted local or private-network use.

- the server runs on your machine
- terminal I/O stays local to that machine
- the browser UI talks directly to the local Glad process

Do not expose Glad directly to the public internet without adding your own access controls.

See [SECURITY.md](./SECURITY.md) for details.


## License

MIT. Glad is maintained by [next2012](https://gitee.com/next2012/glad).
