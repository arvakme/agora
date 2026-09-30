# Agent 会话：会话就是你自己的 Pi / Claude Code / Codex

Agora 里的一个会话，就是用户选定的原生 coding agent 的一个原生会话。没有「主控」和「worker」之分：在会话里和它讨论架构，它通过 agora skill 读图、改图、做算法动画；想直接写代码时「在终端打开」，同一个原生会话在终端里接着用，两边说的话互相同步。

只支持三个 agent：**Pi**、**Claude Code**、**Codex**（适配器注册表里的 T1；每个 CLI 的知识在 `server/canvas/adapters/<kind>.py`，档位、工具事实、子 agent、漂移检测与怎么加新 CLI 见 [CLI 适配层](cli-adapters.md)）。

实现：`server/canvas/agents.py`（入口：无头后端、命令、日志位置、模型目录、skill 安装，转发到适配器）、`server/canvas/transcript.py`（日志 → 会话记录）、`server/canvas/sessions.py`（路由、跟随、终端、画布桥接）、`server/canvas/terminal.py`（tmux）、`server/canvas/agent_router.py`（`/api/agent`）、`agora_cli/canvas.py`（`agora canvas` / `agora skill`）、`skills/agora/`；前端 `web/src/session/agents.ts`（事件流与发送）、`agentBridge.ts`（在页面上执行改图）、`SessionPane.tsx`。

## 1. 会话模型

| | |
|---|---|
| 选择 | 新会话先显示选择器：Pi / Claude Code / Codex、模型、强度。点「用 X 开始」后固定 |
| 锁定 | 绑定写在 `.agora/sessions/<id>.agent.json`：`{agent, model, effort, nativeId, createdAt}`，只由服务端写。`PUT /api/agent/sessions/<id>` 再次提交不同的 agent / 模型 / 强度返回 `409 {locked: true}`；`nativeId` 只能从空设一次。界面上没有修改入口，只显示 🔒 模型 · 强度 |
| 原生 id | Claude Code 和 Pi 在绑定时就分配 uuid（`--session-id`）；Codex 自己分配，第一轮（无头 `thread.started`，或终端里 pane 进程打开的 rollout）后写回 |
| 已开始 | 绑定里的 `started`：原生日志第一次被找到、或一轮无头续接成功后置为 true（绑定时就带着 `nativeId` 的——撤销删除——直接是 true；没有这个字段的旧绑定按 true 算）。只有没开始过的会话会用 `--session-id` 新建；开始过的永远续接 |
| 原生记录缺失 | 开始过的会话找不到原生日志（Claude 默认 30 天清理、换机器、`~/.claude` 被清），或找到多份不知跟哪份，或 Pi 的日志只在别的目录下（项目移动过）：发消息和「在终端打开」都返回 `409 {nativeMissing: true, native: {state, candidates, message}}`，不启动 CLI；面板把输入框换成说明（丢了什么、候选文件），只读显示 Agora 保存的轨迹快照（§7），提供「带着摘要开新会话」（日志确实没了时：同一个 Agora 会话换一个新的原生会话，输入框预先填好快照生成的摘要，发送前可以改；旧 id 留在 `natives` 里）、「另开一个会话」（同一块画布、同样的 agent 和模型）和「移到回收站」。Agora 不会用同一个 id 静默新开对话。终端开着时消息照常投进终端（pane 已经持有这个会话，不会新起 CLI） |
| 快到 30 天 | Claude Code 会话 20 天没有活动（日志的修改时间）：面板提示一次 Claude 默认 30 天清理、怎么设 `cleanupPeriodDays`，以及 Agora 已经存了快照。不改用户的全局配置 |
| 对话记录 | 以 CLI 自己的会话日志为准（见 §4），不另存一份；`.agora/sessions/<id>.jsonl` 只记这个会话里的画布修改（每次 `agora canvas apply/anim` 一条 turn，带整批撤销数据） |
| 删除 | 删除会话 = 连同绑定文件、改图记录、轨迹快照和用量挪进回收站（[项目存储 §1](project-storage.md#trash回收站)），关掉它的终端 pane、停掉正在跑的无头续接（之后才结束的那一轮不再写回原生 id、用量和状态）；原生日志不删。从回收站恢复时绑定原样回来，按原来的原生 id 续接，不会用 `--session-id` 新建。带着原生 id 的 `PUT /sessions/{id}`（导入、恢复）不再按当前的模型目录校验 |
| 身份与恢复 | 绑定里另有 `natives`（这个会话用过的每个原生 id 和原因）、`log`（上次找到日志的路径）、`pendingFork`（下一次运行要从哪个原生会话分叉）。`nativeId` 只在记录在案的恢复流程里改：分叉（副本在这里继续、Pi 日志没能迁移）、以后的「带着摘要开新会话」。每次绑定和改绑都记进本机注册表（[项目存储 §1](project-storage.md#本机状态localagora-之外的注册表)） |
| 移动之后 | Claude Code、Codex 按 id 全局续接，什么都不用做。Pi 只在当前目录的文件夹里找：`agora up` 发现项目移动过，就把 Pi 会话的日志挪到新目录（先写新文件再原子替换，首行 `cwd` 改成新路径，其余字节不动，旧文件改名为 `….jsonl.agora-moved.bak`）；终端里还开着的会话不动，提示关掉后重新 `up`；挪不了（目标已存在、只读）就标记为下一次分叉继续（`pi --fork <旧文件>`，新的原生 id，完整历史） |
| 复制出来的项目 | `cp -r` 带过来的会话在副本里只读（原来那份还在用同一个原生会话）：面板把输入框换成「来自 A 的副本」，提供「在这里分叉继续」和「留给原来那份」（从副本里删掉它）。分叉后下一条消息用 `claude --resume <旧 id> --fork-session` / `pi --fork <旧日志>` 得到新的原生 id；Codex 没有无头分叉，只能「在终端打开」（`codex fork <旧 id>`），新的会话出现在这个项目里就自动接上。同一台机器上的另一份克隆或 worktree 里的会话（注册表知道它属于另一份）同样可以分叉 |
| 来自另一台机器 | 清单里有 agent、本机既没有绑定、注册表也不知道：显示只读卡片（agent、主题、所属画布、模型、原生 id 前 8 位），**不显示 agent 选择器**；可以「在这里开新会话」（同一块画布、同样的 agent 和模型）。本机注册表里有它的绑定（`.agora/sessions/` 被 `git clean` 清掉了）时，卡片提供「恢复这个会话」，按原来的 agent、模型和原生 id 重新绑定 |

会话面板只显示这一个 agent（名字就是 Pi / Claude Code / Codex，配各自的官方标志，来源与商标说明见 README「许可与致谢」；标志也用在选择 agent、tab、所有画布列表、进度指针标签、轨迹记录和评论线程里该会话的答复上）。所有位置都经过一个组件 `AgentAvatar`（`web/src/session/AgentAvatar.tsx`）：圆形底盘用主题 token（`--avatar-tile` 加 `--avatar-edge` 发丝线，亮色浅灰、暗色石墨），标志居中、不加阴影或光晕；Pi 与 Claude Code 是矢量（Pi 的单色徽标随主题取 `#111` / `#f6f6f6`），Codex 是 64/128px 两档位图按尺寸 × 设备像素比取用；尺寸 16（tab、行内）、26（评论线程里与人的头像并列）、32（会话头部）、40（选择卡片）：「对话 / 轨迹」两种视图（见 §7）、它改画布的卡片（撤销、在画布中高亮）、状态行（处理中 / 排队原因 / 出错）、「在终端打开」。来自终端的轮次带「终端」标记。头部显示这个会话累计的轮数、tokens、耗时和花费。没有 @ 提及、没有派发步骤。

**画布评论 @ agent**：评论框里输入 `@` 选一个 agent（为这条线程开一个新对话「评论 #N · 节点名」）或一个现有对话；不带 @ 就是普通评论。线程绑定这个对话（记在线程自己的记录里），之后的回复不用再 @，「结束交接」解绑；规则见 [工位视图 §12](workstation.md#12-评论联动与进出子图)。Agent 收到的是线程全文（已交接的线程之后只发它没看过的部分）+ 锚点名字和 id（`web/src/comments/handoff.ts`）；它的最终答复贴回线程，线程消息链接到会话和它最后一次改图（撤销按钮撤的是那一批；一次评论里改了多批时，前面的批次在会话里逐条撤销）。

评测基线不变：`npm run eval` 仍走 `handToAgent` → `claude -p --json-schema` 在中性空目录里规划（`ClaudeCliBackend`，`/api/canvas/turns`），不经过会话。

## 2. 三个后端

都在**项目根目录**里运行（这是项目自己的 agent），环境里有 `AGORA_PROJECT`、`AGORA_SESSION`、`AGORA_CANVAS`，`bin/agora` 在 PATH 最前；启动 Agora 的那个 agent 的运行时标记（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION` 等，见 `agents._NESTED`）会被去掉——继承下来 Claude Code 会停止写会话日志，同步就断了。

| | 无头续接（Agora 发消息、终端没开） | 终端里的交互式续接 |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode auto --session-id <uuid>`（没开始过）/ `--resume <uuid>`（其余一律如此，日志没了 CLI 会明确报错），`--model`、`--effort`、`--allowedTools "Bash(agora canvas *)"`；第一条用户消息以 stream-json 一行写进 stdin，**这一轮里 stdin 保持打开**（回审批/问题、发中断），收到 `result` 后关掉；双向协议、auto 与「等你」见 [claude-headless-duplex.md](../../docs/claude-headless-duplex.md) | `claude --resume <uuid> --model … --effort …`（没开始过时 `--session-id`） |
| Pi | `pi -p --mode json --session-id <uuid> --model <provider/id> --thinking <level> --skill <repo>/skills/agora -- "<提示词>"` | `pi --session-id <uuid> --model … --models …（锁住 Ctrl+P 轮换）--thinking … --skill …` |
| Codex | `codex exec --json --skip-git-repo-check [-m] [-c model_reasoning_effort="…"] -`（首轮）/ `codex exec resume <id> --json … -`，提示词走 stdin | `codex resume <id> -m … -c model_reasoning_effort=…`（还没有 id 时 `codex`，id 从 pane 进程自己打开的 rollout 认领） |

日志定位（`agents.locate_log`）：先找**当前项目根**对应的位置（Claude `~/.claude/projects/<根路径非字母数字换成 ->/`，Pi `~/.pi/agent/sessions/--<根路径>--/`），它就是 CLI 续接时用的那份；不在那里时，Claude 只有一份就跟那份（`--resume` 全局查找），多份就报「找到多份」；Pi 只在别的目录下时报「在别的目录」（`--session-id` 在这里会新开空会话）。Codex 先按 rollout 文件名找，找不到再看绑定记下的路径和 Codex 自己的索引（`~/.codex/state_5.sqlite` 的 `threads.rollout_path`，只读打开），归档或存储迁移后照样找得到。本项目那份之外还有同 id 的副本时，面板顶部提示一次，照常跟随本项目那份。跟随中每 5 秒重新定位一次，日志换了位置（Pi 迁移、分叉）就换过去；跟随中的日志被删了（服务开着时 Claude 做了 30 天清理），就转成「原生记录缺失」，面板上已有的内容留着。

Agora 发出的消息末尾有一行隐藏页脚：`[[agora]] 来自 Agora · 画布「…」(canvas=<画布 id> session=<Agora 会话 id> project=<项目 id 前 8 位>)。…`，面板里不显示；以后能按它把原生日志认回到 Agora 会话。

事件统一映射成 runner 的事件流（`start` / `text` / `tool_use` / `tool_result` / `usage` / `result`，`result.raw` 是最终回复文字，`result.session` 是原生 id）：

| | 文字 | 工具 | 结束 / 失败 | usage |
|---|---|---|---|---|
| Claude | `assistant` 的 text 块 | `tool_use` / `user.tool_result` | `result`（`is_error`） | 每条消息 `usage`；结果行汇总与 `total_cost_usd` |
| Pi | `message_end`（assistant）的 text 块 | `toolCall` / `tool_execution_end` | `agent_settled`；`stopReason` error/aborted、重试用尽 | 每条 assistant 消息的 `usage`（含 `cost.total`），累加 |
| Codex | `item.completed` agent_message | `command_execution` started/completed，mcp/file_change | `turn.completed` / `turn.failed`、顶层 `error`（配置警告类 `error` item 不算失败） | `turn.completed.usage`（`input_tokens` 含缓存，报告时拆出 `cacheReadTokens`） |

**模型与强度**（`GET /api/agent/catalog`，`server/canvas/agent_models.py`，缓存 10 分钟）：模型列表和**每个模型真实支持的强度档位**都从 CLI 自己或它自带的模型目录读，不写死通用词表。选择器里切换模型时强度列表随之更新，默认选中该模型的默认档；绑定时服务端再校验一次（`agents.check_binding`）：模型不在该 agent 允许的范围里（Pi 超出 `enabledModels`、Claude / Codex 不在各自目录里）或档位不在该模型的集合里，返回 `400` 并说明原因和可选项。

| | 模型从哪来 | 每个模型的档位从哪来 | 默认档 | 读不到时 |
|---|---|---|---|---|
| Claude Code | SDK 的 `initialize` 控制请求：`claude -p --input-format stream-json --output-format stream-json` 发一条 `{"type":"control_request","request":{"subtype":"initialize"}}`，收到回复就结束进程（不发提示词，不调用模型）；回复里的 `models[]`（别名与完整 id、`resolvedModel`）。`~/.claude/settings.json` 的 `model` 排第一 | 同一回复里每个模型的 `supportedEffortLevels`（`supportsEffort` 为假的，如 haiku，没有档位）。实测 2.1.283：opus / sonnet / fable / opus-4-7 及以上 `low…max`，opus-4-6 与 sonnet-4-6 没有 `xhigh` | `settings.json` 的 `modelSettings.<模型>.effortLevel`（按别名或 `resolvedModel` 匹配），否则 `effortLevel`；都没有 = CLI 默认 | `claude --help` 里 `--effort` 的取值，对所有模型 |
| Pi | `pi --mode rpc` 的 `get_available_models`（只含已配置凭据的模型），再按 Pi 自己的范围收窄，见下文「Pi 的模型范围」 | 每个模型的 `reasoning` 与 `thinkingLevelMap`，按 Pi 自己的规则（pi-ai `getSupportedThinkingLevels`）：不支持推理只有 `off`；映射为 `null` 的档不支持；`xhigh`、`max` 必须显式映射。顺序取 `pi --help` 的 `--thinking` | `defaultThinkingLevel` 按 Pi 的 `clampThinkingLevel` 夹到该模型支持的档（先往高、再往低） | `pi --list-models` 的 thinking 列（yes → `off…high`，no → `off`） |
| Codex | `~/.codex/models_cache.json`，按其中 `priority` 排序，`visibility: hide` 的不列（除非 `config.toml` 指定） | 每个模型的 `supported_reasoning_levels`（实测：gpt-6-astra / sol、gpt-5.6-sol / terra 到 `ultra`，gpt-6-luna 等到 `max`，gpt-5.5 只到 `xhigh`） | `config.toml` 的 `model_reasoning_effort`（该模型支持时），否则模型的 `default_reasoning_level` | 没有档位可选，只用 CLI 默认 |

没有已知默认档的模型在列表里多一项「CLI 默认」（不传强度参数）。

**Pi 的模型范围**（`agent_models.pi_settings` / `pi_scope`，照 Pi 0.87.1 源码移植：`dist/core/model-resolver.js` 的 `resolveModelScopeFromModels`、`main.js` 的 `buildSessionOptions`、`settings-manager.js` 的 `deepMergeSettings`、`trust-manager.js`；文档 `docs/settings.md`、`docs/configuration.md`、`docs/security.md`、`docs/cli.md` 的 `--models`）：

- 设置来源：`$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）的 `settings.json`，再叠加项目根的 `.pi/settings.json`。项目文件只在项目受信任时生效，按 Pi 非交互模式的规则：`trust.json` 里离项目最近的已保存决定，否则全局 `defaultProjectTrust: "always"`。叠加时对象逐键合并，数组整个替换，所以项目的 `enabledModels` 取代全局的，写 `[]` 则关掉范围。
- 有 `enabledModels` 时只列它解析出的模型，也就是 Pi 自己切换模型时循环的那些：精确的 `provider/id` 或唯一的裸 id；含 `*` `?` `[` 的按 minimatch 通配（不区分大小写，匹配 `provider/id` 或 id；`*` 不跨 `/`，`**` 跨，支持 `{a,b}`）；其余按 id / 名称子串模糊匹配（优先不带日期的别名）。可带 `:<档位>` 后缀，作为该模型的默认档。解析只在可用模型里进行，匹配不到的模式忽略。默认模型：`defaultProvider/defaultModel` 在范围内就用它，否则范围里第一个。
- 没有 `enabledModels` 时列出全部可用模型，去掉不适合交互会话的变体（OpenRouter 的 `:batch`）；只有明确写出这类 id 的模式才保留它。
- 每个模型的默认档：模式后缀 → `modelThinkingLevels["provider/id"]` → `defaultThinkingLevel`，再按上表夹到它支持的档。

**选择器**（`web/src/session/Picker.tsx`，逻辑在 `pickerModel.ts`）：三个 agent 的模型和强度用同一个组件。按钮显示友好名称（CLI 给的 `displayName` / `name` / `display_name`），完整 id 作次要文字。选项不超过 8 个时是普通列表；更多时顶部加搜索框，多个词逐个匹配完整 id 和名称：子串优先，也忽略分隔符（`opus55`），4 个字符以上可以按子序列匹配。分组：「已启用」（Pi 的 `enabledModels`）或「常用」（Claude 的 `settings.json` 模型与 opus / sonnet / haiku 等别名、Codex 按 priority 的前 6 个）在前；其余按 provider 分组，默认折叠（当前选中项所在的组展开），输入查询后所有命中的组都展开。键盘：↓ / ↑ / Enter / 空格打开，↑↓ / Home / End 移动，Enter 选中或展开组，→ / ← 展开 / 折叠组，Esc 关闭。Pi 的选择器下方用一行说明范围来自哪里。解析函数是纯函数，测试用录制的输出（`tests/fixtures/efforts/`，`tests/test_agent_models.py`）。

一个会话同时只跑一轮无头续接，后来的消息排队；「停止」取消当前一轮。

## 3. agora skill 与 `agora canvas`

`skills/agora/SKILL.md`（一页路由：什么时候用、各领域的核心步骤）+ `references/`（`canvas-ops.md` 改图操作、`animation.md` 动画脚本、`nested.md` 子图、`link.md` 关联代码、`comments.md` 答复评论、`dispatch.md` 派活）+ `scripts/agora`（PATH 上没有 `agora` 时用，顺着软链接找到 Agora 仓库的 `bin/agora`），三个 CLI 共用一份。命令都输出一个 JSON 对象：

```bash
agora canvas list                     # 画布与会话
agora canvas read [--canvas id|名字]   # 模型视图（nodes/arrows/frames）+ base
agora canvas search redis             # 素材库
agora canvas apply --base r-… [--note "…"] <<'JSON'   # 类型化改图，一次可撤销
[{"op": "update_text", "id": "redis", "text": "Redis 集群"}]
JSON
agora canvas anim <<'JSON' … JSON     # 挂载算法动画
agora canvas schema ops|anim          # 精确 JSON Schema（ops 里含末尾的 layout）
agora canvas lint                     # 量：交叉、穿节点、重叠、标签遮挡、线长（见 diagram-layout.md）
agora canvas layout --nodes a,b|--all # 排已有节点：默认只说会动哪些，--apply 才执行
agora canvas child create --parent c1 --node api   # 节点展开成子画布（见 nested-canvas.md）
```

退出码：0 成功 · 1 被拒（invalid / stale / error，见输出）· 2 用法错误 · 3 需要服务或打开的页面。`read` / `list` / `search` / `schema` / `lint` / `child list` 没有页面也能用；`apply` / `anim` / `link` / `layout --apply` / `child create|link|unlink` 需要打开的页面。图怎么排、怎么量、怎么画连线见[图要读得懂](diagram-layout.md)。

- **找项目**：`--project`，否则 `$AGORA_PROJECT`，否则向上找最近的 `.agora/config.toml`。画布默认 `$AGORA_CANVAS` → 会话关联的画布 → 聚焦画布 → 唯一画布。
- **读**：服务在跑且有页面打开时读页面上的实时场景（可能有还没落盘的编辑），否则读 `.agora/canvases/<id>.excalidraw`（`server/canvas/model_view.py`，与前端 `toModelView` 同构）。服务没开也能读。每次读把元素版本记到 `.agora/run/reads/<base>.json`。
- **写**：`apply` / `anim` 经服务转给**最近连接的页面**执行（页面持有画布）：库素材存在、`validatePlan`（schema + 引用）、按 `base` 查新鲜度（引用的元素在读取后被改过 → `stale`）、`applyPlan` 一批写入、记成会话里的一条 turn（撤销数据）、结果实时显示在画布和会话里。`anim` 先在服务端按 `anim.schema.json` 做结构校验，再由页面 `validateScript` 校验并挂播放器。服务没开或没有页面 → 退出码 3，提示先 `agora open`。
- **动画**是 skill 里的一项能力：用户要动画时 agent 自己写脚本调 `agora canvas anim`。没有专门按钮、弹窗或关键词规则；播放器与脚本校验不变。

**skill 放在哪（实测 2026-09-28）**：

| CLI | 加载方式 | `agora skill install` 做什么 |
|---|---|---|
| Claude Code | 项目 `.claude/skills/<name>/SKILL.md`（软链接可用） | 链接 `.claude/skills/agora`（旧的 `agora-canvas` 链接同时删掉） |
| Codex | 项目 `.agents/skills/`（软链接可用） | 链接 `.agents/skills/agora`（同上） |
| Pi | 启动参数 `--skill <dir>`；项目 `.agents/skills` 只在用户信任该项目后加载（print 模式下不信任就静默跳过） | 不放文件，Agora 每次启动 Pi 都带 `--skill` |

绑定会话时自动为该 agent 安装（`agora skill install --agent <x>` 可手动，`--copy` 复制而不是链接）。链接写进 `.git/info/exclude`，不出现在未跟踪文件里；不改任何用户全局配置。

## 4. 在终端打开与双向同步

**终端**：「在终端打开」（按钮，⋯ 菜单里还有「复制打开命令」）。每份项目一个独立的 tmux 服务器 `tmux -L agora-<实例 id 前 10 位>`（和路径无关，移动后照样找得到原来的 pane；旧版本用路径哈希，`agora down` 一并清掉），配置用 `.agora/run/tmux.conf`（不读 `~/.tmux.conf`），每个会话一个 tmux 会话 `agora-<会话 id>`，pane 里直接跑 §2 的交互式续接命令（不经 shell）：CLI 退出 = tmux 会话结束 = 不再持有。打开时创建或复用这个 pane，用 Kitty（`kitty --detach`）打开窗口，没有 Kitty 用 macOS Terminal（`osascript`），并在面板上给出 attach 命令（复制时带 `env -u TMUX`，在 tmux 的 pane 里也能直接运行）。「复制打开命令」先起 Agora 的 tmux pane，再复制 `env -u TMUX tmux -L … attach -t …`，在任意终端里粘贴即可；只想看不想动，加 `-r`（只读 attach，不占输入权，键盘输入被 tmux 丢掉）。实现只有一份：`server/canvas/terminal.py`。

「关闭终端」结束持有它的 CLI；`agora down` 关掉整个 tmux 服务器。无头一轮进行中不能打开终端（同一原生会话不能两个进程同时写）。

**输入权**（运行时事实放 `.agora/run/`，语义对应 `native_protocol.SessionGate`）：

- **接管**（`POST /sessions/{id}/takeover`，记在 `run/input-right/<tmux 名>.json`）：人占着终端输入，自动投递暂停，队列保留不丢。detach、控制连接异常断开、Agora 服务重启都不算归还，只有显式归还（`POST /sessions/{id}/return`）、关掉这个终端或换一个新的 pane 才结束；这一步不取消任何在跑的东西。
- **可写窗口**：只要有一个不是 Agora 自己挂的可写 tmux 客户端连着这个会话（例如 Kitty 里的 attach），就暂停投递，窗口关掉后恢复；不强踢，也不把它当成接管。状态行显示「排队中：…」的原因。
- **Agora 自己的输入**：走一个 Agora 自己挂的可写 control-mode 客户端（`tmux -C attach -f ignore-size,no-output`，首次投递时才起，不计入窗口数），回车用 `send-keys -c <这个客户端>`。tmux 3.7b 里不指定客户端的 `send-keys` 会走「当前客户端」，最后一个连上来的是只读窗口时直接报 `client is read-only`，所以只读窗口不会挡投递，也不会被拿来输入。
- **存活**：`run/panes/<tmux 名>.json` 记着打开时登记的真实 pane id、CLI 进程 pid 和它的启动时间；判断时对照 tmux 现在报的 pane 与 `ps`：都对得上是 `running`，pane 在但没登记（旧版本开的，或 `run/` 丢了）是 `unknown`（当作在），pane 没了 / CLI 退出了 / pid 被别的进程占了是 `gone`。CLI 在一轮中途退出、日志里没有结束记录时，这一轮（以及已粘贴、日志里还没出现的消息）如实报「结果未知」（`done` 事件带 `outcome: "unknown"`，先把它退出前写下的日志读完再判断），不写成完成或失败。

**终端 → 面板**：服务端每 0.4s 跟随原生会话日志（Claude `~/.claude/projects/*/<id>.jsonl`，Pi `~/.pi/agent/sessions/--<cwd>--/<时间>_<id>.jsonl`，Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`，按 id glob 定位），把新记录映射成会话条目推到页面（SSE `/api/agent/events`）。终端里敲的话、agent 的回复和工具调用都会出现在面板上。

**面板 → 终端**：Agora 发的消息末尾带一行上下文 `[[agora]] 来自 Agora · 画布「…」…`（面板显示时隐去，也用来标记来源）。pane 持有会话时：

1. 排队，直到没有人占着输入（没有接管，也没有可写窗口连着）、终端打开满 6 秒（CLI 还在启动时粘贴会丢）、agent 这一轮答完（日志里看到回合结束）——面板状态行显示「排队中：…」原因。
2. `load-buffer` + `paste-buffer -p`（bracketed paste）+ 从 Agora 自己的客户端发 Enter，和人粘贴回车一样。
3. 日志里出现这条用户消息即确认送达；它这一轮结束时把回复交给等待者（例如评论线程）。30 秒内日志里没出现 → 报「终端没有确认收到」。
4. 投递时 pane 已退出 → 这条改走无头续接。

pane 不在时一律无头续接（§2）。两边用的是同一个原生会话 id，所以哪边说的话另一边都接得上。

## 5. 接口（`/api/agent`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/catalog` | 三个 agent 的安装状态、模型、强度 |
| GET | `/adapters` | 每个有适配器的 CLI 的 `AgentInfo`：档位、测过的版本、能力、日志目录、删除命令、漂移提示（[CLI 适配层 §5](cli-adapters.md#5-接口)） |
| GET | `/runs?session=…` | 会话的 run 树：它自己和原生子 agent，每个带时间线（[CLI 适配层 §5](cli-adapters.md#5-接口)） |
| PUT | `/sessions/{id}` | 绑定 `{agent, model, effort, nativeId?}`；不同选择 409 |
| GET | `/sessions/{id}` | 状态（绑定、运行、排队、终端） |
| POST | `/sessions/{id}/send` | `{text, canvasId?, context?, mode?, refs?, selection?}` → `{sendId, route: terminal\|headless}`。`refs`：消息里用 # 引用的元素 `[{id, name}]`；`selection`：发消息时选中的元素 `{canvasId, elements: [{id, name}], svg, png?}`（png 是 base64）。两者服务端都写进页脚，写成「名字（id）」，不进正文；`selection` 另存成图（见下），并把 `agora-sel-<id>` 写进页脚 |
| GET | `/selections/{id}`、`/selections/{id}/thumb.svg` | 一次选区的记录 `{id, canvasId, elements, at, hasThumb, hasImage}` 和它的缩略图（SVG）；对话里消息下面的选区小图就取这个 |
| POST | `/sessions/{id}/fork` | `{source?}`：在这里分叉继续（副本带来的会话；或带着 `source` 的、另一份副本的会话）→ 绑定带 `pendingFork` |
| POST | `/sessions/{id}/interrupt` | 停止当前无头一轮并清空排队 |
| POST / DELETE | `/sessions/{id}/terminal` | 打开（`{launch}`）/ 关闭终端；状态里的 `terminal` 带 `alive`、`attach`、`clients`（不含 Agora 自己的客户端）、`inputRight`（`host` 或 `human`） |
| POST | `/sessions/{id}/takeover`、`/sessions/{id}/return` | 接管终端输入（暂停自动投递、队列保留）/ 归还（恢复投递） |
| GET | `/terminals` | 能在哪儿打开：`{kitty}` |
| GET | `/sessions/{id}/items/{itemId}` | 一条会话记录的全文（工具输入 / 输出超过预览长度时，页面「展开全文」用） |
| GET | `/sessions/{id}/summary` | `{text}`：按快照生成的「接着之前的讨论」摘要（最近的轮次优先，约 6000 字以内），不调用模型 |
| POST | `/sessions/{id}/restart` | 原生日志确实没了：换一个新的原生 id（`started: false`），下一条消息新建它；日志还在时拒绝 |
| GET | `/events?executor=2` | SSE：`transcript`、`status`、`delivered`、`done`、`bridge`（给执行页面）；第一条 `hello` 带这个页面的 `sub`。`executor=2` 表示页面先认领再执行，`executor=1` 是旧页面（直接执行） |
| POST | `/bridge/{rid}` | 页面回传 read/apply/anim 结果 |
| POST | `/events/{sub}/state` | 页面报告自己是否在前台（`visible`）和最近一次获得焦点的时刻（`focusedAt`） |
| POST | `/bridge/{rid}/claim` | 页面认领一个改图请求（`{sub}`）：只有正被交给的那个页面、且只有一次能得到 ok |
| GET / POST | `/canvas/list`、`/canvas/read`、`/canvas/apply`、`/canvas/anim`、`/canvas/link` | `agora canvas` 用（`link` 见 [进度指针](progress-pointer.md)） |

## 6. 限制

- **终端里仍能换模型**：锁定只管 Agora 这一侧；终端里用户自己 `/model` 切换，CLI 不提供禁止的开关（Pi 用 `--models` 把 Ctrl+P 轮换限制在选定模型）。下一次无头续接仍按绑定的模型启动。
- **首次进入不信任的目录**：Claude Code / Pi 在终端里会先问是否信任该目录，需要在终端里回答；这时从面板投递的消息会等到回合空闲判断之后才发，可能落进信任提示里。
- **输入到一半的草稿**：投递只在没有人占着输入（接管、可写窗口）时进行；如果终端输入框里留着没发出去的半句话，粘贴会接在它后面。
- **写需要页面**：改图和动画由打开的 Agora 页面执行；只开终端、没开页面时 `apply` 返回退出码 3。
- **日志是同步通道**：CLI 关掉会话持久化（例如 Claude 的 `--no-session-persistence`，或继承到嵌套标记）时，面板看不到那边的对话。
- **Codex 终端先行**：还没有原生 id 的 Codex 会话在终端里开新会话，Agora 从这个 pane 的 CLI 进程（及它启动的子进程）自己打开的文件里认 rollout（Linux 读 `/proc/<pid>/fd`，macOS 用 `lsof`），不按目录和时间猜；同一时间在同一目录另起的 Codex 各认各的。进程还没打开 rollout 时（还没发第一条消息）继续等，不退回去按目录认。

## 7. 对话与轨迹视图

信息结构照搬 DeepSeek Harness（github.com/deepseek-ai/deepseek-harness，MIT，提交 477b4f4）：`ui-chat` 的每轮过程分组与一行摘要、`ui-trajectory` 的时间轴总览与「轮 → 步骤 → 记录」明细。用 Agora 的技术栈重写（`web/src/session/trajectoryModel.ts` 折叠，`TrajectoryView.tsx` 界面），没有引入它的依赖；对应关系写在两个文件的文件头。界面按统一设计规范 v0.2（`web/src/app/tokens.css`，整站生效，浅色 / 深色跟随系统，顶栏可手动切换）。

**会话记录条目**（`server/canvas/transcript.py`，都从 CLI 原生日志来，面板和终端的轮次一样）：

| kind | 内容 |
|---|---|
| `user` / `assistant` | 消息文字；assistant 带 `msg`（同一次模型请求的文字和工具调用共用，轨迹里是一「步」）。`user` 另带 `source`（`agora` / `terminal`）；Agora 发的还可能带 `card`、`selection`、`dispatch`、`receipt`（下一节） |
| `tool` | `name`、一行摘要 `input`、完整输入 `args`、输出 `output`、`isError`、开始 `at` / 结束 `endAt`、写到的文件 `files` |
| `usage` | 一次模型请求的 tokens（输入不含缓存、输出、缓存读、缓存写）和模型；Pi 带花费。Claude 一条消息拆成多条记录时按消息 id 合并，Codex 用每次响应的 `token_usage_record` |
| `context` | 生效的模型 / 强度：Codex 的 `turn_context`，Pi 的 `model_change` / `thinking_level_change` |
| `end` | 这一轮结束：Claude 交互模式的 `turn_duration`、Codex 的 `task_complete.duration_ms` 给出耗时；没有就用结束时间减开始时间 |
| `run` | 无头续接时 runner 的结果用量（Claude 的花费只在这里：原生日志不记花费）。存 `.agora/run/usage/<会话>.jsonl`，重启后还在 |

**Agora 写进会话的用户消息不是用户说的话**（`server/canvas/agora_msg.py`，`adapters/common.py` 的 `user_item` 对每家 CLI 的日志、包括老日志都读一遍）：

| 消息 | 服务端标出 | 对话里怎么画 |
|---|---|---|
| 派发回执（`[Agora 派发回执 …]`：派活方收到的「你派给 X 的任务：完成了…」） | `card: {kind: "receipt", id, state, agent, session, answer}`；新的另带 `receipt`（页脚标记，重启补发靠它） | 一张卡片：「Codex 交回了你派的任务 · 完成」，下面是答复的开头，展开看全文，「打开 Codex 那个会话」；没有路径、`agora dispatch status`、「这是通知，不需要回复」；这一轮的轮头写「收到回执」；agent 对它的简短确认（没做别的事、160 字以内）淡显 |
| 派发的任务信封（`[Agora 派发 …] 来自 …：先读任务文件 …`：被派会话收到的） | `card: {kind: "task", id, from, session?, scope}`、`dispatch`（完整的派发 id） | 卡片「Claude 会话 s-… 派来一个任务」，第一行是派发记录里的任务摘要，范围；轮头「收到任务」 |
| 评论交接（`画布评论 #n（锚点：名字（id）…）：`，经派发送达） | `dispatch`；页面自己读（`comments/handoff.ts` `parseCommentMessage`，和写它的 `commentMessage` 放在一起） | 卡片「画布评论 #2」，第一条评论的开头，展开看整条线程，「在画布上看这条评论」；轮头「收到评论」 |
| 发消息时的选区、`#` 引用 | `selection: {id}`（页脚里的 `agora-sel-<id>`）；老消息正文末尾的 `（当前选区：a, b）` 服务端读成 `selection: {ids}` 并从正文里去掉 | 用户气泡下面一张小图：选中元素的缩略图 + 「选区 · 21 个元素」；悬停列出名字，点击在图上标出这些元素（再点取消）；老消息没有图，只有这个标签 |
| 「上一轮随服务重启中断了」「这一轮被停止了」「被 auto 拦下」「你在这里插了一句」 | 服务端加的 `notice` 条目，不是用户消息 | 一行小字，本来就不是气泡 |

这些消息的 `text` 仍是 CLI 日志里的原文（轨迹里点开看到的是原文，标着「来自 Agora · 原文」；轨迹的一行和会话标题用卡片的一句话）；只有对话里的画法变了。按钮触发、由页面写的提示（「让 AI 画子图」的展开提示、「画出这个项目的架构」）目前仍按用户气泡画。

**选区的图**存在 `.agora/local/selections/<id>/`（`server/canvas/selection.py`，`local/` 本机、不进 git、每天备份）：`meta.json`（画布、选中元素的名字和 id）、`thumb.svg`（缩略图，≤ 1.5 MB）、`selection.png`（给能收图的 CLI，最长边 1024 px，≤ 3 MB），几十 KB 一份，不自动清理。消息页脚里的 `agora-sel-<id>` 让这张图跟着那条消息，刷新、重启、元素以后改了都还在。哪些 CLI 收图见 [CLI 适配层 · 图片](cli-adapters.md)。

工具输入 / 输出服务端保留全文（每条最多 256k 字符），推给页面的是前 4000 字符的预览加总长度，页面点「展开全文」再取。

**轨迹快照**（`.agora/sessions/snapshots/<会话>.jsonl`，只在本机、不进 git）：推给页面的每条记录（就是上面那份预览：用户和助手的文字全文，工具只有名字、一行摘要、4000 字预览和改到的文件）同时追加一行，同一个 id 以最后一行为准，内容没变不追加，每个会话封顶 20MB。服务启动时先载入它，再从原生日志补全；原生日志没了，面板照样显示快照（只读），「带着摘要开新会话」的摘要也从它来。不备份原生日志本身。

## 8. 会话历史

「所有画布」底部的「会话历史」（`web/src/workspace/HistoryPanel.tsx`，`GET /api/project/history`，`server/canvas/discover.py`）：

- **列出**：清单里的会话（打开的、关闭的）、回收站里的、只有本机注册表知道的，以及在本机找到、属于这个项目但不在项目里的原生会话。每一行：agent 头像、名字、状态（已打开 / 已关闭 · 可续接 / 在终端里运行 / 原生记录缺失 / 来自另一台机器 / 副本 · 只读 / 在回收站 · N 天后清除 / 不在项目里）、所属画布、模型、轮数、创建和最后活动时间。
- **筛选与搜索**：agent、画布、状态（打开的 / 已关闭 / 回收站 / 要处理的 / 可以导入的）、时间（24 小时 / 7 天 / 30 天）；搜索名字、主题、首条消息（在页面里筛）；勾「搜索对话全文」后由服务端逐个读原生日志里用户和助手说的话（每个文件最多 50MB；日志没了就读快照，`GET /api/project/history/search?q=`）。
- **找回**：从强到弱——本机注册表的绑定记录（精确到原生 id）；Agora 发出的消息里的隐藏页脚 `(canvas=… session=… project=…)`（项目 id 前 8 位对得上就算这个项目的，`session=` 给出原来的 Agora 会话 id，`canvas=` 给出画布）；只有画布 id 的旧页脚；只在项目目录里跑过、从没经过 Agora 的会话（默认折叠在最后）。扫的是当前根目录和注册表里记下的每个历史根目录：Claude 的转义目录、Pi 的 `--…--` 目录、Codex 的 `state_5.sqlite`（`threads where cwd in (…)`，只读；没有这个库就看最近 400 个 rollout 的首行）。
- **操作**：打开（清单里的）、恢复（回收站里的）、导入（找到的 / 注册表里的）：按原来的 Agora 会话 id（页脚里有、且没被占用时）建会话、挂到页脚里的画布（没有就当前画布），绑定到那个原生 id、`started: true`——续接，不会新建。

**对话视图**：每轮一个头（第 N 轮 · 终端 · 时间 · 模型 · 强度 · 输入 / 输出 / 缓存 tokens · 耗时 · 花费，只显示日志里有的），然后是用户消息、**过程折叠成一行**（「已读取文件并修改了文件 · 用时 12 s · 4 次工具调用」，按工具类别计数取前三；进行中显示「正在编辑文件，用时 …」且保持展开，出错的轮次也保持展开），展开后是中间消息和工具调用，每个工具调用可再展开看输入、输出、改到的文件和起止时间；这一轮里的改图卡片；最后是答复。答复按 Markdown 渲染（`web/src/session/markdown.tsx`：标题、列表、表格、代码块、引用、行内代码与链接），直接生成 React 元素，文字里的 HTML 标签原样显示为文字，链接只保留 http(s) 与 mailto，所以答复里的内容不会执行脚本。

**轨迹视图**：工具栏（轮数 · 记录数 · 调用数，时间轴「等宽 / 实际时长」，展开 / 收起所有轮次，搜索）；时间轴总览（用户 / 消息 / 工具三条泳道、轮次分界；「实际时长」按记录的开始时间与时长、去掉记录之间的空闲；拖动选一段只看这段里的记录，右键或「清除选择」取消）；明细按轮分组，粘性轮头带用量，轮内是「消息」和「第 N 步」（步骤描述：墙钟时长 + 工具直方图，如 `1.5 s Bash×6`），每条记录 `#序号 · 类型 · 摘要 · 用时`，点开就地看输入输出。进度指针或别处要看某一轮时，面板切到轨迹并定位到那一轮。

**用量从哪来、缺什么**：

| | 模型 | 强度 | tokens | 耗时 | 花费 |
|---|---|---|---|---|---|
| Claude Code | 日志 `message.model` | 绑定时选的（日志不记） | 日志 `message.usage` | 交互：`turn_duration`；无头：结束减开始 | 只有无头续接（runner 结果 `total_cost_usd`）；终端里的轮次不显示 |
| Pi | 日志 `model_change` / 消息 | `thinking_level_change` | 消息 `usage` | 结束减开始 | 消息 `usage.cost.total` |
| Codex | `turn_context.model` | `turn_context.effort` | `token_usage_record` | `task_complete.duration_ms` | 不记，不显示 |


## 导入已有的原生会话（IM1）

把一个已经存在的原生会话（在终端里聊过的 Pi / Claude Code / Codex 会话）接进 Agora，历史完整显示在会话面板里：

1. **先分叉，别直接接**：`pi -p --fork <原会话 id> "…一句话…"`（Claude Code 是 `claude --resume <id> --fork-session`）得到一个新的原生会话 id。**不要让两个进程同时写同一个会话**（Agora 的和你终端里还开着的），日志会被两边交错写坏；接进来的是分叉出来的那份。
2. 绑定：`curl -X PUT http://127.0.0.1:<端口>/api/agent/sessions/<Agora 会话 id> -H 'content-type: application/json' -d '{"agent":"pi","model":"","effort":"","nativeId":"<新原生会话 id>","started":true}'`。`started: true` 表示这个原生会话已经有日志了，以后只会被接着用（`--resume`），不会当成新会话再建。日志要在这个项目对应的 CLI 会话目录下（Pi：`~/.pi/agent/sessions/--<项目路径，斜杠换成横线>--/`，首行 `cwd` 是项目路径），找不到时面板会说日志不见了。
3. 页面收到绑定和整段 transcript（`transcript` 事件带 `reset`）。以前页面没有这个会话自己的 session，历史在 store 里却没有地方显示（agent 小标签一点开的是页面自己新建的空会话，只有「怎么用」）；现在页面给每个「有绑定、没有 session」的会话补一个（`session/adoptBound.ts`，画布取最近一个会话所在的画布，否则当前打开的），列表里有它，agent 标签一点就打开，历史按轮显示。
4. 摘要（`GET /api/agent/sessions/<id>/summary`）的开头只在原生日志真的找不到时才说「原来的原生会话记录已经丢失」；日志在的话写「下面是这个会话此前的对话摘要」（`summary_head`）。

Pi 日志里的 `system` 消息、`custom`（扩展写的）、`bashExecution`、`compaction`、`parentSession` 都不会让轮次丢掉或分组失败（`tests/test_transcript.py` 有一份这样的小夹具）。

## 改图交给哪个页面（BR1）

`agora canvas read/apply/anim/link/child` 由一个打开的 Agora 页面执行（它持有画布、做校验、记撤销）。挑页面的顺序（`server/canvas/executors.py`）：

1. 上一次被问时答上来了的页面在前，没答上来的排到所有页面后面，直到它再答上来一次；
2. 看得见的页面（`document.visibilityState === "visible"`）优先；
3. 最近获得焦点的；
4. 最近连上来的。

请求先交给第一个页面；它 6 秒内没有**认领**，就把同一个请求交给下一个，全部加起来不超过 25 秒。**页面认领之后才执行**：服务端只把认领给正被交给的那个页面、且只给一次，所以被跳过的页面（比如浏览器冻住的后台标签）过后醒来，认领会被拒绝，它不会去执行；它迟到的回报也会被丢掉。已经认领的页面不会被换掉（它的改动可能已经落在它的画布上），服务端一直等它回报，等不到就报「页面已接手这次改图但没有回报：图上可能已经改了，先看一眼图，再决定要不要重试」；没有页面认领时报「开着的 Agora 页面都没有回应：把 Agora 的标签页切到前台再试一次」。

`apply` 本身不是幂等的（每次都生成新的批次、新的元素）；靠上面的认领保证一个请求只被一个页面执行一次。分享链接的访客页面不当执行者：分享网关只提供 `/api/guest/*`，访客连不到 `/api/agent/events`。

### 画不上去时自己找地方画（BR2）

页面都不认领（或根本没有页面）时，Agora 不让用户动手，按顺序自己想办法，**前一步不行才走后一步**，每一步都写进这次 `agora canvas apply` 返回的 `notes`（agent 在轨迹里看得到、也会转述）；`server/canvas/page_help.py` 是这段流程：

1. **已有页面里挑**（上面 BR1）。有页面**认领了却没回报**（`PageTookIt`）就停在这里报错，不走后面几步：那次改图可能已经落在它的画布上，绝不再换个地方执行第二遍。
2. **自己打开一个页面**：用系统的打开命令（macOS `open`，其他 `xdg-open`）打开这个项目的地址（`run/server.json` 里的 `url`）。同一个项目 **2 分钟内最多自动打开一次**（不开一堆标签）；偏好里可以关掉，**默认开**（`GET/PUT /api/agent/auto-open`，存在 `.agora/local/settings.json` 的 `autoOpenPage`，不提交；页面上的开关还没做，要关先 `curl -X PUT …/api/agent/auto-open -d '{"enabled":false}'`）。新页面带 `executor=2` 连上来最多等 15 秒，连上就把同一个请求交给它（它也要先认领，同一批只落一次）。
3. **服务端直接改文件**（`server/canvas/fallback.py`）：只对 `apply`。做和页面一样的三项检查：结构（`web/generated/plan.schema.json`）、引用、新鲜度，然后改 `.agora/canvases/<id>.excalidraw`，并写一份和页面一样的撤销记录（会话里的一轮 + 一个批次，页面里照样能「撤销」）；之后页面连上来直接读这份文件，页面在此期间保存的手改会和它冲突、由页面报告，不会被覆盖（`project.py` 的带版本写入）。**能力比页面小，而且是有意的**：改图引擎（`applyPlan`：摆放、连线、素材库）不复制到 Python，服务端只做不需要引擎的操作，眼下是「改节点或画框的文字」；别的（`move`、`resize`、`add_shape`、`add_arrow`、`delete`、`insert_library_item`，以及箭头和素材库组件的文字）一律在改任何东西之前返回 `needs-page`，写明「这条要打开页面才能做」，**整条计划一条都不执行**。`fallback.EXTRA_OPS` 是以后布局 / lint 模块登记「不需要页面也能做」的操作的地方。
4. 三步都不行才报错，话里说清每一步试了什么（「开着的页面…没有认领；自己打开了页面…没连上；服务端直接改文件也做不了这一种」）。`link`、`child`、`anim` 没有服务端后备（它们要页面持有的工作区或动画播放器），走 1、2 之后直接是这条报错。

**校验只有一份规则**：`web/generated/plan.rules.json`（每个 op 收哪些字段、每个字段能指向哪几种元素、各种上限、`ref` 的正则）。页面的 `validatePlan`（`web/src/ops/ops.ts`）读它，服务端的 `server/canvas/plan_rules.py` 读它（`load()` 和 `scene_kinds()` 是给布局、lint 这些服务端工具复用的），`web/generated/plan.cases.json` 是两边必须给出**完全相同**错误的同一批用例（`web/src/ops/planRules.test.ts`、`tests/test_plan_rules.py` 各跑一遍）。规则文件里少一种元素类型，两边一起变；只改一边，两个测试里有一个会红。新鲜度是 `staleIds`（`web/src/canvas/context.ts`）在服务端的孪生（`plan_rules.stale_ids`，版本串用 `model_view.version_of`）。结构 schema 还是原来从 TS 生成的 `plan.schema.json`。
