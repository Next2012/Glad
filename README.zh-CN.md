# Glad 🚀

**把终端里的 AI 编码工具转换成一个美观、适合手机访问的 Web 界面。**

Glad 是一个轻量级、仅本地使用的 Web 界面，用于承载交互式终端 AI 助手。它可以在你的机器上运行 **Claude Code**、**Aider**、**GitHub Copilot CLI**、**Gemini CLI** 等工具，并通过本地网络中的响应式 Web PWA 进行访问。

> [!IMPORTANT]
> **致谢**：本项目是在优秀的 [termly-cli](https://github.com/termly-dev/termly-cli) 基础上进行大幅重构并分叉而来。原项目主要聚焦端到端加密的远程连接，而 **Glad** 重新设计为专注于高性能、仅本地使用的 Web 界面架构。

![Glad AI 移动端界面](./demo.gif)

---

## ✨ 功能特性

- 🌐 **即时 Web UI**：一条命令即可把任意 CLI 工具转换成 Web PWA。
- 📱 **移动端优化**：完整的触控友好终端体验，并带有快捷按键。
- 🎯 **多会话管理**：在一个面板中统一管理多个 AI Agent 会话。
- 📂 **自定义路径**：可以为每个会话指定不同的工作目录。
- ⌨️ **智能输入**：自动处理多行提示词，并模拟回车发送（1 秒延迟）。
- 🛠️ **自动检测**：自动发现系统中已安装的 20+ AI 助手。
- 📦 **零目标机依赖**：可打包为独立二进制，目标机器无需预装 Node.js。

## 🚀 快速开始

### 从源码运行

要求：

- Node.js `>=18.0.0`

```bash
git clone git@gitee.com:next2012/glad.git
cd glad
npm install
node bin/cli.js
```

你也可以使用：

```bash
npm start
```

### 以二进制方式运行（Linux amd64）

下载 `glad-linux-amd64` 可执行文件后执行：

```bash
chmod +x glad-linux-amd64
./glad-linux-amd64
```

## 🛠 使用方式

默认情况下，Glad 会在 **3000** 端口启动本地 Web 服务。

1. 在任意设备上打开 `http://localhost:3000`，或使用当前机器的局域网 IP 访问。
2. 点击 **“+ New”** 创建一个新会话。
3. 可选填写 **Working Directory**。
4. 从列表中选择要使用的 AI 工具。
5. 开始编码。

### 常用命令

```bash
glad
glad /path/to/project
glad . --port 8080
```

含义分别是：

- 在当前目录启动 Web 服务
- 在指定目录启动 Web 服务
- 在当前目录使用自定义端口启动

### CLI 命令

```bash
glad web [directory]
glad tools list
glad tools detect
glad tools info <tool-name>
glad config get [key]
glad config set <key> <value>
```

### 自定义端口

```bash
glad --port 8080
```

## 🤖 支持的 AI 工具

Glad 支持 **22+** 交互式 AI 助手，包括但不限于：

- **Claude Code**（Anthropic）
- **Aider**
- **GitHub Copilot CLI**
- **Google Gemini CLI**
- **Amazon Q Developer**
- **Cursor Agent CLI**
- **Continue CLI**
- **OpenHands**
- **Mentat**
- **ChatGPT CLI**

以及更多可自动检测的工具。

## 📦 构建二进制

如果你想把 Glad 打包成单个可执行文件用于分发，可以运行：

```bash
npm run build:linux
```

执行后会生成 `glad-linux-amd64` 二进制文件。

## 🔒 安全与隐私

- **仅本地网络使用**：Glad 只监听本地网络环境。
- **隐私优先**：数据不会离开你的网络。Glad 仅作为浏览器与终端之间的本地代理。

## 💬 交流群

扫描下方二维码，加入 **vibe coding 技能交流** 群聊：

![Glad vibe coding 技能交流群二维码](./wechat.jpg)

## 📄 开源协议

本项目使用 **MIT** 协议。

原始项目由 [Termly Team](https://github.com/termly-dev/termly-cli) 开发，Glad 版本由 [next2012](https://gitee.com/next2012/glad) 重构并维护。
