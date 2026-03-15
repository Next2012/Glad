# Termly CLI 🚀

**Transform your terminal-based AI coding tools into a beautiful, mobile-friendly Web interface.**

Termly allows you to run tools like **Claude Code**, **Aider**, **GitHub Copilot CLI**, and **Gemini CLI** in your local network and access them via a responsive Web PWA. No more cramped mobile terminals—get a full, rich UI on any device.

## ✨ Features

- 🌐 **Instant Web UI** - One command to turn any CLI tool into a Web PWA.
- 📱 **Mobile Optimized** - Full touch-friendly terminal with shortcut keys.
- 🎯 **Multi-Session** - Manage multiple AI agents from a single dashboard.
- 📂 **Custom Paths** - Specify different working directories for each session.
- ⌨️ **Smart Input** - Automatically handles multi-line prompts and Enter key simulation.
- 🛠️ **Auto-Detection** - Automatically finds 20+ installed AI assistants on your system.
- 📦 **Zero Dependencies** - Single binary release, no Node.js required on target machines.

## 🚀 Quick Start

### Run from Source
```bash
git clone https://github.com/termly-dev/termly-cli
cd termly-cli
npm install
node bin/cli.js
```

### Run as Binary (Linux amd64)
Download the `termly-linux-amd64` executable:
```bash
chmod +x termly-linux-amd64
./termly-linux-amd64
```

## 🛠 Usage

By default, Termly starts a web server on port **3000**.

1.  Open `http://localhost:3000` (or your local IP) on any device.
2.  Click **"+ New"** to create a session.
3.  (Optional) Enter a **Working Directory** path.
4.  Select your favorite AI tool from the list.
5.  Start coding!

### Custom Port
```bash
termly --port 8080
```

## 🤖 Supported AI Tools

Termly supports **22+** interactive AI coding assistants, including:
- **Claude Code** (Anthropic)
- **Aider** (Popular open-source agent)
- **GitHub Copilot CLI**
- **Google Gemini CLI**
- **Amazon Q Developer**
- **Cursor Agent CLI**
- **Continue CLI**
- **OpenHands**, **Mentat**, **ChatGPT CLI**, and many more.

## 📦 Build Binary

To package Termly into a single executable for distribution:
```bash
npm run build:linux
```
This uses `caxa` to bundle the Node.js runtime and native extensions (`node-pty`) into a ~50MB binary.

## 🔒 Security

- **Local Network Only**: By default, Termly only listens on your local machine and local network.
- **Privacy**: Your data never leaves your network. Termly acts only as a proxy between your local PTY and your browser.

## 📄 License

MIT
