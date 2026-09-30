# Agora 后端编排：一页面试讲法

完整设计、状态图和时序图见 [Agent 生命周期](orchestration.md)。本页只写有仓库证据的内容；提交号是并入 main 之前的分支提交（`origin/feat/excalidraw-workbench`，main 上合并为 `a19b45a`，两者的树完全一致），测试写作 `文件::测试名`，文档写路径。

## 一句话

Agora 是给 coding agent（Pi、Claude Code、Codex 等）用的**控制平面**：不写 agent 循环、不碰模型，只负责会话身份、进程托管、投递与输入权仲裁、派发记录与重启对账、画布改图的执行权——让用户自选的原生 CLI 在同一个项目里顺畅协作，并且每个「已送达 / 已完成」都有原生证据。

## 三个最能体现思考的设计决策

**1. 不包框架：原生会话就是会话，对话以 CLI 自己的日志为准。**
- 备选：自己写 agent 循环；或房间调度 + LangGraph + Postgres/Redis（项目早期真做过）。
- 为什么：终端和面板用同一个原生 id，哪边说的话另一边都接得上；CLI 升级带来的能力直接可用，不用我跟。
- 代价：每家日志格式、协议都要适配，还要防漂移（`tests/test_adapter_contracts.py`、`agora doctor --agents`）；能力被 CLI 卡住（Grok、Cursor、Devin 的 `-p` 不能中途插话：`tests/test_steer.py::test_a_cli_that_cannot_steer_refuses_a_steer_and_says_why`）。
- 出处：删除房间链 `e4bdee1`；[`AGENTS.md`](../AGENTS.md)；[Agent 会话](../web/docs/agent-sessions.md)。

**2. 证据分级，宁可报「未知」也不重发有副作用的东西。**
- 备选：让模型自己报 done；或看终端屏幕文字、tmux 返回值判断；或 at-least-once 重投。
- 为什么：tmux 成功、终端安静、模型打出 done 都不是原生证据；只有 CLI 自己的日志 / 钩子 / 通知能绑定并结束一个回合（`native_protocol.py::ACCEPT_EVIDENCE`、`OUTCOME_EVIDENCE`）。注入之前先把 `in_flight` 落盘，崩在注入窗口里就是 `uncertain`，重启只对账不重发（`native_protocol.py::plan_recovery`，`tests/test_native_protocol.py::test_uncertainty_reconciles_before_a_side_effecting_request_runs_again`）。
- 代价：不承诺 exactly-once（契约原话）；状态会晚一拍（日志每 0.4 秒跟随一次）；终端 pane 里的一轮停不下来，只能如实记 `unknown`。
- 出处：[原生会话控制契约](native-control.md)、[派发](dispatch.md)、`tests/test_dispatch.py::test_after_a_restart_nothing_that_may_have_been_injected_is_sent_again`。

**3. 谁来执行 agent 发起的改图：先认领再执行，认领之后绝不换人。**
- 备选：发给最近连上来的页面；或广播给所有页面。
- 为什么：`apply` 不幂等，同一批改图落两次就是两份元素。所以服务端按「答得上来、可见、最近聚焦、最近连接」排序逐个交给页面，只把认领给正被交给的那一个、且只给一次；被跳过的页面醒来认领被拒，迟到的回报被丢；已认领的页面等它回报，不换人，等不到就让 agent 先看图再决定重试（`tests/test_executors.py::test_a_page_that_does_not_take_it_is_skipped_and_its_late_answer_is_dropped`、`tests/test_executors.py::test_a_page_that_took_it_is_waited_for_not_replaced`）。
- 代价：多一轮握手；页面都不认领时要走降级（自己开页面、服务端直接改文件），降级只做少数不需要改图引擎的操作。
- 出处：`afcdfc4`；[Agent 会话「改图交给哪个页面」](../web/docs/agent-sessions.md)。

## 三个真实踩过的坑

**1. Linux 上死服务留下的进程没被结束。** 服务重启时，靠「pid 仍在跑登记的那条命令」才动手（pid 会被复用）。Linux 的 `ps` 输出到管道时把命令行截到 `$COLUMNS`（pytest 下是 80），长命令比对不相等，就不动手，孤儿留着。修法是所有 `ps` 带 `-ww`，并加了测试。提交 `89298f1`；`tests/test_proctree.py::test_the_command_of_a_process_is_whole_even_when_the_terminal_is_narrow`；代码 `server/canvas/proctree.py`。

**2. 重启时把早已送达的回执又发了一遍。** 「重启后补发没送到的回执」上线后，把两条早已送达的派发回执重发了，两个会话各多跑了一轮。原因：这些记录早于回执标记格式，派活方日志里本来就没有标记，被当成没送到。修法：发通知时在记录里写下 `notice.mark`，只对「记录写明带过标记、日志里却找不到」的补发，老记录一律不补；并新增一条规则——凡是改了「重启时自动做事」的逻辑，先拿现有记录空跑一遍。提交 `4965adf`（引入）、`993cd89`（修复）；`tests/test_dispatch.py::test_an_old_record_without_the_marker_field_is_not_told_again_after_a_restart`；`.agents/acceptance/common-mistakes.md` 的 P13。

**3. 页面开着时，服务收到 SIGTERM 停不下来。** uvicorn 关闭时等所有连接自己断开，而页面的事件流（SSE）永远不会自己断；第二个 SIGTERM 对 uvicorn 也不起作用。修法：收到信号后由服务端主动结束事件流，收尾每一步有时间上限，20 秒看门狗兜底。提交 `3d9065b`；`tests/test_shutdown.py::test_a_server_with_pages_open_exits_on_the_first_sigterm`；代码 `server/canvas/shutdown.py`。

*同类的一个教训（决策 3 的来历）：被冻住的后台标签、或验收时连到正式后端的旁路页面，会抢到用户会话的改图却不回报——`afcdfc4`、`.agents/acceptance/common-mistakes.md` 的 P12。*

## 会被追问的问题，和诚实的回答

| 问题 | 回答 |
|---|---|
| 这不就是用了别人的 harness 吗？ | 是，而且是有意的：agent 循环、模型、工具循环都不是我的。我拥有的是它们外面的那层——身份、托管、投递、证据、恢复、清理、改图执行权；每一项都有代码和测试，见 [生命周期](orchestration.md) 第 3 节。 |
| 为什么不用 LangGraph 之类的编排框架？ | 早期用过（房间调度 + LangGraph + Postgres/Redis），后来整条链删掉，只留原生会话一条路径（`e4bdee1`）。我没有留下两种方案的量化对比，不能说它「更好」，只能说这层需求是对账和托管，不是流程图。 |
| 能保证任务只执行一次吗？ | 不能，契约里明说不承诺。能保证的是：有副作用的请求在不确定时不会被重发，不确定会被显示出来（`native_protocol.py::plan_recovery`）。 |
| 怎么判断 sub agent 做对了？ | 判断不了，也没假装：Agora 记录的是事实（接没接、回合结束没、回执是什么），`done` 只表示对方自己说完成且回合结束了。检查工作是派发方 agent 的事。 |
| 什么时候派发、怎么拆任务？ | 由 agent 自己决定，Agora 只提供通路和记录。依赖图派发、验收循环、预算、编排评测都是没做的方向（见 [生命周期](orchestration.md) 第 5 节）。 |
| 两个 agent 同时改同一个文件怎么办？ | 没有文件级锁。画布改图有乐观并发（`base` 令牌，读后被改过就 `stale`，`tests/test_plan_rules.py::test_freshness_names_the_elements_changed_since_the_read`）；代码文件冲突靠 agent 和 git。设计上默认是一个主 agent 编排多个子 agent（[CLI 适配层 §8](../web/docs/cli-adapters.md)）。 |
| 权限和安全呢？ | 沿用各 CLI 自己的配置，`--scope` 只是提示不是沙箱；Grok、Cursor、Devin 以「不加边界」的方式启动（`server/canvas/dispatch.py::PERMISSION`），Claude 无头默认 auto——auto 是 CLI 内部的分类器，不是沙箱。一次在真机上的权限实验清掉过构建缓存，此后这类实验只在隔离 HOME 里跑（`.agents/acceptance/common-mistakes.md` 的 P11）。 |
| 怎么测的？有多可信？ | 状态机、恢复、队列用假终端和录制的日志在 CI 里跑，不需要外部服务；真 tmux 的用例在 `tests/test_terminal_input.py`；真实 CLI 的端到端靠临时项目里的人工验收，不在 CI 里。 |
| CLI 升级把你搞坏了怎么办？ | 每个适配器声明测过的版本，带按版本录制的样本和契约测试；`agora doctor --agents` 报告版本漂移和不认识的日志记录，目前只提示、不自动降级（[CLI 适配层 §6](../web/docs/cli-adapters.md)）。 |
| 规模和性能？ | 没有编排层的压测数据，不编数字。它是单机、单项目、每个项目一个服务；只在 macOS 上实测过（README「限制」）。 |
