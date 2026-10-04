# Supervisor 界面优化与验证

已按审查完成界面拆分、按需加载接口、操作语义修正、JSONL 审计及损坏文件容错。界面文字保持英文。本次功能尚未发布，直接采用新存储格式；3003 演示实例使用新的独立数据目录，旧演示目录保留为备份，没有迁移或删除真实用户数据。

## 界面

- 打开 Supervisor 默认只显示任务列表。卡片展示执行者与目标、提示词摘要、状态和监控开关；运行时显示 Stop run，其他动作放入更多菜单。
- 新建、编辑、详情在同一个面板里切换，带返回导航。新建 Save & start，编辑 Save changes；编辑不改变任务启停状态。
- 四栏配置保持原需求：执行者、监控对象与权限、检查间隔、提示词。执行者不出现在可选监控对象中；权限默认全开且收起，间隔提供 1m、2m、5m、15m、Custom。
- 编辑页不轮询，输入草稿不会被刷新覆盖。列表轮询只获取摘要，倒计时通过 serverNow 校准后本地计算。
- 详情按页获取轮次摘要，展开某一轮才获取工具调用；提示词和 usage 默认收起。刷新列表不重建详情，加载更早历史保留已展开内容。
- 手动 Session 操作移到 Members → Controls，在同一个 Members 面板内展示输出、历史、停止与发送，并可返回成员列表。

## 操作语义

| 操作 | 本轮 | 后续 |
| --- | --- | --- |
| Pause | 继续运行 | 结算后暂停 |
| Stop run | 撤销本轮工具权限并请求中断，等待 provider 结算 | 保留原监控开关 |
| Run once now | 空闲时运行，忙碌时仅等待一次 | 原来暂停的任务完成后仍暂停 |

runOnce 单独持久化，启动时消耗，关群和 daemon 重启时按暂停策略清理。无运行轮次时 Stop run 无操作。请求停止并不等于已经停止：已确认的中断记为 stopped，不计连续失败或退避；自然完成仍记录 completed，中断请求错误保留真实结果。

PATCH 后端忽略 enabled，配置编辑与启停操作独立。无正在运行的轮次时，只有间隔变化才重新计算 nextAt；仅修改提示词不会推迟检查。

## 接口和存储

| GET 接口 | 返回内容 |
| --- | --- |
| `/api/rooms/{id}/supervisors` | 摘要、serverNow、加载问题计数；不含完整提示词和调用历史 |
| `/api/rooms/{id}/supervisors/{taskId}` | 编辑配置与当前摘要 |
| `/api/rooms/{id}/supervisors/{taskId}/history?limit=&before=` | 轮次摘要分页，游标为稳定 invocation ID |
| `/api/rooms/{id}/supervisors/{taskId}/history/{invocationId}` | 单轮提示词、工具调用和 usage |

任务配置使用 schemaVersion 2，保存到 `<taskId>.json`；审计使用 `<taskId>.audit.jsonl` 追加写入。每次读取操作不再重写整个配置文件。单个日志达到 4 MiB 时滚动，保留一个前段日志；内存最多保留最近 100 轮，每轮最多 200 条调用。

追加失败会返回错误；启动时忽略并报告不完整尾行，修复当前日志尾部后继续追加。损坏配置和未知版本保留原文件，报告到 Supervisor 面板，不阻止其他任务及 daemon 启动。

MCP 连接使用独立连接 ID 参与调用幂等键，防止子进程重启后 JSON-RPC ID 重用。Session 发送哈希缓存限制为 1024 条。

## 验证

- `go test ./...`、`go vet ./...`、定向 race、JavaScript 语法检查、diff 空白检查通过。
- 新增后端测试覆盖 Pause、Stop run、Run once now 三种结果，Stop run 无运行时不改变调度，自然完成不误标 stopped。
- 配置测试覆盖 PATCH 保留启停状态、提示词编辑不重置倒计时、损坏及未来版本文件保留并报告。
- 审计测试覆盖读取调用不重写配置、JSONL 恢复、不完整尾行、追加失败、日志滚动及调用数量限制。
- 接口测试覆盖摘要不含完整历史、serverNow、历史分页与单轮详情。
- 3004 隔离实例上的手机、平板、桌面相关回归：37 项通过、20 项按既有设备条件跳过。收尾的手机与桌面 Supervisor 用例 6 项通过。
- 浏览器检查覆盖列表与编辑分层、排除执行者、收起权限、暂停任务的单次运行、按需加载历史、编辑保留暂停、成员控制在同一面板切换及编辑草稿保留。
- 更新并检查了 3003 演示实例，手机视口下列表和四栏编辑均可正常展示。该实例继续使用测试 Provider，不调用真实模型；3001、3002 服务未改动。

主要代码：[supervisor.go](../internal/app/supervisor.go)、[supervisor_store.go](../internal/app/supervisor_store.go)、[room-supervisors.js](../lib/web/room-supervisors.js)、[room-member-controls.js](../lib/web/room-member-controls.js)。
