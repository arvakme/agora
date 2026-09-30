# PROJECT.md — Agora 验收适配

本文件写的是工位视图 v2 这一轮实际用过的步骤；别处按 `PROJECT.md §N` 引用。怎么跑听这里，什么算有效验收听 delivery-verify。

## 1. 项目概要

Agora 是给 coding agent 用的画布工作台：一个本地 Python 服务（`agora_cli serve`）托管项目（画布、会话、agent 运行记录），浏览器里的前端（Vite + React + Excalidraw）是它的界面。工位视图是画布上的一层：每个 agent 一个小人，按它读写的文件走到对应节点，底下是时间线（默认 34 px 细条，⤢ 展开成泳道）。

- 服务端：`server/`（画布 API 在 `server/canvas/`，agent 适配器在 `server/canvas/adapters/`），入口 `python -m agora_cli serve --project <目录> --port <端口>`（仓库根 `.venv`，`bin/agora` 是包装）。
- 前端：`web/`（`web/docs/workstation.md` 是工位视图说明，`web/docs/cli-adapters.md` 是各 CLI 的适配说明）。
- 取证工具：`web/scripts/motion-capture.ts`（逐帧统计 snaps / dropped / jank25）、`web/scripts/fidelity/`（`setup.ts` 造测试项目，`capture.ts` 按时刻截图）、`web/scripts/bench-overlay.ts`（帧耗时，要构建版页面）、`web/scripts/clip.ts`（延时片段）。
- 本轮的统一取证脚本在验收产物目录：`~/.config/agent-stuff/notebook/artifacts/delivery-verify/agora-workstation-section/round-01/scripts/evidence/run.mjs`（不进仓库；用法见 §5）。
- 桌面壳、iOS：本轮不涉及。

## 2. 环境

前提：Node 24（`web/mise.toml`）、仓库根有 `.venv`（`uv sync` 造）、ffmpeg 在 `/opt/homebrew/bin`、Playwright 在 `web/node_modules`。

- 造测试项目（原型布局：Web 前端 / API 服务 / MySQL / Redis / 支付服务，画布 `c1`，`?mock=runs` 的脚本就在这张图上放）：
  `cd web && node scripts/fidelity/setup.ts <源项目目录> <新项目目录>`。源项目不会被改；新项目不带 `.agora/run`、`.agora/local`。放在临时目录，不要放进仓库。
  带子图的变体（API 服务下有子画布 `c-api`，`?mock=runs` 的 Pi 会走进去）目前是在这个项目的副本上手工加的子画布，没有脚本；没有它就没有 C15 / C18。
- 起后端：`.venv/bin/python -m agora_cli serve --project <测试项目> --port <端口>`（本轮：原型布局 55420，带子图 55421）。
- 起前端：`cd web && AGORA_API_ORIGIN=http://127.0.0.1:<后端端口> npx vite --port <端口> --strictPort --host localhost`（本轮：5200 → 55420，5201 → 55421）。Vite 默认代理到 `http://localhost:8000`，不设 `AGORA_API_ORIGIN` 会连错后端。
- 判断已在运行：`lsof -nP -iTCP:5200,5201,55420,55421 -sTCP:LISTEN`；已在运行就复用，不重启。
- 停止：只停自己起的进程（记下 PID）；主持人起的 5200 / 5201 / 55420 / 55421 别停。
- **别碰 55331**：那是用户自己的演示服务（`--project ~/agora-demo-project`），不读它的项目、不往里写、不停。
- 冒烟：`curl -s -o /dev/null -w '%{http_code}' http://localhost:5200/` 返回 200，浏览器打开 `http://localhost:5200/?mock=runs` 能看到画布和右下细条。
- 依赖服务：无数据库。`bench-overlay.ts` 要构建版页面：`cd web && npm run build`，再 `npx vite preview --outDir dist`，把预览地址给脚本（会写 `dist/`，只在最终验收那一遍做）。
- 服务端测试：`uv run --no-sync pytest -p no:cacheprovider -q tests/test_<x>.py`（免服务，按改动挑）。

## 3. 账号与登录

没有账号、没有登录。项目就是一个本地目录，页面通过后端的项目 API 读它。

- 一个页面是否已连上项目：`window.__agora?.api`（Excalidraw 句柄，脚本用它等页面就绪）存在，且 `.canvas-view` 已渲染。
- 主题、开关都存在本浏览器的 `localStorage`：`agora.theme`（`system` / `light` / `dark`）、`agora.workstation.v2`（`on` / `off`）、`agora.view`（`{"footprints":bool,"notifyWait":bool,…}`）。用 Playwright 的 `addInitScript` 注入，不动用户日常浏览器。

## 4. 界面入口

- Web：`http://localhost:5200/?mock=runs`（原型布局，无子图，后端 55420）；`http://localhost:5201/?mock=runs`（API 服务带子图 `c-api`，后端 55421）。
- 浏览器：Playwright 的 headless Chromium（1440×900）；交互验收用 Ego 浏览器也可以，但逐帧统计只能用 Playwright。
- 时间线：画布下方的细条；⤢（`aria-label="展开时间线"`）展开泳道，✕（`收成细条`）收起。⋯ 菜单（`aria-label="视图与布局"`）里有主题、工位视图开关、脚印、等你通知。
- 服务端接口（只读时用）：`GET /api/agent/runs?session=<sid>` 或 `?kind=<cli>&native=<id>`，加 `&items=1` 带条目。
- 桌面壳、CLI 界面：本轮不涉及。

## 5. 快速到达状态

- `?mock=runs`：前端自己放一段约 46 s 的脚本（`web/src/workstation/runs/fixtures.ts`）：一个主 agent（Pi）、一个 Seedmux worker、一个只有回执的 worker、一个 Claude 子代理；不需要真会话。脚本的时间点（秒，从 `mockBase` 起）：Claude Code 5.5 s 沿 HTTP 桥走到 API 服务，Pi 6.5 s 爬梯去 MySQL，14.5–18.5 s Pi 和 Claude Code 同时写 `server/users.py`，19.6 s 派出子代理，24 s 脚手架去图外托盘，28.9–30.8 s 短读 glance，Pi 27–33 s 在等你，33.6 s 交回，38 s worker 退出，之后是空闲。
- `&canvas=c1`：脚本要 `window.__agora` 时用（测试项目只有这张画布）。
- `&mockBase=<epoch ms>`：钉住脚本的第 0 秒。截图用 Playwright 假时钟：`page.clock.install({time: base-20000})`，`base` 取当天 15:57:20（原型的时刻），再按秒往前跑，脚本第 N 秒就是确定的一帧；录视频用真实时间：`mockBase = Date.now() + 8000`，前 8 s 留给加载。假时钟下 motion 的弹出动画不启动（WAAPI 不受它管），弹层类截图用真实时钟并把 `mockBase` 设到一天前（脚本已结束、画面安静）。
- `&perf`：`motion-capture.ts` 用，打开叠层的性能标记。
- `?fresh`：不读不写项目（新建会话对话框、`bench` 用它）。`?fresh&bench=18x500`：合成 500 个元素和 18 个一直读写的会话，给 `bench-overlay.ts` 用；预算 空闲与平移每帧 ≤ 4 ms。
- 深浅色：浏览器上下文 `colorScheme: "dark"` + `localStorage["agora.theme"]="dark"`；`motion-capture.ts` 用 `--dark`。
- 减少动态效果：上下文 `reducedMotion: "reduce"`；`motion-capture.ts` 用 `--reduced`。
- 窄窗口：视口 400×800。
- 一条命令录全部证据：
  - 列出每项取证步骤：`node <round>/scripts/evidence/run.mjs --list`
  - 只跑几项：`node …/run.mjs --cases C8,C14 --out <目录>`
  - 全跑：`node …/run.mjs --all --out <目录>`（约 35 分钟；先确认 5200 / 5201 / 55420 / 55421 都在）
  - 每项写到 `<目录>/<项>/`，并有 `notes.json`（时间、URL、主题、做了什么、统计数字、当前不可取及原因）；几项共用的录制在 `<目录>/_shared/`；`summary.json` 里有被拦下的非 GET 请求。
  - 构建版性能（C13）另给 `--bench-url <构建版页面地址>`。
- 只读保护：脚本对每个浏览器上下文拦下非 GET 的 `/api` 请求（`page.route('**/api/**', …)`，项目自己的脚本经 `guard.mjs` 预加载拦）。不点重置、清空、新建会话、交给 Agent，不真发对小人说的话。

## 6. 已知约束

- 测试画布曾在 02:17 被不明写入清空过：验收脚本一律拦下非 GET 的 `/api` 请求；截图页面要点会聚焦窗格的东西时先确认写请求已被拦（否则会保存 `workspace.json`）。
- 55331 是用户自己的演示服务，任何时候不碰。
- 5200 / 5201 / 55420 / 55421 是主持人的预览：不启停；Vite 热更新会在别人存盘时重载页面——录视频的页面要把 HMR 的 WebSocket 接成静默的（`run.mjs` 已做），否则录到一半页面重载。
- 假时钟只能往前走；两次截图间隔小于约 0.3 s 时先后顺序要按时间升序排。
- 真实 agent 会话（Claude Code haiku、Cursor、Grok、Devin）的验收会往测试项目写文件，不能靠脚本；手工做、录屏，并把会话记录里的每次工具调用和录像对照。写请求被无头模式拒绝的，在记录里标为「写的尝试」。
- 系统通知只能在有头浏览器里看到横幅；无头下用 `Notification` 桩记录调用。
- 逐帧统计（snaps / jank25 / dropped）依赖机器负载：跑的时候别同时开别的录制或构建，否则 `dropped` 会虚高。
- `bench-overlay.ts` 只能在构建版页面上跑（dev 版的 HMR 和未压缩代码会让数字不可比）。
- 只在 macOS 验过（ffmpeg 路径、`lsof` 用法）。
