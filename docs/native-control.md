# 原生会话控制契约

本文写顺序、权限、事实归属和理由。字段、状态名和 schema 只在 [`native_protocol.py`](../native_protocol.py) 定义一次；非 Python 消费者用 `python -m native_protocol` 导出的定义。产品目标见[工作台计划](canvas-workbench-plan.md)，范围与验收以对应 Issue 为准。

**契约未冻结。** 取消/停止在两种已安装 CLI 上都没有可信的原生终态信号（见第 6 节），这一条未解决之前不应据本文并行实现。

## 1. 谁拥有哪个事实

Agora/Postgres 拥有 Room、成员、请求、公开结果和 Master 验收。**授权来自已认证的 Agora 连接以及服务端把该连接绑定到某个 Room 成员与 Computer**；本文件里的每个标识符（`request_seq`、`participant_id`、`computer_id`、tmux target、工作目录、`native_locator`）都只是地址，宿主同样能写出来，都不是凭据也不是证明。`request_seq` 只用于排序与重连补读。请求是否有效由后端在提交时校验。

宿主只拥有本机实际会话、当前输入权和自己尚未确认的传输记录。各 CLI 拥有自己的对话记录；关联只用 CLI 自己的标识。

## 2. 关联：一条请求绑定到哪个原生回合

事件只能影响它指名的那个原生回合所属的请求：

- 事件必须来自该会话（`NativeEvent.session == native_locator`），否则是外来事件。
- 请求一旦绑定某个回合，其它回合的事件也是外来事件；CLI 自己发起的内部回合因此不会冒充结果。
- 未绑定的请求不能被任何结果收敛。先到的结果**留在 `deferred_events` 里，不算已确认**，绑定出现时用同一个稳定 ID 恰好折叠一次；再次重放只补 ACK。未应用的事实不会被提前去重掉。
- 需要回合的事件（接收、完成、失败）必须带回合标识；会话启动、等待、退出没有回合，用会话级事件表达，不编造回合。

各 CLI 的绑定来源（官方载荷，实测）：

| CLI | 会话标识 | 回合标识 | 何时可得 |
| --- | --- | --- | --- |
| Claude Code 2.1.267 | hook 的 `session_id`（宿主用 `--session-id` 先定） | hook 的 `prompt_id` | `UserPromptSubmit` 即得 |
| Codex 0.153.4 | rollout 记录的 `thread_id` | rollout 记录的 `turn_id` | 首个回合写入记录之后 |

Codex 的 `codex queue` 回执给的是队列条目 id；`notify` 的 `input-messages` 是整线程历史。两者都不能绑定。绑定读**本部署自己那个会话**的 rollout 文件：宿主在正文里带每请求唯一的标记，在该文件里找到那一条用户消息条目取得回合。宿主不遍历、不读取其它会话的记录。新会话的身份从**本部署自己启动的那个进程**的文件描述符上读出（它打开的 rollout 路径），因此不需要枚举任何人的历史；Codex 只在首个回合开始后才打开该文件，所以新会话要先跑一次一次性引导回合。Claude Code 不需要，会话 id 由宿主在启动前决定。

## 3. 三种"完成"必须分开

- **input accepted**：CLI 自己指明我们的输入成了哪个回合。
- **execution completed**：CLI 自己说那个回合结束了。
- **master accepted**：Master 在 Agora 里的语义判断，不在宿主状态机里。

投递成功不是接收，接收不是完成，完成不是验收。终端安静、屏幕文本、模型打出一句 done、tmux 命令返回 0 都不是证据。实测补充：向正显示模态视图的 CLI 粘贴，tmux 返回 0 而输入被静默丢弃。

进程退出既不能完成也不能失败一个回合。回合中退出的结果是不确定。

## 4. 撤销与物理回合是两件事

`withdrawn` 是请求权威的决定，一旦作出就不会被宿主后来知道或不知道的任何事情撤回——进程退出、宿主重启、迟到的原生完成都不行。被撤销的请求永远不再投递。

物理回合是另一件事：它仍可以绑定、自然完成或失败。迟到的物理结果按事实记进记录留证，但 `publishable_result` 不会把它交给 Agora。物理回合落定之后会话的输入通道才释放；不为了守住某个状态标签而永远等待一个不会到来的中断回执。

其余顺序约束：请求先在 Agora 持久化并拿到序号再发通知，通知只表示"有更新"；注入窗口内崩溃的状态是不确定；不确定且有副作用的请求先核对 CLI 自己的记录，不自动重投；终态不可翻转，重复结果只补确认；同一会话串行输入，锁由宿主（#19）实现，契约只在 `SessionGate` 要求宿主如实报告并据此拒绝投递。任何情况下都不承诺模型副作用 exactly-once。

## 5. 输入权与 attach

默认入口是只读 attach，它不取输入权，也不启动第二个推理进程。人工接管排他，且不隐式取消正在跑的回合。detach 不是归还，控制连接中断保持暂停——这两条是宿主（#19）的义务。发现本部署没发出去的可写客户端时暂停自动投递，不强踢用户。

实测的 tmux 约束（3.7b，本部署的专属 socket）：tmux 为 `send-keys` 解析该会话的当前客户端，当那个客户端是只读时拒绝执行（`client is read-only`，退出码 1），无论命令从哪里发起。`paste-buffer` 不受此限制，并且实测能把正文、CR 和 ESC 原样送进 raw 模式的 pane。因此：

- 正文与提交键走 `paste-buffer`（提交键必须是**单独一次**粘贴，两种 TUI 都会吞掉混在同一次粘贴里的换行）。
- 需要按键语义的操作（停止键）走 `send-keys`，这要求本部署自己的可写客户端是该会话的当前客户端；宿主在必要时重新接入自己的客户端即可，只读观察者可以全程保持连接。
- 「未纳管写者」指本部署自己的客户端之外的可写客户端。

这不是所有 tmux 部署的通则，是本版本在本部署入口下实测到的行为。

## 6. 各 CLI 接缝的实测事实

| CLI | 输入通道 | input accepted | execution completed | 原生用量 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.267 | `paste-buffer` 正文 + 单独一次提交键 | `UserPromptSubmit` hook | `Stop` hook | 无，标为未知 |
| Codex 0.153.4 | `codex queue --thread` | 本会话 rollout 里的用户消息条目 | `notify` 的 `agent-turn-complete`，按回合核对 | `token_usage_record`，逐回合真实 |
| Pi 0.85.1 | 原生 TUI，扩展工具调用宿主 | 不适用（Pi 是调用方） | 不适用 | 不适用 |

- 权限等待只认安装版本自己的通知类型（`permission_prompt`、`worker_permission_prompt`）。`idle_prompt`、`agent_needs_input` 等不是权限阻塞，不做推断。这些类型取自安装版本，本轮运行中未触发过，尚未在运行时验证。
- Codex 的键盘提交不可靠：紧跟粘贴之后的提交键会被吸收，是否提交取决于时序；它的原生队列没有这个问题。
- Codex 的 hooks 在 `$CODEX_HOME/hooks.json` 且带信任门；本单不改用户全局配置，只用每次运行可覆盖的 `notify`。
- Grok 1.0.25 未纳入自动派发。

### 未解决（阻塞冻结）

**停止一个回合之后，两种 CLI 都不报告任何终态。** 实测：Claude Code 的回合被停止后只有 `UserPromptSubmit`，没有 `Stop`，也没有任何空闲通知，TUI 把提示词放回输入框；Codex 被停止的回合在自己的 rollout 里只有 `task_started` 与用户消息条目，没有 `task_complete` 或任何中止记录，`notify` 也不触发。自然结束的回合两者都有完整终态（已多次实测）。

因此契约里**没有**"中断已确认"这种事件——没有信号来源的事件只是协议形状冒充能力。后果是：被停止的回合停在不确定，会话的输入通道无法凭已验证的信号释放。这一条必须先解决，否则取消路径不能并行实现。

已知候选、尚未运行时验证：Codex app-server 协议的 `turn/interrupt`（必需 `threadId`+`turnId`，响应仅 ACK）与 `TurnCompletedNotification` 的 `turn.status=interrupted`（schema 来自安装版本，见工单 T-60578d）。同一取证确认独立 `codex app-server --listen stdio://` 的握手成立，但那不等于能控制一个已经在跑的原生 TUI；Unix/WebSocket 传输实测失败。要验证必须让真实原生 TUI 从一开始就连到本部署自有且已验证的端点，控制与 attach 指向同一回合。

## 7. 后续工单的写入路径（建议，最终由主持人裁定）

共享文件单写者。`native_protocol.py` 与本文在冻结前由本单执行者维护。

| 工单 | 建议拥有的路径 | 只消费的契约 |
| --- | --- | --- |
| #19 本机宿主 | `daemon/native/`、`daemon/README.md`、`tests/test_native_host.py` | 会话身份、投递与撤销、事件订阅、持久传输日志；实现串行通道与接管锁 |
| #20 授权与持久投递 | `server/` 中请求生命周期与身份授权的整体收口（含现有公开入口的改造，不是只加一张表）、`server/schema.sql`、对应测试 | 请求有效性、提交时校验、按序号补读、幂等确认 |
| #21 部署入口 | 启动脚本、`docker-compose.yml`、`Dockerfile`、`README.md` 中的部署说明 | 专属 socket 与目录、单实例锁 |
| #22 Pi 集成与旧执行链删除 | Pi 集成目录与被替换的旧路径 | 同一份契约；扩展只是调用方，不拥有第二个状态机或 Worker 池 |

原生路径替换到位时应一并删除的旧执行入口（本单不动）：`server/scheduler.py` 注入的 `TurnFn` 图执行、`server/k8s.py` 的云 turn 宿主、`daemon/main.py` 的 BYOA 推理循环、`brain/` 的 LangGraph 图与 `brain/job.py`，以及 `tests/test_brain.py`、`test_byoa.py`、`test_k8s.py`、`test_moderated.py` 中失去消费者的部分。删除责任属于 #22。

图内已有的预算、取消后提交权限和使用量记账不会自动覆盖外部 CLI。没有原生用量的执行标为未知，不伪造零消耗。
