# Glad 🚀

**Transform your terminal-based AI coding tools into a beautiful, mobile-friendly Web interface.**

Glad is a lightweight, local-only web interface for interactive terminal AI assistants. It allows you to run tools like **Claude Code**, **Aider**, **GitHub Copilot CLI**, and **Gemini CLI** on your machine and access them through a responsive Web PWA in your local network.

> [!IMPORTANT]
> **Acknowledgment**: This project is a major refactor and fork of the excellent [termly-cli](https://github.com/termly-dev/termly-cli) by the Termly Team. While the original focused on E2EE remote connections, **Glad** is redesigned to focus exclusively on a high-performance, local-only Web interface architecture.

![Glad AI mobile interface](./demo.gif)

---

## ✨ Features

- 🌐 **Instant Web UI** - One command to turn any CLI tool into a Web PWA.
- 📱 **Mobile Optimized** - Full touch-friendly terminal with shortcut keys.
- 🎯 **Multi-Session** - Manage multiple AI agents from a single dashboard.
- 📂 **Custom Paths** - Specify different working directories for each session.
- ⌨️ **Smart Input** - Automatically handles multi-line prompts and Enter key simulation (1s delay).
- 🛠️ **Auto-Detection** - Automatically finds 20+ installed AI assistants on your system.
- 📦 **Zero Dependencies** - Standalone binary release, no Node.js required on target machines.

## 🚀 Quick Start

### Run from Source
```bash
git clone git@gitee.com:next2012/glad.git
cd glad
npm install
node bin/cli.js
```

### Run as Binary (Linux amd64)
Download the `glad-linux-amd64` executable:
```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
```

## 🛠 Usage

By default, Glad starts a web server on port **3000**.

1.  Open `http://localhost:3000` (or your local IP) on any device.
2.  Click **"+ New"** to create a session.
3.  (Optional) Enter a **Working Directory** path.
4.  Select your favorite AI tool from the list.
5.  Start coding!

### Custom Port
```bash
glad --port 8080
```

## 🤖 Supported AI Tools

Glad supports **22+** interactive AI assistants, including:
- **Claude Code** (Anthropic)
- **Aider** (Open-source agent)
- **GitHub Copilot CLI**
- **Google Gemini CLI**
- **Amazon Q Developer**
- **Cursor Agent CLI**
- **Continue CLI**
- **OpenHands**, **Mentat**, **ChatGPT CLI**, and many more.

## 📦 Build Binary

To package Glad into a single executable for distribution:
```bash
npm run build:linux
```
This generates a `glad-linux-amd64` binary.

## 🔒 Security & Privacy

- **Local Network Only**: Glad only listens on your local network.
- **Privacy First**: Your data never leaves your network. Glad acts only as a local proxy between your terminal and your browser.

## 💬 Community

Scan the QR code below to join the **vibe coding** discussion group:

![Glad vibe coding group QR code](./wechat.jpg)

## 📄 License

MIT. Original work by [Termly Team](https://github.com/termly-dev/termly-cli). Refactored and maintained by [next2012](https://gitee.com/next2012/glad).
