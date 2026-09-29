# Claude 无头会话：双向协议、auto 与「等你」

Agora 跑的 Claude Code 无头会话（面板里发的话、被派出去的任务）用同一种调用。事实来源是代码：`server/canvas/adapters/claude.py`（命令行、读请求、答复格式）、`server/canvas/agents.py`（进程与 stdin）、`server/canvas/sessions.py`（挂着的请求、中断、重启）。这里只写它们的约定和实测依据，不重复实现。

## 调用

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool stdio --permission-mode auto \
  (--session-id <uuid> | --resume <uuid>) [--model …] [--effort …] --allowedTools …
```

- 第一条用户消息以 stream-json 一行写进 stdin，**stdin 在这一轮里保持打开**，用来回 `control_response` 和发 `interrupt`；收到 `result` 后关掉，CLI 随之退出。一轮一个进程，和以前一样。
- 单用 `--permission-prompts host` 不会发请求；`--permission-prompt-tool` 只接 `stdio` 或 MCP 工具名（实测见 round-02 的 P2-spike）。
- **auto 不是每个模型都有**：Haiku 会静默回落成 `default`。会话头部读 init 事件里的 `permissionMode`，显示 `auto`，或「default（这个模型不支持 auto）」。没有 auto 时 CLI 会按 default 的规矩发审批请求。

## 什么会到 Agora 的界面

| 来源 | 线上的样子 | 界面 |
| --- | --- | --- |
| agent 用 `AskUserQuestion` 问你 | stdout `control_request`，`can_use_tool`，`tool_name: "AskUserQuestion"` | 问题卡片：选项 + 「回答」；小人和状态带显示「等你」 |
| 回落成 default 后要批准的工具 | `can_use_tool`，带 `permission_suggestions` | 审批卡片：允许 / 这个会话都允许 / 拒绝（可附一句话） |
| 被 auto 在 CLI 内部拦下的操作 | **不发请求**；只在 `result.permission_denials` 里 | 对话里一行「被 auto 拦下：<工具> <摘要>」 |
| 撤回 | `control_cancel_request` | 卡片消失 |

被拦下的操作没有可批的请求：auto 的分类器在 CLI 内部拒绝，宿主拿不到批准的机会（实测：`permission_denials` 有记录，0 个 `control_request`）。想让它做，用户再说一句换个做法。

## 答复格式（实测，Claude Code 2.1.284）

一行 JSON 写进 stdin：`{"type":"control_response","response":{"subtype":"success","request_id":<请求的 id>,"response":{…}}}`，`response` 是：

- 允许：`{"behavior":"allow","updatedInput":<请求的 input>}`
- 回答问题：`{"behavior":"allow","updatedInput":{…input, "answers":{"<问题原文>":"<选项 label>"}}}`（多选的几个 label 用 `, ` 连起来）。CLI 会告诉模型「Your questions have been answered…」。
- 这个会话都允许：允许的同时带 `updatedPermissions`，是请求里 `permission_suggestions` 原样回传，**`destination` 一律改成 `session`**（CLI 默认建议是 `localSettings`，会写进项目文件）。
- 拒绝：`{"behavior":"deny","message":"<原因>"}`，模型会收到这句话。

## 中断

`{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`。CLI 回 `control_response`，先对挂着的请求发 `control_cancel_request`，再以 `result`（`subtype: error_during_execution`，`terminal_reason: "aborted_tools"`）干净结束这一轮，进程和会话都还能继续用。Agora 把它当作正常的停止（对话里「已停止」），等 `result` 出来才算结束；15 秒内不结束才强行停进程。

## 挂着的请求是运行时事实

- 放在 `sessions.py` 的 `Live.requests`，不落盘；页面通过 `GET /api/agent/sessions/<sid>/requests` 和 SSE 的 `request` / `request_cancel` 事件拿到，`POST …/requests/<rid>` 回答（`decision`: `allow` | `allow_session` | `deny`）。
- 请求对应的工具调用在对话里被标成「等你」（`tool.waitsUser`），工位视图、状态带和 `WaitNotifier` 沿用这个标记；`AskUserQuestion` 本来就是。
- 这一轮等人的时间**不算**它的超时。
- 服务重启：挂着的请求随进程一起结束，绝不自动重放。每一轮启动时在 `.agora/run/headless/<sid>.json` 记下 CLI 进程；服务再起来时，仍然在跑同一条命令的进程被结束，对话里加一行「上一轮随服务重启中断了」，会话不再显示忙。

## 终端窗口和输入权

- 有不归 Agora 管的可写 tmux 窗口连着（例如「在终端打开」开的窗口），或人接管了终端，自动投递暂停、消息排队，哪怕 CLI 空闲。会话面板和小人的输入框写「终端窗口开着 · 你的话在排队」，并给「现在送出」和「接管 / 交回 Agora」。
- 「现在送出」= `POST …/deliver-now`：只放行排在最前的这一条（`gate_hold(force=True)`），下一条照旧等。
- 「终端已接管」只在真有窗口连着（或人明确接管）时显示。最后一个窗口断开（Ctrl-B D、关窗口）后，空闲的后台 CLI 在几秒后自动关掉，下一句走无头续接同一个原生会话；CLI 还在跑一轮就等它空闲；人明确接管的照旧保持到交回。从没有窗口连过的窗格不会被关。
