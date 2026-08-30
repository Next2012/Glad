<div align="center">
  <img src="./assets/logo.svg" alt="Glad Logo" width="150" height="150" />
  <h1>Glad</h1>
</div>

Glad 是一个面向终端 AI 编码工具的本地优先 Web 界面。

它在你的机器上运行官方 **Claude Code** 和 **Codex** CLI，并通过适合桌面和移动端的浏览器界面使用结构化会话。

![Glad AI 移动端界面](./assets/demo.jpg)

### 演示视频

看看 Glad 如何将终端 AI 工具无缝带到你的移动设备上：

<video src="assets/Demo.mp4" controls width="100%"></video>

> [!NOTE]
> Glad 基于 [termly-cli](https://github.com/termly-dev/termly-cli) 演化而来，但当前项目已经明确收敛为更简单的模型：本地执行、局域网访问、以及围绕终端 AI 工具的轻量 Web UI。

## 工作原理

![Glad 架构图](./assets/architecture.svg)

Glad 的核心工作原理：
1. Glad 运行在已安装并登录官方 Claude 和/或 Codex CLI 的机器上。
2. 启动 Glad 后，在本机和局域网可通过 3000 端口访问。
3. 如果使用 Tailscale 或者 ZeroTier 做了内网穿透，就可以进行远程操控。
4. 所有终端任务在本地的 Glad 守护进程中运行，不怕手机断网影响程序执行。

## 开发目的与设计哲学

Glad 的初衷是开发一款完全运行在本地的、足够简单的，且登录和授权完全对齐官方的工具，可以把各种 CLI “搬”到网页端。这样你就可以在移动设备上随时进行 **vibe coding**，不用担心包月订阅闲置，也无需担心客户端手机断联会导致电脑端的任务停止。

我们的设计哲学是：**易用、稳定、克制**。只提供最核心且体验优秀的功能：
- **Session 管理**：在一个面板中管理多个会话，每个会话可单独指定工作目录。
- **响应式工作区**：宽屏提供可调宽度的会话侧边栏，手机使用大厅与对话双页面，并支持亮色、暗色主题。
- **文件附件**：可从输入区上传图片或普通文件；附件仅保存于当前会话的私有临时目录，并会自动清理。
- **本地用量看板**：通过内置的只读 `ccusage` 引擎选择某周或某月，查看按模型汇总及每日 token，并用按模型堆叠的柱状图比较 token 和费用；费用完全采用 `ccusage` 估算，且只对 Codex 使用的 GPT 模型显示。
- **结构化 Provider 会话**：原生支持 Codex/Claude 流式输出、审批、恢复、分叉、模型、推理强度、沙箱和上下文控制。
- **高性能历史查看**：快速流畅的结构化历史，以及按需加载的工具详情。
- **简单但足够好用的改动检查**：内置 Git 改动预览功能。
- **断线保护**：服务端任务不受移动端网络断开影响。
- **开箱即用**：一条命令启动 Web UI，自动检测 Codex 和 Claude。
- **独立二进制**：支持打包 Linux、macOS 和 Windows 独立可执行文件。

## 快速开始

### 通过 npm 安装

要求：

- npm 安装需要 Node.js `>=18`
- 已安装并登录官方 `codex` 和/或 `claude` CLI

```bash
npm install -g glad-web
glad
```

安装时的 npm 包名是 `glad-web`，安装后的命令是 `glad`。

### 从源码运行

要求：

- Go `>=1.24`
- 前端测试及发布打包需要 Node.js `>=18`

```bash
git clone https://github.com/Next2012/Glad.git
cd glad
npm ci
go run .
```

### 以二进制运行

**Linux:**

```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
```

**Windows:**

直接双击 `glad-windows-amd64.exe` 即可运行，或者在命令提示符中执行：

```cmd
glad-windows-amd64.exe
```

**macOS Intel:**

```bash
chmod +x glad-macos-x64
./glad-macos-x64
```

**macOS Apple Silicon:**

```bash
chmod +x glad-macos-arm64
./glad-macos-arm64
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

Glad 现在有意只支持下面两个结构化编码 Agent：

| 工具 | 检测命令 |
| --- | --- |
| Claude | `claude` |
| Codex | `codex` |

## 打包

构建 Linux 独立二进制：

```bash
npm run build:linux
```

构建 Windows 独立二进制：

```bash
npm run build:windows
```

在 Intel macOS runner 上构建 macOS Intel 独立二进制：

```bash
npm run build:macos:x64
```

在 Apple Silicon macOS runner 上构建 macOS Apple Silicon 独立二进制：

```bash
npm run build:macos:arm64
```

Go 发布流水线会交叉构建 Linux x64/arm64、Windows x64 和 macOS x64/arm64 的 stripped 独立二进制。npm 发布一个小型启动器和对应 OS/CPU 的二进制包，安装结果不再包含 Go 后端源码。

开发者文档：

- [架构说明](docs/architecture.md)
- [开发与测试](docs/development.md)
- [发布流程](docs/releasing.md)

## 安全模型

Glad 面向受信任的本机或局域网环境使用。

- 服务进程运行在你的机器上
- 终端 I/O 保留在本机
- 浏览器 UI 直接与本地 Glad 进程通信

如果没有额外访问控制，不建议直接暴露到公网。

更多说明见 [SECURITY.md](./SECURITY.md)。


## 开源协议

本项目使用 MIT 协议，由 [Next2012](https://github.com/Next2012/Glad) 维护。
