# 派发：一个会话把活交给另一个

会话 A 里的 agent 跑 `agora dispatch --to <会话>|--new claude|codex|pi --text/--task-file …`（来源取环境里的 `$AGORA_SESSION`，不猜窗格），Agora 看得到 B 接没接、做到哪、交没交回。实现是 `server/canvas/dispatch.py`（`Dispatches`）和 `dispatch_store.py`（记录格式）；状态机只用 `native_protocol.py` 的纯函数。

- **唯一事实源**：`.agora/dispatch/<request_id>.json`（`DeliveryRecord`、任务摘要、范围、来源会话、目标会话、权限模式、回执、经过的状态），正文在 `<id>/task.md`、`<id>/reply.md`。原子写，目录在生成的 `.gitignore` 里。样本：`tests/fixtures/dispatch/sample.json`。实际发生了什么以各 CLI 自己的日志为准，不复制。
- **一次派发**：① 写记录（`dispatched`，落盘）→ ② 经 hub 队列发给 B：一行信封（任务文件路径、怎么交回执）+ Agora 页脚，页脚里有 `dispatch=<id>` 和 `agora-req-<id>` 标记 → ③ hub 在真正注入前调用一次 hook，`in_flight` 先落盘 → ④ B 的原生日志里出现带标记的用户消息 = 已接收，不需要 B 自己报；那一轮的结束记录 = 回合结束 → ⑤ B 用 `agora reply --request <id> --status done|failed|blocked` 交回执（HTTP，服务不在时写 `<id>/reply.md` + `reply.status` 文件，服务下次看到时接收），回合结束加回执才算 `done`/`failed`/`blocked`，只有回合结束没有回执是 `idle_no_reply`，回执晚到照样改状态 → ⑥ 通知 A 走同一个 hub 队列（A 忙时排队；记录才是事实，通知只是提示）。
- **状态**（词表同 `/runs` 的 `RunState`）：`dispatched`（已投出或还在排队；被输入权暂停时记录写明 `queuedBecause`，不算失败、不重发）· `running` · `waiting` · `done` · `failed` · `blocked` · `idle_no_reply` · `interrupted` · `unknown`。
- **回执通知**：`notified` 只表示通知已进了 A 的队列；重启时 `recover()` 对「已记为通知过、但 A 自己的日志里没有 `agora-receipt-<id>:<状态>` 标记」的记录再发一次（日志里有就不发），所以入队后服务崩溃不会让 A 永远等。钩子在注入前写盘失败（`hub` 报「没能交付」）时，这条记录（仍是 `pending`）记 `failed` 并写明原因，重启不再投递。
- **重启**：`recover()` 对每条没结束的记录跑 `plan_recovery`：没交出去的（`pending`）照常投；可能已注入的（`in_flight`）先读 B 的日志找标记，找不到记 `uncertain`，**绝不重发**；重启时还在跑的一轮记 `uncertain`（之后日志里出现结束记录仍会结算它）。
- **中断**（`agora dispatch interrupt <id>`）：撤销（之后不再投、结果不发布）；排队中的从队列拿走；无头运行取消，记 `interrupted`；终端 pane 里的一轮这里没有停止键，如实记 `unknown`，它迟到的结果留作证据、不发布、不通知 A。
- **评论交给 Agent**：页面 `POST /api/agent/dispatches`（`source.kind = "comment"`，正文就是评论消息，`inline`），服务端在那一轮结束时把答复贴回评论线程（`thread_op` 的 `reply`，并通知已打开的页面）；页面只发起、只显示，刷新页面不丢答复。评论的答复就是那一轮的最后一段话，不需要回执。
- **运行树**：`/runs?session=<A>` 里 A 派出的会话是 A 的子 run，`parent.via = "dispatch"`，`taskId` 是记录 id，state 直接取记录；`agora dispatch` 那次 shell 调用在父轨迹里是一次「派」。页面上：已派出等接手写「等 X 接手」，干活中（命令间隙算在想）、交回、停了但没交回执（`停了，没交回执`）、已中断各有说法，不用「闲」和对勾。被派的会话不再另画成一个顶层小人。
- **环境**：面板和被派的会话、tmux 服务器和 pane 里都不带 `SEEDMUX_*` 变量（`child_env`、`Terminals.open`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent/dispatches` | 创建：`{source, to \| new, task, scope?, model?, effort?, inline?, expectsReply?}`；`source` 是 `{kind: "session", sessionId}`（`agora dispatch`）、`{kind: "comment", canvasId, threadId, threadN}` 或 `{kind: "user"}`。来源是评论且投不出去时返回 409（页面据此让人换一个会话） |
| GET | `/api/agent/dispatches[?session=&active=1]`、`/{id}`、`/{id}/wait?timeout=` | 列表 / 状态 / 等到结束 |
| POST | `/api/agent/dispatches/{id}/reply` | `{status: done\|failed\|blocked, text, session?}`：回执 |
| POST | `/api/agent/dispatches/{id}/interrupt` | 撤销并停下能停的 |
| POST | `/api/agent/sessions/{sid}/takeover`、`/return` | 输入权（见 [Agent 会话 §4](../web/docs/agent-sessions.md)） |

`GET /events` 里的 `{"t": "dispatch", "dispatch": {…}}` 是每次状态变化的推送。运行树里的 `via: "dispatch"`：`parent.taskId` 是记录 id，run 的 `state` 直接取记录，`startedAt` 是对方接手（日志里出现标记）的时刻，没接手前为空；`dispatchSession` 是被派的 Agora 会话；父 run 的 `moments` 里 `dispatch` 挂在跑了 `agora dispatch` 的那次工具调用（`toolCallId`）上。

## 命令与 skill

`agora dispatch …`、`agora reply …` 见 `agora_cli/dispatch.py`；三个 CLI 共用的 skill 里的说明在 `skills/agora/references/dispatch.md`（`agora skill install` 装进项目）。Claude 的无头运行放行 `Bash(agora canvas|reply|dispatch *)`。

## 已知限制

- 只能派给 Pi / Claude Code / Codex 的会话（不派 Grok、Cursor、Devin）；不做多机、跨项目。
- 终端 pane 里的一轮不能从这里中断（只记 `unknown`）；无头协议还是一次性的 `-p` / `exec`，双向协议见 N2。
- 权限沿用各 CLI 自己的配置，记录里的 `permission` 只是说明这一次用的哪种；`--scope` 是提示，不是沙箱。
- 页面刷新后，评论线程上「Agent 在处理」的转圈不会恢复（答复照样贴回）。
