# Agent 会话：会话就是你自己的 Pi / Claude Code / Codex

Agora 里的一个会话，就是用户选定的原生 coding agent 的一个原生会话。没有「主控」和「worker」之分：在会话里和它讨论架构，它通过 agora-canvas skill 读图、改图、做算法动画；想直接写代码时「在终端打开」，同一个原生会话在终端里接着用，两边说的话互相同步。

只支持三个 agent：**Pi**、**Claude Code**、**Codex**。

实现：`server/canvas/agents.py`（三个后端、命令、日志位置、模型目录、skill 安装）、`server/canvas/transcript.py`（日志 → 会话记录）、`server/canvas/sessions.py`（路由、跟随、终端、画布桥接）、`server/canvas/terminal.py`（tmux）、`server/canvas/agent_router.py`（`/api/agent`）、`agora_cli/canvas.py`（`agora canvas` / `agora skill`）、`skills/agora-canvas/`；前端 `web/src/session/agents.ts`（事件流与发送）、`agentBridge.ts`（在页面上执行改图）、`SessionPane.tsx`。

## 1. 会话模型

| | |
|---|---|
| 选择 | 新会话先显示选择器：Pi / Claude Code / Codex、模型、强度。点「用 X 开始」后固定 |
| 锁定 | 绑定写在 `.agora/sessions/<id>.agent.json`：`{agent, model, effort, nativeId, createdAt}`，只由服务端写。`PUT /api/agent/sessions/<id>` 再次提交不同的 agent / 模型 / 强度返回 `409 {locked: true}`；`nativeId` 只能从空设一次。界面上没有修改入口，只显示 🔒 模型 · 强度 |
| 原生 id | Claude Code 和 Pi 在绑定时就分配 uuid（`--session-id`）；Codex 自己分配，第一轮（无头 `thread.started`，或终端里新起的 rollout）后写回 |
| 对话记录 | 以 CLI 自己的会话日志为准（见 §4），不另存一份；`.agora/sessions/<id>.jsonl` 只记这个会话里的画布修改（每次 `agora canvas apply/anim` 一条 turn，带整批撤销数据） |
| 删除 | 删除会话同时删绑定文件；撤销删除时用原来的 agent / 模型 / 强度 / 原生 id 重新绑定 |

会话面板只显示这一个 agent（名字就是 Pi / Claude Code / Codex）：对话（用户消息、agent 回复、工具调用可展开）、它改画布的卡片（撤销、在画布中高亮）、状态行（处理中 / 排队原因 / 出错）、「在终端打开」。来自终端的消息带「终端」标记。没有 @ 提及、没有派发步骤。

**画布评论「交给 Agent」**：交给这块画布上**最近活动**的已绑定会话（最近一次收发、改图或绑定的时间）。画布上还没有已绑定会话时，打开（或复用）一个未绑定会话让用户选 agent，选好后自动交出；选「先不交」则在线程里留一条系统消息。Agent 收到的是线程全文 + 锚点名字和 id（`web/src/comments/handoff.ts`）；它的最终答复贴回线程，线程消息链接到会话和它最后一次改图（撤销按钮撤的是那一批；一次评论里改了多批时，前面的批次在会话里逐条撤销）。

评测基线不变：`npm run eval` 仍走 `handToAgent` → `claude -p --json-schema` 在中性空目录里规划（`ClaudeCliBackend`，`/api/canvas/turns`），不经过会话。

## 2. 三个后端

都在**项目根目录**里运行（这是项目自己的 agent），环境里有 `AGORA_PROJECT`、`AGORA_SESSION`、`AGORA_CANVAS`，`bin/agora` 在 PATH 最前；启动 Agora 的那个 agent 的运行时标记（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION` 等，见 `agents._NESTED`）会被去掉——继承下来 Claude Code 会停止写会话日志，同步就断了。

| | 无头续接（Agora 发消息、终端没开） | 终端里的交互式续接 |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --session-id <uuid>`（首轮）/ `--resume <uuid>`，`--model`、`--effort`、`--allowedTools "Bash(agora canvas *)"`，提示词走 stdin | `claude --resume <uuid> --model … --effort …`（日志还不存在时 `--session-id`） |
| Pi | `pi -p --mode json --session-id <uuid> --model <provider/id> --thinking <level> --skill <repo>/skills/agora-canvas -- "<提示词>"` | `pi --session-id <uuid> --model … --models …（锁住 Ctrl+P 轮换）--thinking … --skill …` |
| Codex | `codex exec --json --skip-git-repo-check [-m] [-c model_reasoning_effort="…"] -`（首轮）/ `codex exec resume <id> --json … -`，提示词走 stdin | `codex resume <id> -m … -c model_reasoning_effort=…`（还没有 id 时 `codex`，id 从新 rollout 认领） |

事件统一映射成 runner 的事件流（`start` / `text` / `tool_use` / `tool_result` / `usage` / `result`，`result.raw` 是最终回复文字，`result.session` 是原生 id）：

| | 文字 | 工具 | 结束 / 失败 | usage |
|---|---|---|---|---|
| Claude | `assistant` 的 text 块 | `tool_use` / `user.tool_result` | `result`（`is_error`） | 每条消息 `usage`；结果行汇总与 `total_cost_usd` |
| Pi | `message_end`（assistant）的 text 块 | `toolCall` / `tool_execution_end` | `agent_settled`；`stopReason` error/aborted、重试用尽 | 每条 assistant 消息的 `usage`（含 `cost.total`），累加 |
| Codex | `item.completed` agent_message | `command_execution` started/completed，mcp/file_change | `turn.completed` / `turn.failed`、顶层 `error`（配置警告类 `error` item 不算失败） | `turn.completed.usage`（`input_tokens` 含缓存，报告时拆出 `cacheReadTokens`） |

模型列表（`GET /api/agent/catalog`）：Pi 用 `pi --list-models`，`~/.pi/agent/settings.json` 的 `enabledModels`（用户经 Magpie 网关的模型）排在前面、`defaultProvider/defaultModel` 为默认；Claude Code 给别名 `opus` / `sonnet` / `haiku`，加上 `~/.claude/settings.json` 的 `model`；Codex 读 `~/.codex/models_cache.json` 的 slug 和 `config.toml` 的 `model` / `model_reasoning_effort`。强度词表按 CLI：Claude `low…max`，Pi `off…max`，Codex `minimal…xhigh`；空 = CLI 默认。

一个会话同时只跑一轮无头续接，后来的消息排队；「停止」取消当前一轮。

## 3. agora-canvas skill 与 `agora canvas`

`skills/agora-canvas/SKILL.md`（操作说明）+ `references/ops.md`（改图操作）+ `references/animation.md`（动画脚本）+ `scripts/agora`（PATH 上没有 `agora` 时用，顺着软链接找到 Agora 仓库的 `bin/agora`），三个 CLI 共用一份。命令都输出一个 JSON 对象：

```bash
agora canvas list                     # 画布与会话
agora canvas read [--canvas id|名字]   # 模型视图（nodes/arrows/frames）+ base
agora canvas search redis             # 素材库
agora canvas apply --base r-… [--note "…"] <<'JSON'   # 类型化改图，一次可撤销
[{"op": "update_text", "id": "redis", "text": "Redis 集群"}]
JSON
agora canvas anim <<'JSON' … JSON     # 挂载算法动画
agora canvas schema ops|anim          # 精确 JSON Schema
```

退出码：0 成功 · 1 被拒（invalid / stale / error，见输出）· 2 用法错误 · 3 需要服务或打开的页面。

- **找项目**：`--project`，否则 `$AGORA_PROJECT`，否则向上找最近的 `.agora/config.toml`。画布默认 `$AGORA_CANVAS` → 会话关联的画布 → 聚焦画布 → 唯一画布。
- **读**：服务在跑且有页面打开时读页面上的实时场景（可能有还没落盘的编辑），否则读 `.agora/canvases/<id>.excalidraw`（`server/canvas/model_view.py`，与前端 `toModelView` 同构）。服务没开也能读。每次读把元素版本记到 `.agora/run/reads/<base>.json`。
- **写**：`apply` / `anim` 经服务转给**最近连接的页面**执行（页面持有画布）：库素材存在、`validatePlan`（schema + 引用）、按 `base` 查新鲜度（引用的元素在读取后被改过 → `stale`）、`applyPlan` 一批写入、记成会话里的一条 turn（撤销数据）、结果实时显示在画布和会话里。`anim` 先在服务端按 `anim.schema.json` 做结构校验，再由页面 `validateScript` 校验并挂播放器。服务没开或没有页面 → 退出码 3，提示先 `agora open`。
- **动画**是 skill 里的一项能力：用户要动画时 agent 自己写脚本调 `agora canvas anim`。没有专门按钮、弹窗或关键词规则；播放器与脚本校验不变。

**skill 放在哪（实测 2026-09-28）**：

| CLI | 加载方式 | `agora skill install` 做什么 |
|---|---|---|
| Claude Code | 项目 `.claude/skills/<name>/SKILL.md`（软链接可用） | 链接 `.claude/skills/agora-canvas` |
| Codex | 项目 `.agents/skills/`（软链接可用） | 链接 `.agents/skills/agora-canvas` |
| Pi | 启动参数 `--skill <dir>`；项目 `.agents/skills` 只在用户信任该项目后加载（print 模式下不信任就静默跳过） | 不放文件，Agora 每次启动 Pi 都带 `--skill` |

绑定会话时自动为该 agent 安装（`agora skill install --agent <x>` 可手动，`--copy` 复制而不是链接）。链接写进 `.git/info/exclude`，不出现在未跟踪文件里；不改任何用户全局配置。

## 4. 在终端打开与双向同步

**终端**：每个项目一个独立的 tmux 服务器 `tmux -L agora-<项目路径哈希>`，配置用 `.agora/run/tmux.conf`（不读 `~/.tmux.conf`），每个会话一个 tmux 会话 `agora-<会话 id>`，pane 里直接跑 §2 的交互式续接命令（不经 shell）：CLI 退出 = tmux 会话结束 = 不再持有。「在终端打开」创建或复用这个 pane，尝试用 Kitty（`kitty --detach`）打开窗口，没有 Kitty 用 macOS Terminal（`osascript`），并在面板上给出可复制的 `tmux -L … attach -t …`。「关闭终端」结束 pane 里的 CLI；`agora down` 关掉本项目的整个 tmux 服务器。无头一轮进行中不能打开终端（同一原生会话不能两个进程同时写）。

**终端 → 面板**：服务端每 0.4s 跟随原生会话日志（Claude `~/.claude/projects/*/<id>.jsonl`，Pi `~/.pi/agent/sessions/--<cwd>--/<时间>_<id>.jsonl`，Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`，按 id glob 定位），把新记录映射成会话条目推到页面（SSE `/api/agent/events`）。终端里敲的话、agent 的回复和工具调用都会出现在面板上。

**面板 → 终端**：Agora 发的消息末尾带一行上下文 `[[agora]] 来自 Agora · 画布「…」…`（面板显示时隐去，也用来标记来源）。pane 持有会话时：

1. 排队，直到 agent 这一轮答完（日志里看到回合结束）且终端 4 秒内没有按键（tmux `client_activity`）——面板状态行显示「排队中：…」原因。
2. `load-buffer` + `paste-buffer -p`（bracketed paste）+ Enter，和人粘贴回车一样。
3. 日志里出现这条用户消息即确认送达；它这一轮结束时把回复交给等待者（例如评论线程）。30 秒内日志里没出现 → 报「终端没有确认收到」。
4. 投递时 pane 已退出 → 这条改走无头续接。

pane 不在时一律无头续接（§2）。两边用的是同一个原生会话 id，所以哪边说的话另一边都接得上。

## 5. 接口（`/api/agent`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/catalog` | 三个 agent 的安装状态、模型、强度 |
| PUT | `/sessions/{id}` | 绑定 `{agent, model, effort, nativeId?}`；不同选择 409 |
| GET | `/sessions/{id}` | 状态（绑定、运行、排队、终端） |
| POST | `/sessions/{id}/send` | `{text, canvasId?, context?}` → `{sendId, route: terminal\|headless}` |
| POST | `/sessions/{id}/interrupt` | 停止当前无头一轮并清空排队 |
| POST / DELETE | `/sessions/{id}/terminal` | 打开（`{launch}`）/ 关闭终端 |
| GET | `/events?executor=1` | SSE：`transcript`、`status`、`delivered`、`done`、`bridge`（给执行页面） |
| POST | `/bridge/{rid}` | 页面回传 read/apply/anim 结果 |
| GET / POST | `/canvas/list`、`/canvas/read`、`/canvas/apply`、`/canvas/anim` | `agora canvas` 用 |

## 6. 限制

- **终端里仍能换模型**：锁定只管 Agora 这一侧；终端里用户自己 `/model` 切换，CLI 不提供禁止的开关（Pi 用 `--models` 把 Ctrl+P 轮换限制在选定模型）。下一次无头续接仍按绑定的模型启动。
- **首次进入不信任的目录**：Claude Code / Pi 在终端里会先问是否信任该目录，需要在终端里回答；这时从面板投递的消息会等到回合空闲判断之后才发，可能落进信任提示里。
- **输入到一半的草稿**：投递只在 4 秒无按键后进行；如果终端输入框里留着没发出去的半句话，粘贴会接在它后面。
- **写需要页面**：改图和动画由打开的 Agora 页面执行；只开终端、没开页面时 `apply` 返回退出码 3。
- **日志是同步通道**：CLI 关掉会话持久化（例如 Claude 的 `--no-session-persistence`，或继承到嵌套标记）时，面板看不到那边的对话。
- **Codex 终端先行**：还没有原生 id 的 Codex 会话在终端里开新会话，Agora 认领打开终端之后、同一项目目录下出现的第一个未被占用的 rollout；同一时间在同一目录另起 Codex 可能认错。
