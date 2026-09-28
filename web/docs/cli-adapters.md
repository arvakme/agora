# CLI 适配层：一个 CLI 一个文件，按能力分档

把「接一个 coding agent CLI」拆成可以分别实现的**能力**（找会话、读日志、分类工具、子 agent、无头运行、终端、模型目录、移动后怎么续），Agora 按一个 CLI 实现了哪些能力自动算出它的**档位**。现有的 Pi / Claude Code / Codex 原样搬进来（对照测试保证**原有输出**逐条相同；工具事实与子 agent 条目是有意的新增，见 §4），前端不再认工具名和 CLI 名字；每个适配器声明测过的版本，带按版本录制的样本和契约测试，`agora doctor --agents` 报告版本漂移和不认识的日志记录（只提示，不降级）。

实现：`server/canvas/adapters/`。旧入口 `agents.py`、`transcript.py` 保留原有名字，转发到适配器。

## 1. 档位

| 档 | 名字 | 需要的能力 | Agora 里能得到什么 | 现在是谁 |
|---|---|---|---|---|
| **T1** | 会话 agent | T2 全部 + `Headless`、`Interactive`、`Catalog`、`Binding` | 选择器、面板发消息、在终端打开、双向同步、花费 | Pi、Claude Code、Codex（用户定：只有这三家） |
| **T2** | 被观察的 agent | `Locator`、`Projector`、`ToolVocab`（可选 `Subagents`） | 只读轨迹、进度指针、工位小人 | Grok、Cursor（cursor-agent）、Devin（2026-09-29 起默认注册）；T1 的原生子 agent；找得到原生会话的 Seedmux worker |
| **T3** | 只有回执 | `ReceiptSource`（Seedmux 工单） | 状态带、回执（状态、改动文件、验收、reply 预览） | Seedmux 派出的、没有 T1/T2 适配器或找不到原生会话的 worker（agy、kimi、opencode…；本机没有它的会话记录的 worker） |
| **T0** | 推断 | 无 | 文件事件按 cwd、时间窗归属，一律标「推断」 | v2，未开始 |

- 档位 = 实现了的能力（`isinstance(a, Locator)` 等，`base.py` 的 runtime-checkable protocol），再被适配器的 `max_tier` 封顶（Devin、Cursor、Grok、Droid 写死 T2）。
- `session_kinds()`（= `agents.KINDS` = `project.AGENT_KINDS`）只返回 T1：选择器、绑定、会话历史都只认它们。
- 一个 run 的 `tier` 说的是 Agora 能对**这个 run** 做什么：Agora 会话是 T1；原生子 agent 即使是 Claude 的，也只能观察（T2）。

## 2. 代码地图

| 文件 | 内容 |
|---|---|
| `adapters/base.py` | 能力 protocol、`Adapter` 元数据（`kind`、`name`、`binaries`、`tested`、`max_tier`、`seedmux_names`、`log_dir`、`delete_hint`、`has_cost`、`waits`、`prunes_logs_after_days`、`catalog_per_project`、`terminal_fork`）、`VersionRange`、`NativeRef`、`ParentLink`、`tool_facts` |
| `adapters/common.py` | 转录条目的形状、`State`、`StreamMapper`、`LogLookup`、`Tail`（原 `transcript.py` / `agents.py` 里共用的部分） |
| `adapters/{claude,codex,pi}.py` | 三家 T1：`locate` / `new_since` / `sessions_for`、`project`、`classify`、`headless_args`、`interactive_argv` / `fork_argv`、`catalog`、`survives_move`（Pi：`migrate`）；Claude、Codex 另有 `children`（原生子 agent） |
| `adapters/{grok,cursor,devin}.py` | 三家 T2：`locate` / `sessions_for` / `log_cwd`、`project`、`record_type`、`classify`；Grok、Cursor 另有 `children`；Cursor、Devin 另有 `worker_for_ticket`（Seedmux 不知道 sid 的 worker）；Cursor 推断时间（`times_inferred`、`read_records`），Devin 的日志是 SQLite 里的行（`read_records`、`log_stat`、`sample_paths`） |
| `adapters/tools.py` | 共用的工具词表：`activity_of`（名字兜底）、`shell_reads`（shell 命令读了哪些文件）、`patch_files`（`*** Begin Patch` 文本写了哪些文件）、`spawn_in_output`（`smx-team` 打印的 `task=T-xx pane=<UUID>`）、`prompt_names_ticket` / `replies_to_ticket`（worker 是不是拿到了这张工单） |
| `adapters/registry.py` | `ADAPTERS`、`implemented_tier`、`info`（`AgentInfo`）、`adapter_infos`、`session_kinds`、`by_seedmux_name`、`cached_version` |
| `adapters/drift.py` | `probe` / `probe_all`（`agora doctor --agents`）、`observe`（跟随会话时计数）、`trust`（`.agora/agents.toml`） |
| `adapters/runs.py` | `AgentRun` 树与每个 run 的时间线（`/api/agent/runs`）、画布节点映射（移植 `codeLinks.ts`）；`log_stat`：日志不是文件时由适配器给出大小与最后写入时间（缓存与「运行中」） |
| `adapters/receipts.py` | Seedmux 工单作为回执（T3），连到派发它的 run；找得到 worker 的原生会话就升为 T2（§5.1） |
| `scripts/record_agent_fixture.py` | 录样本（§6） |

`sessions.py`、`discover.py`、`local.py`、`agent_router.py`、`project.py`、`agora_cli/` 里原来按 `kind ==` 写死的地方都改成问能力：

| 原来 | 现在 |
|---|---|
| `agent in ("claude", "pi")` 预分配 uuid | `assigns_id == "agora"` |
| Codex 首轮认领 rollout | `assigns_id == "cli"` → `new_native_since` |
| Codex 只能在终端分叉 | `not can_fork_headless`，提示用 `terminal_fork` |
| Claude 30 天清理提醒 | `prunes_logs_after_days` |
| 项目移动后迁移 Pi 日志 | `not survives_move` + `log_dir_name` + `migrate` |
| 按 kind 分目录扫历史 | 各自的 `sessions_for` |
| Pi 头部 cwd | `is_header` |
| Pi 的模型目录按项目缓存 | `catalog_per_project` |

## 3. 能力矩阵（已实现）

「✓」实现并有测试；「~」有但靠推断；「—」没有。

| | Claude Code 2.1.283 | Codex 0.157.1 | Pi 0.87.1 | Grok 1.0.41 | Cursor 2026.09.26 | Devin 3000.10.21 |
|---|---|---|---|---|---|---|
| 档位（上限） | T1（T1） | T1（T1） | T1（T1） | T2（T2） | T2（T2） | T2（T2） |
| 测过的版本 | `>=2.1.267,<2.2` | `>=0.149,<0.158` | `>=0.80,<0.88` | `>=1.0.40,<1.1` | `>=2026.09.26,<2026.11` | `>=3000.10.21,<3000.11` |
| 会话记录 | `~/.claude/projects/<目录>/<id>.jsonl` | `~/.codex/sessions/…/rollout-*.jsonl` + `state_5.sqlite` | `~/.pi/agent/sessions/--<目录>--/*.jsonl` | `~/.grok/sessions/<URL 编码目录>/<id>/updates.jsonl` | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`（不碰加密的 `chats/*/store.db`） | `~/.local/share/devin/cli/sessions.db`（SQLite，只读） |
| Locator | ✓ glob，优先项目目录的那份 | ✓ glob → 上次路径 → `state_5.sqlite` | ✓ 只认当前目录的文件夹 | ✓ glob `sessions/*/<id>/updates.jsonl` | ✓ glob `projects/*/agent-transcripts/<id>/`，同 id 多份时取工作区自己的 | ✓ 按 id 查 `sessions`；按 `working_directory` 列项目的会话 |
| Projector | ✓ | ✓（0.149+ 的 item_completed 格式） | ✓ | ✓ | ✓（时间 ~ 推断） | ✓（去重后的消息按自身时间排） |
| ToolVocab：activity | ✓ 按工具名 | ✓ `parsed_cmd` + shell 解析 | ✓ 按工具名 + shell 解析 | ✓ `x.ai/tool.kind` | ✓ 按工具名（随模型变）+ shell 解析 | ✓ 按工具名 + shell 解析 |
| ToolVocab：reads | ✓ Read、Bash | ✓ `cat`/`sed -n`/`head`/`nl`/`rg`/`rtk read`… | ✓ read、bash | ✓ read_file、run_terminal_command | ✓ Read / ReadFile、Shell / Bash（`working_directory`）、Grep 指向文件 | ✓ read、exec（`workdir`）、grep 指向文件 |
| ToolVocab：写 | ✓ Edit / Write… | ✓ FileChange | ✓ edit、write | ✓ write、search_replace… | ✓ Write、StrReplace、Delete、EditNotebook、ApplyPatch（解析 `*** Add/Update/Delete File:`） | ✓ write、edit、notebook_edit |
| ToolVocab：waitsUser | ✓ AskUserQuestion、ExitPlanMode | ~ 按名字（request_user_input） | ~ 按名字 | ~ ask_user_question | ~ AskQuestion | ~ ask_user_question |
| ToolVocab：spawn | ✓ Agent/Task（结果的 agentId）、smx-team 输出 | ✓ spawn_agent（SubAgentActivity / CollabAgentToolCall）、smx-team 输出 | ✓ smx-team 输出 | ✓ spawn_subagent（subagent_spawned） | ✓ Task / Subagent（没有结果，不记子 id） | ✓ run_subagent、smx-team 输出 |
| Subagents | ✓ `subagents/agent-*.jsonl` + meta | ✓ 父 rollout + `thread_spawn_edges` + 子 `session_meta`；隐藏 guardian | — | ✓ | ✓ `<id>/subagents/<子>.jsonl`，子的第一条提示 = 父 Task 的 `prompt` | —（`subagent_heads` 本机 0 行，只把子链排除出主轨迹） |
| Headless / Interactive / Catalog | ✓ | ✓（不能无头分叉） | ✓ | — | — | — |
| Binding | ✓ 全局续接 | ✓ 全局续接 | ✓ 需迁移（`migrate`） | 续接全局有效（实测），但 T2 不需要 | T2 不需要（chat id 属于工作区，换目录续接会静默开新会话） | T2 不需要（id 全局） |
| 日志格式版本 | 每行 `version` | `session_meta.cli_version` | 头部 `version`（3） | `summary.json` `chat_format_version`（1） | 无（只能看 `--version`） | `refinery_schema_history` 迁移号（17） |
| 花费 | 无头才有 | — | ✓ | ✓ `costUsdTicks` | —（只有 token） | —（token；SWE-2 免费） |
| 作为 Seedmux worker | 有 sid → 原生 run（T2） | 有 sid → 原生 run（T2） | 有 sid → 原生 run（T2） | 有 sid → 原生 run（T2） | 没有 sid：按工单找会话 → 原生 run（T2），§5.1 | 没有 sid：按工单找会话 → 原生 run（T2），§5.1 |

## 4. 工具事实（服务端加注）

每个 `tool` 条目除了原有的 `name` / `input` / `args` / `output` / `isError` / `files`，现在还有：

```ts
tool.activity   // "read" | "search" | "write" | "edit" | "commands" | "webFetch" | "webSearch" | "subagents" | "plan" | "questions" | "tools"
tool.reads      // string[]：读的文件，相对项目根目录
tool.waitsUser  // true：在等人（提问、审批门）
tool.spawn      // { childKind?, childId?, taskId?, pane?, role?, state?, via: "native" | "seedmux" }
```

前端 `toolActivity(item)` 优先用 `tool.activity`，工位时间线优先用 `tool.reads[0]` 和 `tool.waitsUser`；旧快照没有这些字段时退回 `activityOf(name)` / `readPath(input)`。

Codex 的 shell 读文件：先用 Codex 自己写的 `parsed_cmd`（`read` 带 path、`search`、`list_files`），剩下 `unknown` 的交给 `shell_reads`（按 `&& || ; |` 和换行拆开，跳过 heredoc，跟随 `cd`，认 `rtk read` / `rtk proxy`）。命令里只要有一段不是读或搜，activity 就是 `commands`，但读到的文件仍然列在 `reads` 里。重定向：`>` / `>>` 的目标是写、不是读（`cat > new.py <<'EOF'`、`head -5 a.py > b.py` 都是命令，后者只读 `a.py`）；`< a.py` 算读；`2>&1` 不拆命令。Seedmux 派发只认程序是 `smx-team`、子命令是 `spawn` / `assign` 的那次调用（按 shlex 解析，不是找子串；循环体 `do smx-team spawn …`、`if ! smx-team assign …` 也算）。

Cursor 与 Devin 的 shell 读文件同样交给 `shell_reads`，cwd 分别是 `Shell.working_directory` 与 `exec.workdir`；Cursor 上 Codex 系模型用 `ApplyPatch`（输入就是补丁文本）写文件，按 `*** Add File:` / `Update File:` / `Delete File:` / `Move to:` 解析（`patch_files`，op 与 Codex 的 FileChange 相同：`add` / `edit` / `delete`）。

**有意的行为变化**（不是「零变化」）：原有的输出字段逐条不变（对照测试），但下面这些是新增，会改变页面上的分类：

- Codex 用 shell 读文件（`sed -n`、`cat`、`nl`、`rg`…）原来一律算「执行命令」，现在按 `parsed_cmd` / shell 解析算「读」或「搜」，工位时间线上变成读片段、带文件路径；
- `waitsUser` 的调用（AskUserQuestion、ExitPlanMode、request_user_input…）在工位时间线上一律是「等待用户」片段，不再按名字猜；
- Codex 的子 agent 调用成为新的工具条目：`SubAgentActivity(started)`（0.153+）和 `CollabAgentToolCall`（0.157，`spawn_agent` / `wait` / `send_input` / `close_agent`），activity 都是 `subagents`，`spawn_agent` 带 `spawn.childId`；
- 各 CLI 的 `activity` 由服务端给出，前端的 `activityOf` / `readPath` 只剩旧快照兜底。

## 5. 接口

### `GET /api/agent/adapters` → `AgentInfo[]`

参数：`versions=0` 不跑 `--version`（页面用这个；结果缓存 10 分钟），`catalog=1` 给 T1 带上模型目录（和 `/api/agent/catalog` 相同）。

```ts
type AgentInfo = {
  kind: string; name: string;
  tier: "T1" | "T2" | "T3" | "T0"; maxTier: Tier;
  installed: boolean; version?: string;
  tested: string;        // "0.149–<0.158"
  testedSpec?: string;   // ">=0.149,<0.158"
  degraded?: { from: Tier; to: Tier; reason: string; trusted: boolean; enforced: false } | null;  // 只提示
  drift?: { unknown: Record<string, number>; records: number; versionOk: boolean | null; runtime: {...} | null };
  caps: { headless; terminal; catalog; subagents; forkHeadless; cost: boolean; waits: "native" | "inferred" | "none" };
  icon: { kind: "mark"; src: string };
  logDir: string;              // "~/.codex/sessions/"
  deleteCommand: string | null; // "codex delete {id}"；null = 删日志文件
  seedmuxNames: string[];
  catalog?: CatalogEntry;
};
```

前端：`loadAdapters()`、`agentName(kind)`、`sessionKinds()`（选择器只列 T1）、`logDirOf`、`deleteCommandOf`、`forkHeadless`；列表到之前用内置的三家兜底。`AgentKind` 现在是 `string`。

### `GET /api/agent/runs` → `RunTree`

参数：

- `session=<Agora 会话 id>`，或 `kind=<cli>&native=<原生 id>`（任何 Agora 读得到的原生会话）；
- `depth`：展开几层，默认 `all`（整棵树）；每个 run 带 `descendants`（它下面一共多少个 run），页面默认只显示一层、其余折叠成徽标（用户定）。给了数字就只展开到那一层，更深的只计数（`hiddenDescendants`、`folded`）；
- `canvas=<画布 id>`：按节点的 `customData.codePaths` 给每个片段标上 `node`（规则同 `web/src/pointer/codeLinks.ts`）；
- `items=1`：每个 run 带上它的转录条目（和会话面板同一形状，UI 可以直接 `buildLane`）；
- `receipts=0`：不附 Seedmux 工单（默认附上）。

```ts
type RunTree = { root: string; runs: AgentRun[]; folded: Record<string, number>; depth: number | null; generatedAt: number };
type AgentRun = {
  id: string;                       // "claude:<id>"、"claude:<父 id>/<agentId>"、"codex:<thread id>"、"smx:T-xx"（只有回执的 worker）
  kind: string; nativeId?: string; tier: Tier; sessionId?: string;
  label: string; role?: string; model?: string; depth: number;
  parent?: { runId: string; via: "native" | "seedmux" | "inferred"; toolCallId?: string; taskId?: string; evidence: string };
  cwd?: string; worktree?: string;  // cwd 不是项目根时（worktree、子目录）
  state: "dispatched" | "acknowledged" | "running" | "waiting" | "idle_no_reply" | "done" | "failed" | "blocked" | "exited" | "session_changed" | "unknown" | "idle";
  startedAt?: number | null; endedAt?: number | null; lastAt?: number | null; logPath?: string;
  childCount: number;               // 直接子 run
  descendants: number;              // 下面一共多少个 run（含没展开的）
  hiddenDescendants: number;        // depth=N 时没展开的
  receipt?: Receipt;                // Seedmux worker：见 §5.1
  timeline: {
    segments: { kind: "read" | "write" | "exec" | "think" | "wait"; start: number; end: number; itemId: string; turn: number; label: string; path?: string; node?: string; spawn?: {...} }[];
    turns: { n: number; start: number; end: number }[];
    moments: { kind: "dispatch" | "handoff" | "receipt"; at: number; childRunId?: string; toolCallId?: string; taskId?: string; state?: string }[];
    timesInferred?: true;
  };
  items?: Item[];
};
```

- `moments` 画在**父** run 上：`dispatch` 是父日志里派发它的那次工具调用（`toolCallId` 可以直接在父轨迹里定位），`handoff` 是回收（Claude 的同步结果或 `<task-notification>`，Codex 的 `CollabAgentToolCall(wait)` 完成 / `SubAgentActivity(completed)` / 索引边 `closed`）。
- 父子证据（`parent.evidence` 是给人看的一句话）：
  - Claude：父 `Agent` 调用的 `tool_use.id` = 子 `agent-<aid>.meta.json` 的 `toolUseId`；嵌套的看 `meta.parentAgentId`。
  - Codex：子 rollout `session_meta.source.subagent.thread_spawn.parent_thread_id`、索引 `thread_spawn_edges`、父 rollout 的 `SubAgentActivity` / `CollabAgentToolCall`；`source.subagent.other == "guardian"`（审批守卫线程）隐藏。
- 状态：CLI 自己说完成了的（结果、通知、边关闭）用它；否则日志 2 分钟内有写入算 `running`；在等人算 `waiting`；说不清的是 `unknown`，**不画成运行中**。
- 时间线片段在服务端按 `tool.activity` 算（与 `web/src/workstation/timeline.ts` 的对应相同）；想要思考段、并行调用排开等细节，用 `items=1` 在前端 `buildLane`。

前端类型与 `fetchRuns(sessionId, {depth, canvas, items, receipts})` 在 `web/src/session/agents.ts`；工位视图（`web/src/workstation/runs/derive.ts` 的 `fromTree`）用它画子小人、系绳、子泳道、回执带和交接（web/docs/workstation.md）。

### 5.0 安全

- **原生 id** 一律过 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`（且不含 `..`）：`/runs` 的 `native=`、每个适配器的 `locate`、工单里的 `sid`。不合格的 id 永远到不了路径或 glob。
- `kind=&native=` 只接受这个项目根和它的 git worktree 下的会话（各适配器的 `sessions_for`），别的项目的会话返回 404；`canvas=` 用 store 的画布 id 规则。
- owner 应用只回应本机 Host（`127.0.0.1`、`localhost`、`::1`、本机名，另可用 `AGORA_ALLOWED_HOSTS` 加）：别的 Host 返回 421、WebSocket 以 1008 关闭，防 DNS rebinding。分享网关是独立应用，不受影响。

### 5.1 Seedmux worker（T3 回执）

用户的常规用法是**一个主 agent 编排多个子 agent**（两个顶层 agent 同时改一个项目会被禁止），所以 `/runs?session=<主会话>` 把主会话经 Seedmux 派出的 worker 也放进同一棵树，worker 自己的原生子 agent、worker 再派出的 worker 也一样。

- **只读**（用户定）：`~/.seedmux/team/tasks/T-*/meta.json` 与 `delivery.json` 的核心键（`META_KEYS`、`DELIVERY_KEYS`；超过 256 KB 不读，符号链接的目录和文件跳过）、`reply.md` 的前 1200 字节，外加每 15 秒至多一次 `GET /panes`（找没写 sid 的 worker 的 pane）。绝不 send / capture / spawn / wake。只收 `meta.cwd` 在项目根、它的 git worktree（`git worktree list`）或其子目录下的工单。`AGORA_SEEDMUX_TASKS` 可改目录，`AGORA_SEEDMUX_PANES=0` 关掉 `/panes`（测试用）。
- **连到父 run**，证据从强到弱：
  1. 父 run 自己的日志里，`smx-team spawn/assign` 打印的 `task=T-xx pane=<UUID>`（工具事实的 `spawn.taskId`；`toolCallId` 就是那次 Bash 调用）。只认命令里跑了 `smx-team` 的那次调用的输出：`cat` / `grep` 旧日志打印出来的同样一行不算。一次调用派出几个 worker（一个脚本里几行 `smx-team spawn`）时，这次调用输出里的每一行 `task=` 都算（2026-09-29 在真实会话上发现只认了第一行，另两个 Cursor worker 因此不在树里）；
  2. `meta.from_pane` 是 Agora 记下的持有这个会话的 Seedmux pane（`.agora/run/seedmux/agora-<sid>.json`，且工单在会话活跃期间创建），或是树里某个 worker 的 `to_pane`——**只在那个 worker 占着这个 pane 的时间窗里**（派发到回复，或最后活动后 5 分钟）。Seedmux 会复用 pane（本机 869 张工单里 55 个 pane 被复用过，一个复用了 35 次），所以每个 pane 的每段占用都记下来，按时间匹配；
  3. `inferred`：`from_pane` 为空（派发者在 Agora 自己的 tmux 里）、cwd 对得上、在主会话活跃期间（首条记录到末条后 5 分钟）创建，且当时没有这个项目的别的 Agora 会话活跃。
- **worker 本身**：`delivery.sid` 或 `native.sid`（都过原生 id 检查）；没有时才用 `/panes` 里 `to_pane` 当前的 sid，而且只在这张工单是这个 pane（在所有项目里）最新的一张、还没有回复时——旧工单绝不拿 pane 现在的会话。找到的日志还必须记录它在项目根或其 worktree 里跑（`log_cwd`），否则不接（证据里写明）。Grok 的 worker 走这条（Seedmux 的 hook 记下 sid）。
- **没有 sid 的 worker**（Devin、Cursor：没有 hook，Seedmux 永远不知道它们的会话）：适配器的 `worker_for_ticket` 在 CLI 自己的记录里找——工单 cwd 下、工单开着时活着（创建不晚于回复、最后活动不早于派发，各留 2 分钟）、**并且拿到了这张工单**的会话：第一条提示里有工单号（Seedmux 的 worker 信封「你是 Seedmux agent team 的 worker,任务 T-xx」/「[team-task … task=T-xx]」），或自己跑过 `smx-team ack|reply T-xx`（续接的会话靠这条）。只看时间和目录不接；派发者打印出工单号（`task=T-xx pane=…`、`cat tasks/T-xx/…`）也不算。Devin 先用 SQL `LIKE` 过滤出提到工单号的会话再逐条核对；结果缓存 30 秒（页面轮询）。证据写进 `parent.evidence`（「worker 会话 … 在 Devin 的记录里按 cwd 与时间找到（第一条提示就是工单 T-xx）」）。
- 这样都满足、CLI 有 T1/T2 适配器 → 带完整轨迹的原生 run（`tier: "T2"`，它的原生子 agent 继续展开）；否则是 `smx:T-xx`（`tier: "T3"`，`kind` 是工单的 agent 名），只有状态和回执。
- **统一状态**：`meta.status` 的 `replied:done|failed|blocked` → `done|failed|blocked`（`replied:unknown` → `unknown`）；否则 `delivery.state`：`awaiting_ack`、`ack_overdue` → `dispatched`，`running_observed` → `running`，`waiting` → `waiting`，`idle_without_reply` → `idle_no_reply`，`exited_without_reply` → `exited`，`session_changed`，`reply_unconfirmed` / `unknown` → `unknown`；只有 `ack_at` → `acknowledged`；没有 delivery 记录的旧工单只在创建后 60 秒内算 `dispatched`，之后 `unknown`（**不画成运行中**）。有原生日志且 2 分钟内在写的 worker 算 `running`。
- **一个 worker 会话服务多张工单**（`resume_session`）：同一个 run，`receipts` 里按时间列出每一张，`receipt` 是最新一张；父 run 上每张工单都有自己的 dispatch / handoff 时刻。
- **回执**：

```ts
type Receipt = { taskId: string; agent: string; cwd?: string; createdAt?: number; repliedAt?: number;
  status?: string;          // meta.status 原样
  seedmuxState?: string;    // delivery.state 原样
  state: RunState;          // 上面的统一状态
  toPane?: string; fromPane?: string; sid?: string;
  changed?: string[];       // meta.verify.changed
  accept?: string | null;   // meta.verify.accept：replied:done 不等于验收通过，分开显示
  replyPreview?: string; replyPath?: string };
```

- **时刻**：父 run 上 `dispatch`（工单 `created_at`，带 `taskId`、`toolCallId`）和 `handoff`（`replied_at`，终态时）；worker 自己的时间线上有一个 `receipt`（`replied_at`）。
- 2026-09-28 对本机真实工单只读验证：T-19c9ab（Devin，T3）与 T-dfa7cb（Claude worker，经 delivery sid 找到日志）都按第 1 条证据连回派发它们的会话。
- 2026-09-29 再验（只读，改动前后对照）：T-19c9ab、T-6e7926（Devin）从 `smx:` T3 变成 `devin:<会话>` T2（392 / 193 个片段）；T-a824d2、T-c4c895（Cursor）原来因为同一次调用派了三个 worker 而不在树里，现在是 `cursor:<chat id>` T2（283 / 204 个片段，时间推断）；T-d56b48（Grok）从 T3 变成 `grok:<id>` T2（100 个片段）。

## 6. 跟上 CLI 的更新

**测过的版本**：每个适配器的 `tested`。**日志词表**：每个 Projector 写明 `handled_types`（投影成条目的）、`ignored_types`（看过、有意不显示的）、`gap_types`（认识但还没处理的，比如 Codex 0.149 以前的旧事件格式）；三者之外的都算漂移。词表按本机 2026-09-28 的全部日志整理（Claude 2.1.267–2.1.283、Codex 0.125–0.157、Pi 格式 v3、Grok 1.0.41），2026-09-29 补上 Grok 1.0.41 的 `memory_flush_*` / `memory_session_saved`、Cursor（263 份 agent-transcripts：记录只有 `user` / `assistant` / `turn_ended`，内容块只有 `text` / `tool_use`，别的块类型记成 `<role>/<块类型>` 算漂移）与 Devin（245 个会话：`system` / `user` / `assistant` / `tool`）。

**`agora doctor --agents`**（`--json` 可选）：对每个适配器跑 `--version` 对照 `tested`；抽样最近 12 份原生日志（Codex 另按索引里每个 CLI 版本各取最新一份），统计不认识的记录类型和已知缺口；读日志内的格式版本；打印一张表和每个 CLI 的「怎么办」。只读、只在本机。退出码：**1** 只在某个已安装的 CLI 会被降级（版本不在测过的范围，或不认识的记录超过 5%）且项目没有写 `trust_untested` 时；**0** 其余情况，包括低于阈值的不认识记录（输出里标「只提示」）。

```
CLI          安装  版本        测过的范围           档位  日志格式  抽样              不认识的记录
Pi           是    0.87.1      0.80–<0.88           T1    v3        12 份 / 1190 条   —
Claude Code  是    2.1.284     2.1.267–<2.2         T1    —         12 份 / 17577 条  —
Codex        是    0.157.1     0.149–<0.158         T1    —         40 份 / 17900 条  —
Grok         是    1.0.41      1.0.40–<1.1          T2    v1        12 份 / 7018 条   —
Cursor       是    2026.9.26   2026.09.26–<2026.11  T2    —         12 份 / 854 条    —
Devin        是    3000.10.21  3000.10.21–<3000.11  T2    v17       12 份 / 3188 条   —
· Codex：认识但还没处理的记录：event_msg/agent_message ×562、event_msg/user_message ×114、…
```

Devin 的日志不是文件：抽样是 `sessions` 里最近活动的 12 个会话（`sample_paths`），逐条读法同 run 时间线（`read_records`，每个会话至多 8 MB）；日志格式是迁移号。

**运行时**：`sessions._follow` 每读到一条记录就 `drift.observe(kind, rec)` 计数；`/api/agent/adapters` 的 `drift.runtime` 给出。

**只提示，不降级**（用户定）：`degraded = {from, to, reason, trusted, enforced: false}`。不认识的记录超过 5%、或版本不在范围内时给出「会降为 T2」和原因；什么行为都不变。在项目的 `.agora/agents.toml` 里写

```toml
[codex]
trust_untested = true
```

接受这个版本（仍然提示，标「已信任」）。观察一段时间没有误报后，再决定是否打开真的降级（§9）。

**样本与契约测试**：

- 目录 `tests/fixtures/agents/<kind>/<version>/`：`log.jsonl`（Grok 是 `updates.jsonl`）、`stream.jsonl`、`meta.json`；子 agent 的日志在 `subagents/`（Claude、Cursor）或 `children/`（Codex、Grok）。Devin 没有文件日志：`log.jsonl` 是这个会话在 `message_nodes` 里的原始行（整片森林，含重复存的消息），另有 `session.json`（`sessions` 那一行与迁移号）和 `schema.sql`（录制时的建表语句），契约测试用它们在临时 HOME 里建一个 `sessions.db`。Cursor 与 Devin 没有 stream（Devin 的 `-p` 只输出纯文本）或 stream 只作参考。旧版本保留。`unversioned/` 是 2026-09-27 去掉了版本字段的旧样本。
- `tests/test_adapter_contracts.py` 参数化到每个 kind × 每个版本：临时 HOME 里找得到会话；投影出一轮；**没有 `meta.json` 的 `expected_unknown` 之外的未知记录**；`expected` 写的文件（整棵 run 树里）、读的文件（`reads`）、shell 命令（按各 CLI 的 shell 工具名计数，或 `meta.json` 的 `command_tools`）、子 agent 数都满足。每个 T1/T2 适配器必须至少有一份样本。现有样本：Claude 2.1.283、Codex 0.157.1、Pi（unversioned）、Grok 1.0.41（子 agent 写文件 + `ls`）、Cursor 2026.9.26 与 Devin 3000.10.21（读 `alpha.txt`、`cat beta.txt`、写 `gamma.txt`）。
- `tests/test_adapter_parity.py`：`tests/legacy/` 冻结了搬迁前（12f78eb）的实现，对所有样本比对新旧输出逐条相同（新增的工具事实键和新增的 spawn 条目剥掉后比较）。`AGORA_PARITY_REAL=1` 另拿本机最新的真实日志只读比对。

**录样本**：`agora doctor --agents --record <kind>`（= `uv run python scripts/record_agent_fixture.py <kind>`）。在 `/tmp/agora-record-<kind>-*` 的空 git 目录里用最便宜的模型跑固定提示（Claude、Codex、Grok：一个子 agent 写 `hello.txt`，自己再 `ls`；Cursor（`gpt-5.3-codex-low`）、Devin（`swe-2-medium`，免费）：用读工具读 `alpha.txt`、`cat beta.txt`、写 `gamma.txt`），然后：

1. 复制日志并脱敏：临时目录 → `/work/project`（Cursor 的工作区文件夹名同样替换），家目录 → `/home/user`；去掉 CLI 抄进日志的私人内容（CLAUDE.md / AGENTS.md、记忆、skill 与 MCP 清单、会话上下文、hook 命令、`available_commands`；Cursor 的上下文块；Devin 的 system 消息、非提问的 user 消息、它们的扩展字段，以及 `sessions.cogs_json`——CLI 的系统提示与用户的权限规则），**保留每条记录的类型**；仍有用户名等私人字符串就拒绝写入；Devin 只读地导出这个会话的行；
2. 写 `meta.json`：`expected` 从录到的日志本身得出（写了、读了哪些文件，跑没跑 shell），`expected_unknown` 列出这次遇到的未知记录（提交前要人看一眼）；
3. 用 CLI 自己的删除命令（`codex delete`、`grok sessions delete`、`devin rm --force`）或删文件（Cursor：这个临时目录的工作区文件夹与 `chats/<md5>`），清掉这次产生的全部原生会话；Devin 这次写的诊断日志（提到这个会话或临时目录的）一并删掉，别的列出；
4. 把 CLI 往配置里加的信任条目（Codex 会在 `~/.codex/config.toml` 末尾加 `[projects."<tmp>"] trust_level = "trusted"`；Devin 的 `trusted_paths`）逐字节还原；别的进程同时改过的文件只删我们那条并如实报告（JSON 配置报出变了哪些键，比如 Cursor 每次运行都刷新的 `privacyCache`）。只快照这些配置（`TRUST_FILES`），从不读凭据文件；
5. 停掉工作目录在临时目录里的遗留进程（cursor-agent `-p` 结束后仍留着 `worker-server` 与一个 TypeScript 语言服务），删掉临时目录。

它会花钱（每次几美分），所以**不定时运行**（用户定：默认关，只能在 doctor 里手动触发）。

## 7. 加一个新 CLI

1. 新建 `server/canvas/adapters/<kind>.py`：`Adapter` 子类，写 `kind`、`name`、`binaries`、`tested`、`max_tier`（被观察的写 `"T2"`）、`seedmux_names`、`log_dir`、`delete_hint`、`has_cost`、`waits`。
2. T2 起步实现：`locate`、`sessions_for`、`log_cwd`、`project`（产出 `transcript.py` 的条目形状，工具条目带 `tool_facts`）、`record_type`、`handled_types` / `ignored_types` / `gap_types` / `known_types`、`classify`。有原生子 agent 再加 `children`，返回带 `ParentLink(via="native", evidence=…)` 的 `NativeRef`。日志不是 JSONL 的（SQLite 等）：`read_records(path, limit)`（run 时间线、漂移扫描、契约测试都用它）、`log_stat(path)`（缓存与「运行中」）、`sample_paths(home, n)`（doctor 抽样）、`fixture_place(folder, home, cwd, nid)`（契约测试）。日志没有时间的：`read_records` 给每条记录 `_at` / `_end`，并设 `times_inferred = True`。Seedmux 不知道 sid 的：`worker_for_ticket(rc)` 返回 `(原生 id, 路径, 理由)`，只在会话确实拿到了这张工单时（§5.1）。
3. 在 `registry.py` 的 `BUILTIN` 里注册（顺序：先 T1，再被观察的）。
4. 在 `scripts/record_agent_fixture.py` 的 `PROMPTS` / `MODELS` / `argv` / `*_collect` 里加上它，跑一次 `agora doctor --agents --record <kind>`，检查 `meta.json`（尤其 `expected_unknown`）和脱敏结果后提交样本。契约测试自动覆盖。
5. 头像：`web/src/session/AgentAvatar.tsx` 里没有画的 CLI 显示首字母；要正式的标志，放进 `web/src/app/agents/marks.tsx` 并写进 README「许可与致谢」。
6. 能被 Seedmux 派出的：确认工单 `meta.agent` 的名字写在 `seedmux_names` 里（`cursor-agent` → `cursor`）；Seedmux 记不下它的 sid 时实现 `worker_for_ticket`。
7. 跑 `agora doctor --agents`，把输出贴进 PR。

不做：替 CLI 改配置、装 hook、写信任记录；调用会上传数据的子命令（`grok trace` 之类）；从终端屏幕文字判断状态。

## 8. 用户已定

- T1 会话 agent 只有 Pi、Claude Code、Codex；Devin、Cursor（cursor-agent）、Grok、Droid 只做子 agent（T2/T3/T0）。
- 常规用法是一个主 agent 编排多个子 agent（原生子 agent 或 Seedmux worker）；两个顶层 agent 同时改一个项目很少见，之后会被禁止。所以 run 树以主会话为根。
- Seedmux 只读：`meta.json` 核心键、`delivery.json` 核心键、`reply.md`，外加一次 `GET /panes`；只收 cwd 是本项目根或其 worktree 的工单；绝不 send / capture / spawn / wake。
- Devin 的 `sessions.db` 可以只读查询，契约测试兜底；Cursor 只读 agent-transcripts，不碰 `store.db`。
- T0 只在有 Seedmux worker 或未归属 pane 活跃时开启，一律标「推断」。
- 定时重录默认关；漂移先只提示，每个 CLI 可 `trust_untested`；子 agent 默认显示一层。
- agy、kimi、opencode、cursor（非 agent）不做。

## 9. v2 待办

v1 = 上面 §1–§7（步骤 0–6 与 8：适配层、工具事实、漂移、原生子 agent、Seedmux 回执）。以下是 v2，按设计稿的顺序；调研依据是 2026-09-28 的设计稿《Agora 的 CLI 适配层》与原始调研附录（agora-cli-adapters-research.md，A–F 节），要点摘在每项里。

**2026-09-29 已完成**（原第 2–5 项）：Grok 默认注册（契约与本机 1.0.41 相符，漂移只多了三种 memory 记录，已列入 `ignored_types`）；Cursor、Devin 适配器（T2，§3），各有真实样本；没有 sid 的 Seedmux worker 按工单找到原生会话（`worker_for_ticket`，§5.1）；同一次调用派出的多个 worker 都连回父 run。

1. **工位视图（步骤 7）**：子小人、系绳、子泳道、派发 / 交接、回执带已接上（web/docs/workstation.md）；还没做的：回执预览（`reply.md`）、超过一层折叠成 `descendants` 徽标。服务端还缺：run 树变化时的 SSE（现在只能轮询）、`items=1` 大会话的分页。
2. **Devin 的原生子 agent**：`run_subagent` 的链在同一个会话的森林里（`subagent_heads` 指向链头），本机 0 行、没有真实样本，所以现在只把子链的消息排除出主轨迹，没有做成子 run。等出现真实数据后按链头拆成 `devin:<会话>/<agent_id>`。
3. **Cursor 的时间**：transcript 没有逐条时间，现在按「用户消息的分钟级时间戳 + 文件创建 / 修改时间」均摊（`timesInferred`，界面标推断）。更准的来源是 `stream-json`（有 `timestamp_ms`），只有 Agora 自己启动 cursor-agent 时才拿得到。工具结果（成败、输出）只在加密的 `store.db` 里，按用户决定不读：Cursor 的工具条目没有输出，也不知道失败。
4. **「运行中」的判定**：日志 2 分钟内有写入就算 `running`（`RUNNING_S`），刚结束的会话也会显示两分钟「运行中」。Devin 的最后写入时间是 `sessions.last_activity_at`（看起来按回合落盘，长工具调用期间可能不刷新）。
5. **Droid（步骤 12）**：附录 E。等用户登录并在 Seedmux 的 `agents.json` 里配上后再做：`~/.factory/sessions/-<cwd 仅 "/"→"-">/<id>.jsonl`（头部 `version: 2`），子 agent 头部 `callingSessionId` / `callingToolUseId` 直接指向父 tool_use；`droid exec` 失败时退出码仍为 0，要看 `error` 事件。先录样本，再写投影。
6. **T0 兜底（步骤 13）**：FSEvents + `git diff --name-only` 快照差，按 cwd 与时间窗归属到当时唯一活跃的 pane / 进程，否则显示为「未归属的改动」；只在有 Seedmux worker 或未归属 pane 活跃时开启。
7. **漂移后续**：观察一周没有误报后，决定是否打开真的降级（`degraded.enforced`）；面板顶部的一次性提示（「Codex 0.158 出现了 Agora 不认识的记录…」）；可选的周任务重录（默认关，花钱）。
8. **已知缺口**：
   - Codex 0.149 以前的旧格式（`event_msg/user_message`、`agent_message`、`exec_command_end`、`patch_apply_end`…）只投影出回合边界，没有消息和工具调用：老会话的轨迹不全（`gap_types`，doctor 会报）。
   - Codex 的 `world_state`（0.144 起，每轮的上下文快照）有意不投影（`ignored_types`；模型与强度仍从 `turn_context` 来）。
