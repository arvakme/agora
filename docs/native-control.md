# 原生会话控制契约

本文写顺序、权限、事实归属和理由。字段、状态名和 schema 只在 [`native_protocol.py`](../native_protocol.py) 定义一次；非 Python 消费者用 `python -m native_protocol` 导出的 schema，不另抄字段表。产品目标见[工作台计划](canvas-workbench-plan.md)。

## 1. 谁拥有哪个事实

Agora/Postgres 拥有 Room、成员、协作请求、公开结果和 Master 验收。宿主只拥有三样东西：本机实际会话、当前输入权，以及自己尚未看到确认的传输记录。传输记录不是第二套可编辑任务池，也不是第二个状态机——它回答"这条请求我确认到哪一步"，不回答"这件事该不该做"。

各 CLI 拥有自己的对话记录。宿主保存定位信息指向它，不复制 transcript，不把它当成 Room 消息。

会话标识（tmux target、pane、工作目录、原生 session id）全都不是凭据。控制某个会话的权限来自 Agora 签发的宿主身份；标识对得上不构成授权。

## 2. 三种"完成"必须分开

- **input accepted**：CLI 自己说它收下了这条输入。
- **execution completed**：CLI 自己说这一回合跑完了。
- **master accepted**：Master 在 Agora 里做出的语义判断。它不在宿主的状态机里，所以 `native_protocol` 没有这个状态。

投递成功不是接收，接收不是完成，完成不是验收。`tmux send-keys` 返回 0、终端安静下来、屏幕上打出一句 done——三者都只是传输或渲染。契约里的证据类型因此不包含终端文本，这是故意的：一旦允许按屏幕文本判定生命周期，就会长出一个 ANSI 状态机，而它在换行、重绘和多客户端下必然错。

进程退出同样不能顶替完成。CLI 退了不等于模型任务做完了，CLI 还活着也不等于它失败了。

## 3. 顺序约束

1. 请求先在 Agora 持久化，再发通知。通知只表示"有更新"，重连按游标补读；通知可以合并，请求不能。
2. 宿主把请求交给适配器之后、拿到原生 ACK 之前，是**注入窗口**。崩在这个窗口里，状态是不确定，不是失败也不是成功。
3. 不确定的、有副作用的请求不自动重投，先核对原生现场。无副作用的请求可以重投。任何情况下都不承诺模型副作用 exactly-once。
4. 事件按稳定身份幂等提交。重复的结果只补一次确认，不重复发帖、不重复唤醒。
5. 取消请求只停止投递；物理回合可能还在跑。取消之后到达的结果被记为迟到结果，不能变成有效完成。
6. 同一会话的输入走串行通道，一次只有一条在途请求，所以"下一个完成事件属于哪条请求"是确定的。

## 4. 输入权与 attach

默认入口是只读 attach，它不取输入权，也不启动第二个推理进程。

人工接管是排他的：取得输入权、暂停自动投递、连到同一个现场。接管不隐式取消正在跑的回合。detach 不是归还也不是取消；控制连接异常中断时保持暂停，等明确归还。发现本部署没发出去的可写客户端时暂停自动投递，不强踢用户——tmux 的多客户端机制对同一 OS 用户不是沙箱，产品只保证覆盖受控入口。

## 5. 各 CLI 接缝的实测事实

P0 在专属 tmux socket 上用真实 CLI 验证。每种 CLI 的差异只落在三处：启动/恢复命令、可用的输入通道、可信的回执来源。

| CLI | 输入通道 | input accepted 来源 | execution completed 来源 |
| --- | --- | --- | --- |
| Claude Code 2.1.267 | tmux 粘贴缓冲 | `UserPromptSubmit` hook | `Stop` hook |
| Codex 0.153.4 | `codex queue --thread <uuid>` | 队列 ACK（返回 message id 与 thread id） | `notify` 的 `agent-turn-complete` |
| Pi 0.85.1 | 原生 TUI，人或 Master 自己输入 | 不适用（Pi 是调用方） | 不适用 |

已验证的细节和理由：

- Claude Code 没有向运行中的 TUI 注入消息的官方命令，所以输入只能走终端；但生命周期完全由官方 hook 提供。`--settings` 让 hook 只作用于本次会话，`--session-id` 让宿主先定身份再启动，`SessionStart` hook 回传 transcript 路径作为原生定位。
- Codex 的 thread id 在第一回合之前不存在。宿主对新会话的第一条输入只能走终端，从 `notify` 回执里取得 thread id，此后改用 `codex queue`。这是首版接受的两段式，不是可以省掉的步骤。
- Codex 的 `notify` 也会为它自己的内部回合（例如生成 thread 标题）触发，thread id 与用户线程不同。回执必须按 thread/turn 相关联后才算数，不能"收到一条 notify 就当完成"。
- Codex 的 hooks 走 `$CODEX_HOME/hooks.json` 且带信任门；本单不改用户全局配置，也不加信任绕过旗标，因此只用了每次运行可覆盖的 `notify`。用 `-c` 注入一次性 hook 是否可行**未验证**。
- Grok 1.0.25 的帮助没有暴露足够的接收/完成信号，本轮不纳入自动派发；缺可靠接缝的 CLI 明确阻塞，而不是用屏幕正则补成假状态机。

只读 attach 与写者检测用 tmux 客户端属性核实：只读客户端 `client_readonly=1`，同现场的可写客户端计数即"未纳管写者"。attach 前后 CLI 进程号不变，确认是同一现场而不是新进程。

## 6. 后续工单的写入路径

共享文件只有一个写者。本单落定 `native_protocol.py` 与本文；下列工单按路径并行，不重叠：

| 工单 | 拥有的路径 | 消费的契约 |
| --- | --- | --- |
| #19 本机宿主 | `daemon/` | 会话与传输记录的状态推进、输入权、受控 attach |
| #20 授权与持久投递 | `server/` | 请求持久化先于通知、游标补读、身份与提交幂等 |
| #21 部署入口 | 部署与启动脚本 | 专属 socket/目录与单实例锁 |
| #22 Pi 集成与旧执行链删除 | Pi 扩展目录及被替换的旧路径 | 同一份契约，扩展只是调用方 |

原生路径替换到位时应一并删除的旧执行入口（本单不动它们）：`server/scheduler.py` 注入的 `TurnFn` 图执行、`server/k8s.py` 的云 turn 宿主、`daemon/main.py` 的 BYOA 推理循环、`brain/` 的 LangGraph 图与 `brain/job.py` 一次性入口，以及它们各自的配置、依赖与 `tests/test_brain.py`、`test_byoa.py`、`test_k8s.py`、`test_moderated.py` 中失去消费者的部分。删除责任属于 #22，迁移按调用关系收口，不保留旧引擎回退开关。

图内已有的预算、取消后提交权限和使用量记账不会自动覆盖外部 CLI；没有原生 usage 的执行标为未知，不伪造零消耗。
