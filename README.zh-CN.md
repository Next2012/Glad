# Glad

Glad 是一个面向终端 AI 编码工具的本地优先 Web 界面。

它让你可以在自己的机器上运行 **Claude Code**、**Aider**、**GitHub Copilot CLI**、**Gemini CLI** 等交互式命令行工具，并通过一个适合桌面和移动端访问的浏览器界面来使用它们。

![Glad AI 移动端界面](./assets/demo.gif)

> [!NOTE]
> Glad 基于 [termly-cli](https://github.com/termly-dev/termly-cli) 演化而来，但当前项目已经明确收敛为更简单的模型：本地执行、局域网访问、以及围绕终端 AI 工具的轻量 Web UI。

## 项目特点

- 一条命令启动 Web UI
- 适合手机访问的终端交互体验
- 在一个面板中管理多个会话
- 每个会话可单独指定工作目录
- 自动检测多种主流 AI CLI
- 支持打包 Linux 独立二进制

## 快速开始

### 从源码运行

要求：

- Node.js `>=18`

```bash
git clone git@gitee.com:next2012/glad.git
cd glad
npm install
node bin/cli.js
```

### 以 Linux 二进制运行

```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
```

## 使用方式

Glad 默认在本机 `3000` 端口启动 Web 服务。

1. 打开 `http://localhost:3000`
2. 点击 `+ New`
3. 按需填写工作目录
4. 选择一个已安装的 AI 工具
5. 在浏览器里启动并使用会话

常用命令：

```bash
glad
glad /path/to/project
glad . --port 8080
glad tools list
glad tools detect
```

## 支持的工具

Glad 当前支持检测 20+ 终端 AI 工具，包括：

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

## 打包

构建 Linux 独立二进制：

```bash
npm run build:linux
```

构建后会生成 `glad-linux-amd64`。

## 安全模型

Glad 面向受信任的本机或局域网环境使用。

- 服务进程运行在你的机器上
- 终端 I/O 保留在本机
- 浏览器 UI 直接与本地 Glad 进程通信

如果没有额外访问控制，不建议直接暴露到公网。

更多说明见 [SECURITY.md](./SECURITY.md)。

## 社区

如果你想加入项目交流群，可以扫描下方二维码：

![Glad 社区交流群二维码](./assets/wechat.jpg)

## 开源协议

本项目使用 MIT 协议，由 [next2012](https://gitee.com/next2012/glad) 维护。
