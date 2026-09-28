# CLI 适配层：一个 CLI 一个文件，按能力分档

把「接一个 coding agent CLI」拆成可以分别实现的**能力**（找会话、读日志、分类工具、子 agent、无头运行、终端、模型目录、移动后怎么续），Agora 按一个 CLI 实现了哪些能力自动算出它的**档位**。现有的 Pi / Claude Code / Codex 原样搬进来（对照测试保证逐条相同），前端不再认工具名和 CLI 名字；每个适配器声明测过的版本，带按版本录制的样本和契约测试，`agora doctor --agents` 报告版本漂移和不认识的日志记录（只提示，不降级）。

实现：`server/canvas/adapters/`。旧入口 `agents.py`、`transcript.py` 保留原有名字，转发到适配器。

## 1. 档位

| 档 | 名字 | 需要的能力 | Agora 里能得到什么 | 现在是谁 |
|---|---|---|---|---|
| **T1** | 会话 agent | T2 全部 + `Headless`、`Interactive`、`Catalog`、`Binding` | 选择器、面板发消息、在终端打开、双向同步、花费 | Pi、Claude Code、Codex（用户定：只有这三家） |
| **T2** | 被观察的 agent | `Locator`、`Projector`、`ToolVocab`（可选 `Subagents`） | 只读轨迹、进度指针、工位小人（UI 待做） | T1 的原生子 agent；Grok（v2，默认关闭） |
| **T3** | 只有回执 | `ReceiptSource`（Seedmux 工单） | 状态带、回执里的改动文件 | v2，默认关闭 |
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
| `adapters/tools.py` | 共用的工具词表：`activity_of`（名字兜底）、`shell_reads`（shell 命令读了哪些文件）、`spawn_in_output`（`smx-team` 打印的 `task=T-xx pane=<UUID>`） |
| `adapters/registry.py` | `ADAPTERS`、`implemented_tier`、`info`（`AgentInfo`）、`adapter_infos`、`session_kinds`、`by_seedmux_name`、`cached_version` |
| `adapters/drift.py` | `probe` / `probe_all`（`agora doctor --agents`）、`observe`（跟随会话时计数）、`trust`（`.agora/agents.toml`） |
| `adapters/runs.py` | `AgentRun` 树与每个 run 的时间线（`/api/agent/runs`）、画布节点映射（移植 `codeLinks.ts`） |
| `adapters/experimental.py` | v2 开关：`AGORA_EXPERIMENTAL=grok,seedmux-receipts`（或 `all`） |
| `adapters/grok.py`、`adapters/receipts.py` | v2，默认关闭（§9） |
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

「✓」实现并有测试；「~」有但靠推断；「—」没有；「v2」写好了但默认关闭。

| | Claude Code 2.1.283 | Codex 0.157.1 | Pi 0.87.1 | Grok 1.0.41（v2） |
|---|---|---|---|---|
| 档位（上限） | T1（T1） | T1（T1） | T1（T1） | T2（T2） |
| 测过的版本 | `>=2.1.267,<2.2` | `>=0.149,<0.158` | `>=0.80,<0.88` | `>=1.0.40,<1.1` |
| Locator | ✓ glob，优先项目目录的那份 | ✓ glob → 上次路径 → `state_5.sqlite` | ✓ 只认当前目录的文件夹 | ✓ glob `sessions/*/<id>/updates.jsonl` |
| Projector | ✓ | ✓（0.149+ 的 item_completed 格式） | ✓ | ✓ |
| ToolVocab：activity | ✓ 按工具名 | ✓ `parsed_cmd` + shell 解析 | ✓ 按工具名 + shell 解析 | ✓ `x.ai/tool.kind` |
| ToolVocab：reads | ✓ Read、Bash | ✓ `cat`/`sed -n`/`head`/`nl`/`rg`/`rtk read`… | ✓ read、bash | ✓ read_file、run_terminal_command |
| ToolVocab：waitsUser | ✓ AskUserQuestion、ExitPlanMode | ~ 按名字（request_user_input） | ~ 按名字 | ~ ask_user_question |
| ToolVocab：spawn | ✓ Agent/Task（结果的 agentId）、smx-team 输出 | ✓ spawn_agent（SubAgentActivity / CollabAgentToolCall）、smx-team 输出 | ✓ smx-team 输出 | ✓ spawn_subagent（subagent_spawned） |
| Subagents | ✓ `subagents/agent-*.jsonl` + meta | ✓ 父 rollout + `thread_spawn_edges` + 子 `session_meta`；隐藏 guardian | — | ✓ |
| Headless | ✓ | ✓（不能无头分叉） | ✓ | — |
| Interactive | ✓ | ✓ | ✓ | — |
| Catalog | ✓ | ✓ | ✓（按项目） | — |
| Binding | ✓ 全局续接 | ✓ 全局续接 | ✓ 需迁移（`migrate`） | 续接全局有效（实测），但 T2 不需要 |
| 日志格式版本 | 每行 `version` | `session_meta.cli_version` | 头部 `version`（3） | `summary.json` `chat_format_version`（1） |
| 花费 | 无头才有 | — | ✓ | ✓ `costUsdTicks` |

## 4. 工具事实（服务端加注）

每个 `tool` 条目除了原有的 `name` / `input` / `args` / `output` / `isError` / `files`，现在还有：

```ts
tool.activity   // "read" | "search" | "write" | "edit" | "commands" | "webFetch" | "webSearch" | "subagents" | "plan" | "questions" | "tools"
tool.reads      // string[]：读的文件，相对项目根目录
tool.waitsUser  // true：在等人（提问、审批门）
tool.spawn      // { childKind?, childId?, taskId?, pane?, role?, state?, via: "native" | "seedmux" }
```

前端 `toolActivity(item)` 优先用 `tool.activity`，工位时间线优先用 `tool.reads[0]` 和 `tool.waitsUser`；旧快照没有这些字段时退回 `activityOf(name)` / `readPath(input)`。

Codex 的 shell 读文件：先用 Codex 自己写的 `parsed_cmd`（`read` 带 path、`search`、`list_files`），剩下 `unknown` 的交给 `shell_reads`（按 `&& || ; |` 和换行拆开，跳过 heredoc，跟随 `cd`，认 `rtk read` / `rtk proxy`）。命令里只要有一段不是读或搜，activity 就是 `commands`，但读到的文件仍然列在 `reads` 里。

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
- `depth`：展开几层，默认 `1`（用户定：默认一层，更深的折叠成徽标），`all` 全部；
- `canvas=<画布 id>`：按节点的 `customData.codePaths` 给每个片段标上 `node`（规则同 `web/src/pointer/codeLinks.ts`）；
- `items=1`：每个 run 带上它的转录条目（和会话面板同一形状，UI 可以直接 `buildLane`）；
- `receipts=0`：不附 Seedmux 工单（v2 开关打开时才有意义）。

```ts
type RunTree = { root: string; runs: AgentRun[]; folded: Record<string, number>; depth: number | null; generatedAt: number };
type AgentRun = {
  id: string;                       // "claude:<id>"、"claude:<父 id>/<agentId>"、"codex:<thread id>"、"smx:T-xx"（v2）
  kind: string; nativeId?: string; tier: Tier; sessionId?: string;
  label: string; role?: string; model?: string; depth: number;
  parent?: { runId: string; via: "native" | "seedmux" | "inferred"; toolCallId?: string; taskId?: string; evidence: string };
  cwd?: string; worktree?: string;  // cwd 不是项目根时（worktree、子目录）
  state: "dispatched" | "acknowledged" | "running" | "waiting" | "idle_no_reply" | "done" | "failed" | "blocked" | "exited" | "session_changed" | "unknown" | "idle";
  startedAt?: number | null; endedAt?: number | null; lastAt?: number | null; logPath?: string;
  hiddenDescendants: number; childCount: number;
  receipt?: Receipt;                // v2
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

前端类型与 `fetchRuns(sessionId, {depth, canvas, items})` 在 `web/src/session/agents.ts`；**还没有界面消费它**（工位视图的子小人、系绳、子泳道是下一步，§9）。

## 6. 跟上 CLI 的更新

**测过的版本**：每个适配器的 `tested`。**日志词表**：每个 Projector 写明 `handled_types`（投影成条目的）、`ignored_types`（看过、有意不显示的）、`gap_types`（认识但还没处理的，比如 Codex 0.149 以前的旧事件格式）；三者之外的都算漂移。词表按本机 2026-09-28 的全部日志整理（Claude 2.1.267–2.1.283、Codex 0.125–0.157、Pi 格式 v3、Grok 1.0.41）。

**`agora doctor --agents`**（`--json` 可选）：对每个适配器跑 `--version` 对照 `tested`；抽样最近 12 份原生日志（Codex 另按索引里每个 CLI 版本各取最新一份），统计不认识的记录类型和已知缺口；读日志内的格式版本；打印一张表和每个 CLI 的「怎么办」。只读、只在本机。有漂移或版本不在范围内时退出码 1。

```
CLI          安装  版本     测过的范围    档位  日志格式  抽样              不认识的记录
Pi           是    0.87.1   0.80–<0.88    T1    v3        12 份 / 772 条    —
Claude Code  是    2.1.283  2.1.267–<2.2  T1    —         12 份 / 15381 条  —
Codex        是    0.157.1  0.149–<0.158  T1    —         40 份 / 17900 条  world_state×45
· Codex：不认识的记录类型：world_state ×45（轨迹里被跳过）
· Codex：认识但还没处理的记录：event_msg/agent_message ×562、event_msg/user_message ×114、…
```

**运行时**：`sessions._follow` 每读到一条记录就 `drift.observe(kind, rec)` 计数；`/api/agent/adapters` 的 `drift.runtime` 给出。

**只提示，不降级**（用户定）：`degraded = {from, to, reason, trusted, enforced: false}`。不认识的记录超过 5%、或版本不在范围内时给出「会降为 T2」和原因；什么行为都不变。在项目的 `.agora/agents.toml` 里写

```toml
[codex]
trust_untested = true
```

接受这个版本（仍然提示，标「已信任」）。观察一段时间没有误报后，再决定是否打开真的降级（§9）。

**样本与契约测试**：

- 目录 `tests/fixtures/agents/<kind>/<version>/`：`log.jsonl`（Grok 是 `updates.jsonl`）、`stream.jsonl`、`meta.json`；子 agent 的日志在 `subagents/`（Claude）或 `children/`（Codex、Grok）。旧版本保留。`unversioned/` 是 2026-09-27 去掉了版本字段的旧样本。
- `tests/test_adapter_contracts.py` 参数化到每个 kind × 每个版本：临时 HOME 里找得到会话；投影出一轮；**没有 `meta.json` 的 `expected_unknown` 之外的未知记录**；`expected` 写的文件（整棵 run 树里）、shell 命令、子 agent 数都满足。每个 T1/T2 适配器必须至少有一份样本。
- `tests/test_adapter_parity.py`：`tests/legacy/` 冻结了搬迁前（12f78eb）的实现，对所有样本比对新旧输出逐条相同（新增的工具事实键和新增的 spawn 条目剥掉后比较）。`AGORA_PARITY_REAL=1` 另拿本机最新的真实日志只读比对。

**录样本**：`agora doctor --agents --record <kind>`（= `uv run python scripts/record_agent_fixture.py <kind>`）。在 `/tmp/agora-record-<kind>-*` 的空 git 目录里用最便宜的模型跑固定提示（一个子 agent 写 `hello.txt`，自己再 `ls`），然后：

1. 复制日志并脱敏：临时目录 → `/work/project`，家目录 → `/home/user`；去掉 CLI 抄进日志的私人内容（CLAUDE.md / AGENTS.md、记忆、skill 与 MCP 清单、会话上下文、hook 命令、`available_commands`），**保留每条记录的类型**；仍有用户名等私人字符串就拒绝写入；
2. 写 `meta.json`，`expected_unknown` 列出这次遇到的未知记录（提交前要人看一眼）；
3. 用 CLI 自己的删除命令（`codex delete`、`grok sessions delete`）或删文件，清掉这次产生的全部原生会话；
4. 把 CLI 往配置里加的信任条目（Codex 会在 `~/.codex/config.toml` 末尾加 `[projects."<tmp>"] trust_level = "trusted"`）逐字节还原；别的进程同时改过的文件只删我们那条并如实报告；
5. 删掉临时目录。

它会花钱（每次几美分），所以**不定时运行**（用户定：默认关，只能在 doctor 里手动触发）。

## 7. 加一个新 CLI

1. 新建 `server/canvas/adapters/<kind>.py`：`Adapter` 子类，写 `kind`、`name`、`binaries`、`tested`、`max_tier`（被观察的写 `"T2"`）、`seedmux_names`、`log_dir`、`delete_hint`、`has_cost`、`waits`。
2. T2 起步实现：`locate`、`sessions_for`、`project`（产出 `transcript.py` 的条目形状，工具条目带 `tool_facts`）、`record_type`、`handled_types` / `ignored_types` / `gap_types` / `known_types`、`classify`。有原生子 agent 再加 `children`，返回带 `ParentLink(via="native", evidence=…)` 的 `NativeRef`。日志不是 JSONL 的（SQLite 等），给 run 时间线提供 `read_records(path)`，给契约测试提供 `fixture_place(folder, home, cwd, nid)`。
3. 在 `registry.py` 注册（还没准备好时放进 `experimental.py` 的开关后面）。
4. 在 `scripts/record_agent_fixture.py` 的 `PROMPTS` / `MODELS` / `argv` / `*_collect` 里加上它，跑一次 `agora doctor --agents --record <kind>`，检查 `meta.json`（尤其 `expected_unknown`）和脱敏结果后提交样本。契约测试自动覆盖。
5. 头像：`web/src/session/AgentAvatar.tsx` 里没有画的 CLI 显示首字母；要正式的标志，放进 `web/src/app/agents/marks.tsx` 并写进 README「许可与致谢」。
6. 能被 Seedmux 派出的：确认工单 `meta.agent` 的名字写在 `seedmux_names` 里（`cursor-agent` → `cursor`）。
7. 跑 `agora doctor --agents`，把输出贴进 PR。

不做：替 CLI 改配置、装 hook、写信任记录；调用会上传数据的子命令（`grok trace` 之类）；从终端屏幕文字判断状态。

## 8. 用户已定

- T1 会话 agent 只有 Pi、Claude Code、Codex；Devin、Cursor（cursor-agent）、Grok、Droid 只做子 agent（T2/T3/T0）。
- Seedmux 只读：`meta.json` 核心键、`delivery.json` 核心键、`reply.md`，外加一次 `GET /panes`；只收 cwd 是本项目根或其 worktree 的工单；绝不 send / capture / spawn / wake。
- Devin 的 `sessions.db` 可以只读查询，契约测试兜底；Cursor 只读 agent-transcripts，不碰 `store.db`。
- T0 只在有 Seedmux worker 或未归属 pane 活跃时开启，一律标「推断」。
- 定时重录默认关；漂移先只提示，每个 CLI 可 `trust_untested`；子 agent 默认显示一层。
- agy、kimi、opencode、cursor（非 agent）不做。

## 9. v2 待办

v1 = 上面 §1–§7（步骤 0–6）。以下是 v2，按设计稿的顺序；调研依据是 2026-09-28 的设计稿《Agora 的 CLI 适配层》与原始调研附录（agora-cli-adapters-research.md，A–F 节），要点摘在每项里。

1. **工位视图（步骤 7）**：子小人、系绳（按 `parent.via` 与 `state` 画实线 / 虚线 / 提示色）、子泳道（默认折叠成状态带）、父泳道上的派发 / 回收三角（`moments`）；指针标签「Devin（Pi 派）· service.py」，父子同改只提示不标红；超过一层折叠成 `hiddenDescendants` 徽标。数据已经在 `/api/agent/runs`；另需：run 树变化时的 SSE（现在只能轮询）、`items=1` 大会话的分页。
2. **Seedmux 回执（步骤 8）——已写好，默认关**：`AGORA_EXPERIMENTAL=seedmux-receipts`。`adapters/receipts.py`：统一状态映射、父子连线（父日志 `task=T-xx pane=<UUID>` → `meta.from_pane` = Agora 记下的 pane → cwd + 时间窗推断）、有 sid 的 worker 带原生轨迹、否则 `smx:T-xx` 的 T3 run；`tests/test_receipts.py`。2026-09-28 只读验证：T-19c9ab（Devin）与 T-dfa7cb（Claude worker，经 delivery sid 找到日志）都连回派发它们的会话。打开前要补：前端展示、`reply.md` 预览入口、`verify.accept` 与 `replied:done` 分开显示。
3. **Grok（步骤 9）——已写好，默认关**：`AGORA_EXPERIMENTAL=grok`。`adapters/grok.py` + 真实样本 `grok/1.0.41`（spawn_subagent）。附录 D：`updates.jsonl` 是权威日志，`turn_completed.usage.inputTokens` 含缓存（已减），等待用户只能推断，绝不调用 `grok trace`；Seedmux 的 delivery sid 能直接找到会话（与回执一起打开）。
4. **Devin（步骤 10，T2）**：附录 B。`~/.local/share/devin/cli/sessions.db`（SQLite WAL，约 2.3 GB）：`sessions`（`working_directory`、`created_at`、`main_chain_id`）、`message_nodes`（OpenAI 风格消息，按 `row_id` 增量）、`tool_call_state`（ACP ToolCall，`locations[].path` 是写入文件，`kind` execute/read/edit/search）、`subagent_heads`（原生子 agent，本机 0 行未验证）；`refinery_schema_history` 迁移号（V17）作漂移信号。只读 `mode=ro`，只按 session_id 加 row_id 游标查；回合结束靠「最后一条 assistant 无工具调用」推断。Seedmux 里 Devin 的 pane 没有 sid：按 `working_directory` + pane 起始时间窗找会话，再用 worker 日志里的 `smx-team reply T-xx` 核对，核对上才算 seedmux 级（`receipts.worker_ref` 已留 `worker_for_ticket` 钩子）。样本：录制在 2026-09-28 被权限拦下，需要用户同意后再录。
5. **Cursor（步骤 11，T2）**：附录 C。`~/.cursor/projects/<realpath 去掉首 "/"，"/"→"-">/agent-transcripts/<chatId>/<chatId>.jsonl`，只有 `{role, message:{content}}` 和 `{type:"turn_ended", status}`；没有工具调用 id、没有工具结果、没有时间戳（`times_inferred`：用读到的时刻或 mtime，界面标「推断」）；工具名随模型变（`ApplyPatch` 要解析 `*** Add File:` 头）；子 agent 靠 `<父>/subagents/<子>.jsonl` 目录嵌套。chat id 按 cwd 隔离（换目录续接会静默开新会话）。**不碰加密的 `store.db`**。附录 F 有一份 stream-json 样本。
6. **Droid（步骤 12）**：附录 E。等用户登录并在 Seedmux 的 `agents.json` 里配上后再做：`~/.factory/sessions/-<cwd 仅 "/"→"-">/<id>.jsonl`（头部 `version: 2`），子 agent 头部 `callingSessionId` / `callingToolUseId` 直接指向父 tool_use；`droid exec` 失败时退出码仍为 0，要看 `error` 事件。先录样本，再写投影。
7. **T0 兜底（步骤 13）**：FSEvents + `git diff --name-only` 快照差，按 cwd 与时间窗归属到当时唯一活跃的 pane / 进程，否则显示为「未归属的改动」；只在有 Seedmux worker 或未归属 pane 活跃时开启。
8. **漂移后续**：观察一周没有误报后，决定是否打开真的降级（`degraded.enforced`）；面板顶部的一次性提示（「Codex 0.158 出现了 Agora 不认识的记录…」）；可选的周任务重录（默认关，花钱）。
9. **已知缺口**：
   - Codex 0.149 以前的旧格式（`event_msg/user_message`、`agent_message`、`exec_command_end`、`patch_apply_end`…）只投影出回合边界，没有消息和工具调用：老会话的轨迹不全（`gap_types`，doctor 会报）。
   - Codex 的 `world_state`（0.144 起，每轮的上下文快照）没有投影，一直作为未知记录报出，等决定是否列进 `ignored_types`。
   - 进度指针的 `specificity`（`codeLinks.ts`，服务端照搬）把不带通配符的目录 glob（`server`）当成字面量，排在更深的 `server/canvas/**` 前面：可能与文档「最具体的胜出」不符，待确认。
