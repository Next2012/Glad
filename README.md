# Glad

Glad is a local-first Web interface for terminal-based AI coding tools.

It lets you run interactive CLI tools such as **Claude Code**, **Aider**, **GitHub Copilot CLI**, and **Gemini CLI** on your machine, then access them through a clean browser UI from desktop or mobile devices on your local network.

![Glad AI mobile interface](./assets/demo.gif)

> [!NOTE]
> Glad is derived from [termly-cli](https://github.com/termly-dev/termly-cli), but the current project is intentionally focused on a simpler model: local execution, local network access, and a lightweight Web UI for terminal-native AI tools.

## Highlights

- One-command Web UI for terminal AI tools
- Mobile-friendly terminal experience with touch shortcuts
- Multiple sessions from a single dashboard
- Per-session working directory selection
- Built-in detection for many popular AI CLIs
- Linux standalone binary packaging

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

### Run as a Linux binary

```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
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

Glad currently supports detection for 20+ terminal AI tools, including:

- Claude Code
- Aider
- OpenAI Codex CLI
- GitHub Copilot CLI
- Google Gemini CLI
- Amazon Q Developer
- Cursor Agent CLI
- Continue CLI
- OpenHands
- Mentat

## Packaging

Build a Linux standalone binary with:

```bash
npm run build:linux
```

This produces `glad-linux-amd64`.

## Security Model

Glad is designed for trusted local or private-network use.

- the server runs on your machine
- terminal I/O stays local to that machine
- the browser UI talks directly to the local Glad process

Do not expose Glad directly to the public internet without adding your own access controls.

See [SECURITY.md](./SECURITY.md) for details.

## Community

If you want to join the project chat group, scan the QR code below:

![Glad community group QR code](./assets/wechat.jpg)

## License

MIT. Glad is maintained by [next2012](https://gitee.com/next2012/glad).
