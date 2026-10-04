# 群聊 Supervisor 与消息多选开发验证

2026 年 10 月 4 日，依据[评估文档](room-supervisor-selection-assessment-20261004.md)和后续审查完成实现。新增功能包括按目标 Session 判断发送、运行中输出读取、单成员停止和启动、Supervisor 配置与调度、MCP 操作入口，以及长按消息多选。

## 已实现的行为

### Session 操作

- HTTP、WebSocket、群消息和定时消息经过统一发送检查。Codex 和 Claude 提供 `CanAccept`，实际发送仍在同步保护内重新检查。
- 群内其他成员运行不影响向空闲成员发送；纯文字群消息可在成员运行时保存。
- 读取接口返回当前 turn、原生会话 ID、状态、可发送条件及变更游标。原地更新消息推进游标；删除或重载历史返回 reset。
- 停止接口接受预期 turn ID。停止接受与可再次发送分开表示；Claude 进程异常退出时结算残留轮次并保留恢复位置。

### Supervisor

- 底栏 Supervisor 面板配置执行者、多个监控对象、分别默认开启的读取/停止/发送权限、间隔和提示词。
- 默认间隔 120 秒，允许 60 至 86400 秒；无变化跳过默认关闭。
- 本次执行结束并确认 provider 可发送后计算下一次触发。执行者忙碌时等待，同一 Session 的执行预约避免多个任务同时启动。
- 同一 Session 不能同时承担已有任务的执行者与监控对象，即使它加入了不同群。
- invocation 来源同步附到事件上，容量重试继承 invocation，并通过固定顶层文本信封保存在原生历史中。
- 群内隐藏 Supervisor 控制触发及其回复；执行者给目标的命令标注作者并正常展示。
- 普通自动完成静默，失败保留原有提醒路径。静默覆盖 Session、群的完成未读，以及两条 ServerChan 路径。
- 工具调用校验会话凭证、当前 invocation、成员身份和当前目标权限；普通轮次、过期调用及撤销的权限被拒绝。
- 支持创建、编辑、暂停/继续、立即触发、停止本轮、结束自身监控和删除。删除运行中的任务立即撤销工具权限，执行者结算后释放预约。
- 配置及最近调用历史按任务原子保存到 `~/.glad/supervisors/<id>.json`。最多保留 100 次 invocation，每次 200 条审计，并限制文件历史体积。daemon 重启后暂停，待用户恢复成员并继续任务。
- 调用历史展示结论、读取截取、操作结果，以及能关联到轮次的 usage/费用；没有 usage 的轮次显示未提供。
- 面板可读取目标当前输出并持续刷新，也可分页读取历史、停止单个成员、发送新提示词启动它。

### 消息多选

- 消息加号按钮移除，长按进入选择模式；键盘 Enter/空格也可以选中聚焦消息。
- 所有条目显示左侧圆圈并为其让出 40 像素空间。用户消息保留右对齐，只读平铺预览不进入选择模式。
- 捕获阶段处理整条选择点击，头像、作者栏、链接等不触发原操作。选择模式下长按按一次点击处理。
- 运行中的回复不可引用，点击不弹 alert。抬手点击、滚动和长按取消分别处理，避免反选或误选。
- 顶部显示 Cancel、选中计数和 Preview；零选中仍保留模式，Preview 禁用。底部保留引用标签，移除 Preview。
- Cancel 保留输入文字、成员选择及附件；成功发送/保存定时消息退出，失败保留草稿。选择期间新增消息继承布局。
- 消息节点和阅读锚点保留，布局变更后重新测量折叠；实时快照不会重建无变化内容。

## 接口与工具

| 接口 | 用途 |
| --- | --- |
| `GET /api/sessions/{id}/output?after=&limit=` | 增量读取当前输出，返回 cursor、reset、currentTurnId、canAccept |
| `GET /api/sessions/{id}/output?history=true&offset=&limit=` | 分页读取当前会话历史 |
| `POST /api/sessions/{id}/abort` | 中断，可提交 expectedTurnId |
| `POST /api/sessions/{id}/input` | 发送提示词，可提交 clientMessageId |
| `GET/POST /api/rooms/{id}/supervisors` | 列出或创建任务 |
| `PATCH/DELETE /api/rooms/{id}/supervisors/{taskId}` | 修改或删除任务 |
| `POST /api/rooms/{id}/supervisors/{taskId}/{action}` | pause、resume、trigger、stop |
| `POST /api/supervisor/call` | MCP 的受授权调用入口 |

`glad mcp` 通过 stdio 提供 `list_targets`、`read_session`、`stop_session`、`send_to_session`、`end_supervision`。工具调用带当前 invocationId，连接凭证放在该 Session 的 MCP 环境配置里，不进入提示词。

主要代码：[session_control.go](../internal/app/session_control.go)、[supervisor.go](../internal/app/supervisor.go)、[supervisor_mcp.go](../internal/app/supervisor_mcp.go)、[room-supervisors.js](../lib/web/room-supervisors.js)、[rooms.js](../lib/web/rooms.js)。

## 验证环境和结果

验证前检查了 3001 至 3010：3001、3002 已占用，选择空闲的 **3003** 启动测试 daemon。Playwright 使用独立临时 HOME、配置和 provider fixture，没有复用或重启已有服务，也没有向已有群或 Session 写入测试消息。

完整相关浏览器回归覆盖手机、平板和桌面：**49 项通过、20 项按既有设备条件跳过**。随后针对新增的整条选择、零选中、Cancel 保留草稿，以及 Supervisor 闭环重跑手机和桌面用例。

```bash
GLAD_E2E_PORT=3003 npx playwright test \
  tests/e2e/room-scroll.spec.js tests/e2e/rooms.spec.js \
  tests/e2e/room-parity.spec.js tests/e2e/supervisors.spec.js
```

Supervisor 端到端用例让测试 provider 启动实际的 `glad mcp` 子进程，经 stdio 和 HTTP 调用实际 daemon，依次执行列出目标、读取和派工。检查了调用审计、派工作者、触发消息隐藏、未读静默、编辑和删除，以及忙碌目标拒绝发送、单独停止后启动。

Go 验证包括全量测试，以及新增控制/调度测试的 race 检查。覆盖并发发送、幂等、流式 patch、历史 reset、普通轮次和旧 invocation 拒绝、读取/发送权限、原生信封过滤、容量重试来源继承、关闭群暂停，以及删除运行任务后预约释放。JavaScript 语法检查和 diff 空白检查通过。

```bash
go test ./...
go test -race ./internal/app \
  -run 'TestSupervisor|TestSessionControl|TestSessionOutput|TestDeletingRunningSupervisor' \
  -count=1
npm run check
git diff --check
```

## 原生 CLI 接入检查

使用本机 Codex 0.159.2、Claude 2.1.287，在独立临时目录且不发送模型轮次的条件下检查：

| 检查 | 结果 |
| --- | --- |
| Codex app-server initialize 与 config/read | 通过，配置包含 Glad MCP |
| Codex thread/start 同时提供线程 config | 通过，Glad MCP 保留 |
| Codex mcpServerStatus/list | 返回全部 5 个 Glad 工具 |
| Claude MCP 配置及 allowedTools 的 stream initialize | 通过 |
| Claude 带同样参数恢复本地构造的有效会话记录 | initialize 通过 |

这些原生检查证明配置解析、工具挂载和恢复初始化兼容。没有调用付费模型，未验证真实模型在各种用户 ask/deny 策略下自主调用工具的审批行为。端到端工具调用使用可重复的测试模型协议；仅预放行自带 Glad 工具，其他审批规则及 ask/deny 优先级保持原有行为。

## 使用边界

权限开关控制 Supervisor 工具入口，不隔离 Session 原有 shell、文件访问或未统一鉴权的普通 HTTP 接口。启动新版本 daemon 后创建/恢复的 provider 进程会挂载 Glad MCP；旧版本已经运行的进程不会因修改源码自动获得新工具。

周期监控会合并两次检查之间的返回，不提供目标每轮结束立即触发的额外模式。监控配置、审计和原生会话恢复保持独立。
