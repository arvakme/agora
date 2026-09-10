# 原生会话控制契约

本文写顺序、权限、事实归属和理由。字段、状态名和 schema 只在 [`native_protocol.py`](../native_protocol.py) 定义一次；非 Python 消费者用 `python -m native_protocol` 导出的定义。产品目标见[工作台计划](canvas-workbench-plan.md)。

契约尚未冻结：本文区分「已实证」「本单只定义、由后续工单实现」和「未证实」，冻结由主持人裁决。

## 1. 谁拥有哪个事实

Agora/Postgres 拥有 Room、成员、请求、公开结果和 Master 验收。请求的权威身份是 `RequestOrigin`：房间、Agora 的单调 `request_seq` 和发起成员。宿主无法伪造这个序号，所以契约里没有宿主自报的 "已持久化" 布尔值；同一个序号也是重连补读的游标。

宿主只拥有本机实际会话、当前输入权和自己尚未确认的传输记录。传输记录回答"这条请求我确认到哪一步"，不回答"这件事该不该做"，也不是第二套任务池。

各 CLI 拥有自己的对话记录。关联只用 CLI 自己的标识（`NativeTurn`），不用宿主写进去的文本，也不用终端画面。

会话地址（tmux target、pane、工作目录、`native_locator`）都不是凭据。控制权来自 Agora 签发的 `participant_id` / `computer_id`；地址对得上不构成授权。

## 2. 关联：一条请求绑定到哪个原生回合

这是本契约最重要的一条。事件只能影响它指名的那个原生回合所属的请求：

- 事件必须来自该会话（`turn.session == native_locator`），否则是外来事件。
- 请求一旦绑定某个回合，其它回合的事件也是外来事件。同一个 CLI 内部自己发起的回合因此不会冒充结果。
- 没有绑定过的请求不能被任何结果收敛。缺少接收信号时，状态停在不确定，而不是接受一个来路不明的完成。

各 CLI 的绑定来源（均为官方载荷，实测）：

| CLI | 会话标识 | 回合标识 | 何时可得 |
| --- | --- | --- | --- |
| Claude Code 2.1.267 | hook 的 `session_id`（宿主用 `--session-id` 先定） | hook 的 `prompt_id` | `UserPromptSubmit` 即得 |
| Codex 0.153.4 | rollout 记录的 `thread_id` | rollout 记录的 `turn_id` | 首个回合写入记录之后 |

Codex 的 `codex queue` 回执给的是队列条目 id，不是回合 id；`notify` 的 `input-messages` 是整个线程的历史，会命中旧消息。两者都不能用来绑定。绑定用 CLI 自己的 rollout 记录：宿主在正文里带一个每请求唯一的标记（`binding_marker`），在记录里找到那一条用户消息条目，取得它的 `thread_id`/`turn_id`，之后全部按原生标识关联。标记是关联手段，不是证据。

Codex 在第一个回合之前不写任何记录，所以新会话要先做一次**认领**：投递一条一次性引导消息，从记录里取得线程身份，之后的请求才可关联。Claude Code 不需要，因为会话 id 由宿主在启动前决定。

## 3. 三种"完成"必须分开

- **input accepted**：CLI 自己指明我们的输入成了哪个回合。
- **execution completed**：CLI 自己说那个回合结束了。
- **master accepted**：Master 在 Agora 里的语义判断。它不在宿主状态机里，所以 `native_protocol` 没有这个状态。

投递成功不是接收，接收不是完成，完成不是验收。终端安静、屏幕文本、模型打出一句 done、`tmux` 命令返回 0，都不是证据，证据类型里因此没有终端文本这一项。

进程退出既不能完成也不能失败一个回合：CLI 退了不等于模型做完了，也不等于它失败了。回合中退出的结果是不确定。

## 4. 顺序约束

1. 请求先在 Agora 持久化并拿到序号，再发通知。通知只表示"有更新"，重连按序号补读；通知可合并，请求不能。
2. 交给适配器之后、拿到原生接收之前是**注入窗口**。崩在这里状态是不确定。
3. 不确定且有副作用的请求先核对 CLI 自己的记录，不自动重投；无副作用的可以重投。任何情况下都不承诺模型副作用 exactly-once。
4. 终态不可翻转。已完成的回合不会被迟到的取消确认或失败事件改写，重复的结果只补一次确认。
5. 后端撤销请求与物理回合停止是两件事。撤销发生在投递之前，什么都没注入；发生在投递之后，请求进入"等待中断确认"，此后到达的结果一律记为迟到，只有原生的中断确认才让它变成已取消。
6. 同一会话串行输入：一次只有一条在途请求。这个锁由宿主实现（#19），契约只在 `SessionGate` 里要求宿主如实报告，报告不成立就拒绝投递。

## 5. 输入权与 attach

默认入口是只读 attach，它不取输入权，也不启动第二个推理进程。人工接管排他：取得输入权、暂停自动投递、连到同一个现场，且不隐式取消正在跑的回合。detach 不是归还，控制连接中断保持暂停——这两条是宿主（#19）的义务，契约里没有假装用纯函数实现它们，只把结果作为 `SessionGate` 的输入。发现本部署没发出去的可写客户端时暂停自动投递，不强踢用户。

实测约束：只要有只读客户端 attach 在该会话上，`tmux send-keys` 就被拒绝（`client is read-only`，退出码 1），而 `paste-buffer` 不被拒绝且缓冲区末尾的换行会提交。因此键盘投递必须走 `paste-buffer`，不能用 `send-keys`，否则产品承诺的"默认只读观察"会把自动投递挡死。Codex 走它自己的 `codex queue`，不受这个影响。

## 6. 各 CLI 接缝的实测事实

| CLI | 输入通道 | input accepted | execution completed | 原生用量 |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.267 | `paste-buffer`（含换行） | `UserPromptSubmit` hook | `Stop` hook | 无，标为未知 |
| Codex 0.153.4 | `codex queue --thread` | rollout 记录里的用户消息条目 | `notify` 的 `agent-turn-complete`，按回合核对 | `token_usage_record`，逐回合真实 |
| Pi 0.85.1 | 原生 TUI，扩展工具调用宿主 | 不适用（Pi 是调用方） | 不适用 | 不适用 |

- Claude Code 没有向运行中的 TUI 注入消息的官方命令，生命周期完全由官方 hook 提供；`--settings` 让 hook 只作用于本次会话。`Notification` 的 `idle_prompt` 是空闲提醒，不是权限阻塞，不能当权限等待。
- Codex 的键盘提交不可靠：紧跟粘贴之后的 Enter 会被 TUI 吸收，是否提交取决于时序。它的原生队列没有这个问题，所以 Codex 只走队列。
- Codex 的 hooks 在 `$CODEX_HOME/hooks.json` 且带信任门；本单不改用户全局配置也不加信任绕过旗标，因此只用了每次运行可覆盖的 `notify`。用 `-c` 注入一次性 hook 是否可行**未验证**。
- Grok 1.0.25 的帮助没有暴露足够的接收/完成信号，本轮不纳入自动派发。缺可靠接缝的 CLI 明确阻塞，不用屏幕正则补成假状态机。

### 尚未证实

- **取消**：`interrupt_confirmed` 目前只有契约定义，两种 CLI 都还没有实测到的原生中断确认来源。取消路径不得按已验证对待。
- **Codex 回合前身份**：安装版本的 app-server 协议里有 `thread/loaded/list`、`turn/start`、`turn/interrupt`，但本轮在自建 unix 监听上没有完成握手，因此回合前身份和原生中断都未证实，认领回合暂时是必需的。
- **只读观察下的整条模型往返**：传输层已用不发模型请求的方式证明（只读 attach 下 `paste-buffer` 提交成功），生命周期已在无观察者时证明，两者的合并运行本轮未再跑。

## 7. 后续工单的写入路径

共享文件单写者。`native_protocol.py` 与本文在冻结前由本单执行者维护，冻结后移交 #19；其余工单不得写这两个文件。

| 工单 | 新增/拥有的路径 | 只消费的契约 |
| --- | --- | --- |
| #19 本机宿主 | `daemon/native/`（会话注册、各 CLI 适配、tmux 传输、事件订阅、持久传输日志）、`daemon/README.md`、`tests/test_native_host.py` | `NativeSession`/`NativeTurn`/`NativeEvent`/`DeliveryRecord`；实现串行通道与接管锁 |
| #20 授权与持久投递 | `server/native_requests.py`、`server/schema.sql` 的新增表、`tests/test_native_requests.py` | `RequestOrigin`/`DeliveryRequest`/`TurnResult`；请求先持久化再通知、按序号补读、幂等提交 |
| #21 部署入口 | `scripts/native/`、`docs/deployment.md` | 专属 socket 与目录、单实例锁 |
| #22 Pi 集成与旧执行链删除 | `integrations/pi/agora-control/`、旧路径的删除 | 同一份契约；扩展只是调用方，不拥有第二个状态机或 Worker 池 |

原生路径替换到位时应一并删除的旧执行入口（本单不动）：`server/scheduler.py` 注入的 `TurnFn` 图执行、`server/k8s.py` 的云 turn 宿主、`daemon/main.py` 的 BYOA 推理循环、`brain/` 的 LangGraph 图与 `brain/job.py`，以及 `tests/test_brain.py`、`test_byoa.py`、`test_k8s.py`、`test_moderated.py` 中失去消费者的部分。删除责任属于 #22，迁移按调用关系收口，不保留旧引擎回退开关。

图内已有的预算、取消后提交权限和使用量记账不会自动覆盖外部 CLI。没有原生用量的执行标为未知，不伪造零消耗。
