# 进度指针：代码在更新，而且按架构图在走

> 界面更新（2026-09-28）：画布上的指针胶囊、节点紫底已由[工位视图](workstation.md)的小人替代——小人就是指针，空闲一分钟离开画布。本文的代码路径与映射规则照旧适用。

架构图上的节点可以代表一部分代码。会话里的 agent（Pi / Claude Code / Codex）每写一个文件，Agora 就把**一个**指针移到这个文件所属的节点上；不属于任何节点的文件列在画布左下角的「在架构图之外」。不管这一轮是在面板里发的（无头续接），还是在终端里直接敲的，都从 CLI 自己的会话日志读出来，所以两边都会驱动指针。

实现：`web/src/pointer/`（`codeLinks.ts` 匹配规则，`writeLinks.ts` 写入与解析元素，`PointerLayer.tsx` 画布上的指针、越界列表和路径编辑，`follow.ts` 跟随哪个会话）；文件提取在 `server/canvas/transcript.py`；`agora canvas link` 在 `agora_cli/canvas.py` → `/api/agent/canvas/link` → 页面 `agentBridge.ts` 的 `linkFromAgent`。

## 1. 节点关联代码路径

| | |
|---|---|
| 存在哪 | 元素的 `customData.codePaths: string[]`（方框、椭圆、菱形、frame 都可以）。随画布存进 `.agora/canvases/<id>.excalidraw`，进 git，和图一起 review |
| 写法 | 相对项目根目录的 glob：`**` 跨目录，`*` 不跨 `/`，`?` 一个字符，`{a,b}` 二选一。`server` 或 `server/` 等于 `server/**`；带扩展名的名字（`README.md`）只匹配那个文件 |
| 读 | `agora canvas read` 的 `nodes[]` / `frames[]` 有路径时带 `codePaths` |

两种设置方式：

- **界面**：选中一个节点（方框、frame；素材库图标或编组整组选中也算一个节点，路径写在图标的根元素上），节点旁的操作条上出现「关联代码路径」（已有路径时是「代码路径 · N」），和「子图」并排，弹层同一时间只开一个（[嵌套画布](nested-canvas.md) §3）。点开后一行一个 glob，下面实时提示「会话改过的 N 个文件会落到这里」；保存是画布上的一次修改，⌘Z 可撤销。「清除」去掉这个节点的路径。
- **agent**：`agora canvas link <元素> <glob…>`，元素写 id 或它的完整标签（不区分大小写；重名时要求用 id）；素材库图标的零件、标签或编组 id 都解析到图标的根元素。默认追加，`--clear` 替换（不带 glob 就是清除），`--json '{"api": ["server/**"], "db": ["db/**"]}'` 一次写多个。经服务转给打开的页面执行，一次可撤销，并在会话里记一张「关联代码路径」卡片（可撤销）。退出码同 `agora canvas`：0 成功 · 1 `invalid`（元素找不到或重名）· 2 用法错误 · 3 没开服务或页面。

agora-canvas skill 教 agent：用户说「按代码结构给架构图关联路径」时，先 `agora canvas read` 拿到节点，再看仓库目录（`git ls-files | cut -d/ -f1-2 | sort -u`），给每个节点定目录或文件，用一条 `--json` 批量写入，最后说明谁对应什么、哪些节点没有关联（`skills/agora-canvas/SKILL.md`「Link diagram elements to code」）。

## 2. 从会话里提取改动的文件

`server/canvas/transcript.py` 把工具调用写到的文件放在工具条目的 `tool.files: [{path, op}]` 里，`path` 相对项目根目录（在项目外就保留绝对路径，这种文件永远算「在架构图之外」）。按各 CLI 实际日志格式（2026-09 的 Claude Code 2.1、Pi、Codex 日志核对）：

| CLI | 日志里的记录 | 取哪个字段 | op |
|---|---|---|---|
| Claude Code | `assistant` 的 `tool_use`：`Edit` / `MultiEdit` / `Write` / `NotebookEdit` | `input.file_path`（NotebookEdit 为 `notebook_path`） | Write → write，其余 edit |
| Pi | assistant 消息的 `toolCall`：`edit` / `write` | `arguments.path` | write / edit |
| Codex | `event_msg` → `item_completed` 的 `FileChange`（`apply_patch` 与文件写入都落成它） | `changes` 的键（绝对路径），`type` 为 update / add / delete | edit / add / delete |

- **失败的写入不算**：工具结果 `isError`（Claude / Pi）或 FileChange `status: failed`（Codex）的文件不驱动指针。
- **不认 shell 写文件**：`sed -i`、`cat > x` 这类命令写的文件不会被识别（命令文本无法可靠地解析出写了哪些文件）。三个 CLI 正常改代码都走上表里的编辑工具。
- 时间用工具调用的时间；轮次号是这次调用所在的会话轮次（与轨迹里的「第 N 轮」一致）。

## 3. 映射与指针

- **文件 → 节点**：所有节点的所有 glob 里，匹配这个文件、而且**最具体**的那条胜出——第一个通配符之前的字面字符越多越具体，一样时整条更长的胜出。例：`server/**` 与 `server/canvas/runner.py` 都匹配 `server/canvas/runner.py`，后者胜。
- **子图汇总**：一个节点代表的代码还包括它打开的子画布（及更下层）所有节点的路径，所以总图上父节点亮、进入子图后更细的节点亮，见[嵌套画布](nested-canvas.md) §5；标签写「子图 · 文件名」。
- **指针**：每个会话落在它**最近一次**能映射到节点的改动上。多个会话同时活跃时每个一个指针、同一节点并排，冲突提示与活跃规则见[多 Agent](multi-agent.md)；下文描述单个指针。显示 agent 名（Pi / Claude Code / Codex）、文件名和时间；节点外加一圈描边。描边围住的是节点的整个外形（`web/src/canvas/clearance.ts` 的 `footprint`：方框加它的标签、素材组件的整组与名字、图标正下方或正上方 16px 内的说明文字），再外扩 6px，所以边线和底色不会压到节点自己的字。标签放在描边外侧：依次试上、下、右、左，每一侧沿边滑动（至少 24px 贴着节点），选第一个不压住其他节点、图标、文字和评论钉的位置；都挤时选压得最少的。评论层在指针层之上，打开的评论卡不会被描边或标签盖住。换节点时平滑移动（弹簧，约 0.6 秒）；平移、缩放画布时立即跟随。点开是这个节点最近改动的文件（每个文件一行、最新在前，带 op、时间和「第 N 轮」，点轮次打开这个会话的轨迹并定位到那一轮）。
- **在架构图之外**：没有任何节点匹配的文件，按文件合并（最新在前），画布左下角显示「在架构图之外 · N」。点开看文件；点一个文件列出它在哪几轮被改过，点轮次跳到轨迹。
- 画布上没有任何节点带路径时不显示指针和越界列表（只有选中节点时的「关联代码路径」入口）。

## 4. 跟随哪个会话

（多会话后：所有活跃会话都有指针，[多 Agent](multi-agent.md) §2；「跟随」只决定哪个指针带靶心、排在最前、路径编辑器预览用谁的改动。）

指针跟随**最后聚焦的会话面板**（点一下会话 tab 或面板）；还没聚焦过会话时跟随最近活动的已绑定会话。所有带路径的画布都用同一个被跟随的会话。数据就是会话面板用的那份会话记录（`web/src/session/agents.ts` 的条目，经 `buildTurns` 折成轮次），所以终端里发生的轮次和面板里发的一样驱动指针：服务端每 0.4 秒跟随原生日志，新记录推到页面，指针在下一帧移动。

## 5. 不做的事与限制

- 不猜：没有匹配就是「在架构图之外」，不按目录相似度或文件名去「就近」放。
- 一个文件只属于一个节点（最具体的那个）；想让父子节点都亮，给它们各自的 glob 分开。
- 指针只看**写**，不看读和搜索；运行命令（测试、构建）不移动指针。
- 路径是项目相对路径：项目外的文件（例如 agent 改了 `~/.zshrc`）也会出现在越界列表里，显示绝对路径。

## 6. 验收记录

2026-09-28 在 `/tmp/agora-sessions-e2e`（`server/`、`web/`、`db/`、`docs/` 四个目录，图上三个节点）实测，截图在 `web/evidence/trajectory-pointer/`：

1. Claude Code 会话收到「按代码结构给架构图关联路径」，读目录后 `agora canvas link --json` 批量写入（Web 前端 → `web/**`，API 服务 → `server/app.py`，数据库 → `server/db.py`、`db/**`），会话里出现可撤销的卡片（`01`）。
2. 面板里让它改 `server/app.py` → 指针落到「API 服务」（`02`）；改 `docs/notes.md` → 「在架构图之外 · 1」，点开看到文件和第 3 轮（`03`）。
3. 在终端 pane 里直接让它改 `web/src/App.tsx` → 指针移到「Web 前端」，第 4 轮带「终端」标记（`04`）；指针移动的逐帧位置见 `11-pointer-glide-trace.txt`。
4. Codex 会话无头改 `db/schema.sql`（FileChange）→ 聚焦 Codex 会话时指针在「数据库」（`07`、`08`）；切回 Claude 会话指针回到它的最近改动。
5. 选中节点手动编辑路径（`09`）。
