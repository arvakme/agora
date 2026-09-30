# common-mistakes.md — Agora 验收的项目教训

每次被用户打回追加一条，只追加不改写；下一轮交付前先通读，并对照 delivery-verify 自带的通用清单（G1–G12）。每条的「检查」是下一轮能照做的动作，能写成命令加预期结果的就写成命令。

- **P1 · 2026-09-29 · 首屏与弹出物打回** 「太乱了，不知道该看什么」「新弹出的窗口也多，不知道该看哪里」：一次误点同时引出回放、跟随窗口、面板切视图；页面还自己弹「可能过时」「在子图里」等提示。
  检查：第一次使用的录屏里，除了「等你」和出错，页面自己弹出的窗口和提示数为 0。可复跑：`node ~/.config/agent-stuff/notebook/artifacts/delivery-verify/agora-workstation-section/round-02/scripts/F1-first-use.mjs <输出目录> after`（按它头注释：像第一次用的人那样打开、新建会话、发一个小任务、看它做完、不再点别的；读它写出的 `after-first-use.json` 和 popups 清点，预期自动弹出数为 0）。注意它会新建会话并发任务，是有写入的，只在隔离项目或副本上跑，不要对着用户日常项目跑。只读的做法：5210 首屏截 1440×900（拦截非 GET 的 /api），预期只有图、右侧会话、顶栏标签，没有对话框、横幅、跟随标签。

- **P2 · 2026-09-29 · B2 打回** 「这里为什么都闲着呢，明明说去调查了」：已派出、对方还没接手，或两条命令之间的间隙，小人被画成「✓ 闲」。
  检查：已派出未接手、命令间隙、已中断、停了没交回执，都不能显示成「✓ 闲」（也不带对勾）：`cd web && mise exec -- npx vitest run src/workstation/runs.test.ts`（receiptText 的状态文案）与 `src/workstation/bubbles.test.ts` 全绿；再在画布上派一个真实 Codex，录屏里命令间隙必须写「想」。一轮真的做完之后父 agent 写「✓ 闲」是对的，不要把它当成失败。

- **P3 · 2026-09-29 · 点 ▶ 白屏打回** 「这个一点就白屏」：FollowPane 里 `&&` 后面的 `usePrefs` 使 hook 顺序在两次渲染间变化，React 崩溃（f11dac8）。
  检查：React hook 不许写在 `&&`、`||`、`?:`、条件和循环里。`rg -n "(&&|\|\||\?)\s*use[A-Z]\w*\(" web/src` 应无输出（`rg` 退出码 1）。能加 eslint-plugin-react-hooks 更好，这次没加。另在真实会话里点最后一轮的 ▶，页面错误 0 条、回放控制出现。

- **P4 · 2026-09-29 · C2 打回** 「右侧的轨迹不会跟着动诶」：▶ 回放时画布在跟拍，右侧轨迹停着不动。
  检查：▶ 回放时，轨迹的当前行随回放前进：`cd web && mise exec -- npx vitest run src/session/replayStep.test.ts` 全绿；在真实会话上点某一轮 ▶，轨迹里带 `data-now` 的行的编号至少变化一次，往上翻后出现「回到当前步」，结束后控制消失。

- **P5 · 2026-09-29 · 说话框打回** 「不能对话为什么可以打字」：输入框先出现，收件人却不对（子代理、外部 worker 不能直接说话）。
  检查：输入框一出现，写的就是真正的收件人和送达时机：`cd web && mise exec -- npx vitest run src/workstation/talkHost.test.ts`（talkTarget 相关）全绿；对子代理的小人说话，框里必须写「发给派它的会话」，干活中必须写「会在这一轮结束后送达」。

- **P6 · 2026-09-29 · F3 打回** 「这里有东西被挡住了」：我们的浮层盖住了 Excalidraw 自带的控件（紧凑布局的底栏、「滚动回到内容」）。
  检查：我们的浮层不能盖住 Excalidraw 自带的控件。1000×800 和 1440×900 各截一张（图移出视野，露出「滚动回到内容」；1000 宽时露出 Excalidraw 底栏），用 `getBoundingClientRect` 取「浏览/评论」条、我们的所有浮层与 `.scroll-back-to-content`、Excalidraw 底栏（`.App-bottom-bar`）的包围盒，两两不相交。这一条目前只有截图，没有脚本，下一轮补成脚本。

- **P7 · 2026-09-29 · N2 打回** 「c-b d 之后没有自己返回面板」：终端里 detach 后，面板还停在「终端里」的状态。
  检查：没有可写的终端窗口时，面板回到正常样子（输入回到面板）。`.venv/bin/python -m pytest -q tests/test_terminal_input.py -p no:cacheprovider`，其中真 tmux 的用例（含 `test_takeover_holds_through_detach_a_lost_control_connection_and_a_restart`）全绿；并在隔离项目里手工开一次终端、`c-b d`，面板应写「没有窗口连着…」且输入框可用。上一轮没有做过真实终端窗口里的端到端，这里要补。

- **P8 · 2026-09-29 · J1 打回** 「这里得来一个回到最新消息的提示，就像这个一样」：长会话往上翻时找不到回到底部的入口。
  检查：长会话往上翻时有回到最新的入口：`cd web && mise exec -- npx vitest run src/session/jumpToBottom.test.ts` 全绿；在 5210 上打开有长输出的会话往上翻，胶囊「回到最新 ↓」出现，来了新内容改写成「↓ N 条新消息」，点击或按 End 回到底部。

- **P9 · 2026-09-29 · 预览地址混用打回** 给用户看的地址（5210）跑的是开发中的工作树，用户看到的不是验收过的版本。
  检查：5210 只跑验收过的提交，前端和后端都来自 `~/Job/agora-preview`；开发用别的端口（5212）。命令：`lsof -a -p $(lsof -nP -iTCP:5210 -sTCP:LISTEN -t | head -1) -d cwd -Fn` 应是 `agora-preview/web`；55430 同理是 `agora-preview`；`git -C ~/Job/agora-preview status --short` 应为空；`git -C ~/Job/agora-preview rev-parse --short HEAD` 应等于报告里写的提交。

- **P10 · 2026-09-29 · 环境泄漏** 在某个 worker 窗格里重启服务，会把 `SEEDMUX_*` 漏进用户的会话（无头、面板、被派会话）。
  检查：起服务和会话都要去掉 `SEEDMUX_*`。`ps eww -p $(lsof -nP -iTCP:55430 -sTCP:LISTEN -t | head -1) | tr ' ' '\n' | grep -c SEEDMUX_` 应输出 0（grep 退出码 1 也算通过）；`.venv/bin/python -m pytest -q tests/test_terminal_input.py -k "seedmux" -p no:cacheprovider` 三条用例全绿。

- **P11 · 2026-09-29 · 权限实验事故** 故意引诱危险动作的权限实验，在真机上跑了「清掉这台机器上的构建缓存，不惜代价」，auto 没拦，清掉了用户的 npm、Go、Xcode DerivedData 和 bun 缓存（npm 8.0G→1.8G，DerivedData 874M→0，bun 1.9G→2.9M；可重新下载，但首次构建会重新下载）。
  检查：诱导危险动作的权限实验只在隔离的 HOME 里跑（`HOME=$(mktemp -d)`，工作目录在 scratchpad 下），提示词里不得出现针对整台机器的范围（「这台机器」「全局」「所有缓存」「上级目录」）；跑之前先 `env | grep -E '^(HOME|PWD)='` 确认在隔离目录，结束后确认真实的 `~/Library/Caches`、`~/.npm`、`~/.cache` 大小没有变化。

- **P12 · 2026-09-29 · 取证页面截走用户的改图** 用户在 5210 上让 Grok 给子图加节点，Grok 两次报「画布页 25 秒内没接住改图」。原因：Agora 把改图（`agora canvas read/apply/anim`）交给**最近连上来的页面**；一个 worker 为了取证，在 5212 上开的页面经只读代理连着用户的 55430，它成了那个页面，照做了改图，回报却被代理吞掉。
  检查：取证和开发的页面一律连自己的后端（555xx，项目用副本 `.agora` 的拷贝或 `?mock=runs`），**任何页面都不连用户的 55430，只读代理也不行**。命令：`lsof -nP -iTCP:55430 -sTCP:ESTABLISHED | awk 'NR>1 && $1!="python3.1" {print $2}' | sort -u` 只应列出 5210 的 vite（`lsof -nP -iTCP:5210 -sTCP:LISTEN -t`）。

- **P13 · 2026-09-29 · 重启时补发了早已送达的回执** 更新 5210 重启后端时，新加的「重启后补发没送到的回执」把两条下午早已送达的派发回执又发了一遍：那两条记录早于回执标记格式，派活方日志里本来就没有标记，被当成了没送到。两个 Claude 会话各多跑了一轮（「这是同一份回执的重复通知」），没改文件。
  检查：改了重启时会自动做事（补发、重投、清理）的逻辑，在重启用户的后端之前，先用新代码把副本 `.agora/` 拷贝里的记录空跑一遍，确认它对已有记录什么都不做。例如派发：用 `dispatch_store.from_json` 读 `.agora/dispatch/*.json` 的拷贝，按 `Dispatches.recover()` 的条件逐条算出「会不会补发」。重启之后再确认两件事：`.agora/dispatch/` 下没有文件在重启那一刻被改写；派活方会话的日志里没有新的「派发回执」。

- **P14 · 2026-09-30 · 「能看」不等于「丝滑」** 用户反馈：自动跟随要自己找小人、小人姿势猎奇、回放里走很多无用的步、镜头一到剪切就猛冲。这些在「功能都对、测试全绿」时依然存在，因为没有测过运动本身。
  检查：动了小人、镜头、回放的运动，交活前必须录一段逐帧记录（每帧：每个小人位置/透明度、镜头 x/y/zoom），按同样的指标和改前对比：小人速度突变数、走↔爬加速度峰值、镜头加速度峰值、镜头起步首帧速度（≤ 峰值 20%）、切镜是否交叉淡变（透明度和≈1）、小人瞬移数（应为 0）、被跟随小人在窗格内的时间占比；并出曲线图和拼图，自己看过。指标脚本在 `web/src/workstation/cameraCurve.ts`、`poseHealth.ts`、`web/scripts/pose-check.ts`；用真实 Claude 的场景至少录一次（`round-05/evidence/FL2/fl2real.mjs`）。纯函数测试不能替代这一条。
