# 项目存储：`.agora/`

一个项目一个 Agora：画布、评论线程、会话记录和工作区布局存在项目根目录下的 `.agora/` 里，跟着项目走（拷贝、提交、切分支都带着）。每个项目由自己的本地服务读写（`agora up`），不同项目各占一个端口，互不可见。浏览器不保存项目数据。

实现：`server/canvas/project.py`（存储）、`server/canvas/project_router.py`（`/api/project` 路由与单项目应用）、`agora_cli/`（命令）、`web/src/persist.ts` 与 `web/src/project/`（前端）。

## 1. 目录

```
<project>/.agora/
  config.toml              项目配置                         提交
  workspace.json           画布与会话清单（含已关闭）、tab、分屏    提交
  canvases/<id>.excalidraw Excalidraw 原生场景                提交
  threads/<canvasId>.json  这块画布的评论线程                   提交
  sessions/<id>.jsonl      会话里的画布修改（含撤销数据），追加写   不提交
  sessions/<id>.agent.json 会话绑定的 agent / 模型 / 强度 / 原生 id  不提交
  sessions/snapshots/<id>.jsonl  Agora 保存的轨迹快照（原生日志没了时只读查看、生成摘要）  不提交
  run/                     server.json（pid、端口、URL）、日志、锁、usage/（无头续接的用量）  不提交
  shares/shares.json       分享记录（令牌只存哈希，见 [分享](sharing.md)），目录自带 `*` 的 .gitignore  不提交
  local/instance.json      这份副本的身份（实例 id、根路径、inode）与待提示的变化，见下文      不提交
  local/copies.json        `cp -r` 带过来、在这里只读的会话                                 不提交
  trash/<时间>-<kind>-<id>/ 回收站：删掉的画布或会话的文件原样挪进来 + manifest.json，保留 30 天   不提交
  .gitignore               由 agora 生成：sessions/ run/ shares/ local/ trash/ *.tmp *.lock
```

`.gitignore` 只在不存在时生成，之后归用户管；想提交会话记录就删掉 `sessions/` 那一行。`shares/`、`local/`、`trash/` 各自带一个内容为 `*` 的 `.gitignore`，所以在 `.gitignore` 早于它们的旧项目里也不会被提交。

### 本机状态：`local/`、`.agora` 之外的注册表

`config.toml` 的 `project.id` 表示「同一个项目」，所有克隆共用；**实例 id**（`local/instance.json`：`{instanceId, projectId, root, dev, ino, createdAt}`）表示「这台机器上的这一份副本」。按副本区分的名字都用它：tmux 服务器 `agora-<实例 id 前 10 位>`、分享隧道 `agora-share-<项目 id 前 8 位>-<实例 id 前 6 位>`、服务锁与记录 `$AGORA_STATE_DIR/servers/<实例 id>.{lock,json}`。移动之后这些名字不变；两份副本互不相干。

**本机注册表** `$AGORA_STATE_DIR/registry.jsonl`（默认 `~/.local/state/agora/`）：机器上所有项目共用一个文件，只追加，每行一个事件（`instance`、`root`、`copy`、`bind`、`rebind`、`import`，阶段 2 起还有 `trash`、`restore`、`purge`），只有 id、路径、agent、模型、画布 id 和主题，**没有对话内容**。它不怕 `git clean -fdx`、仓库被删或被移动：找回会话的绑定、认出另一份副本的会话、`agora down` 清理这个实例用过的旧 socket，都靠它。读的时候跳过坏行，写的时候加文件锁。

**`agora up` 和服务启动时先对一次账**（`server/canvas/local.py` 的 `reconcile`），比较项目现在的位置和 `instance.json` 记下的位置：

| 现象 | 判断 | 处理 |
|---|---|---|
| 记下的就是这里 | 没变 | 同一路径换了目录（inode 变了）只更新记录 |
| 路径变了，旧路径上没有同一个实例 | **移动** | 实例 id 不变；注册表记 `root`；Pi 会话的日志移到新目录并改首行 `cwd`（见 [Agent 会话 §1](agent-sessions.md#1-会话模型)），终端里还开着的不动；Claude、Codex 什么都不用做 |
| 路径变了，旧路径上还有同一个实例 | **复制**（`cp -r`） | 这一份换新的实例 id；带过来的已绑定会话记进 `copies.json`，在这里只读，直到「在这里分叉继续」（两份项目不会续接同一个原生会话） |
| 没有 `instance.json` | 新项目、新 clone、另一台机器，或 `git clean -fdx` | 注册表里有「最后在这个路径」的实例就沿用它（`git clean` 之后身份不变），否则新建 |
| 没有 `instance.json`，但 `sessions/` 里有本机的绑定 | 实例 id 出现之前的旧项目，原地升级 | 就是这一份：新建实例 id，不提示「会话不在这台机器上」，现有绑定记进注册表；它以前用的路径哈希 tmux socket 上还开着的终端照样被看到、投递和关闭 |

结果（移动 / 复制 / 新 clone）存在 `instance.json` 的 `change` 里，`agora up` 打印一段说明，页面顶部提示一次，点「知道了」后清掉（`POST /api/project/local/ack`）。

### config.toml

```toml
format = 1

[project]
id = "…uuid…"          # 生成后不变；同一仓库的不同克隆共用
name = "my-service"    # 默认取目录名，显示在顶栏和标签页标题

[server]
port = 0               # 首选端口；0 = 每次 up 自动选空闲端口（实际端口见 run/server.json）

[agent]                # 结构化规划改图（评测基线 /api/canvas/turns）的执行参数；AGORA_CANVAS_* 环境变量优先
backend = "claude-cli"
model = "claude-sonnet-5"
effort = ""            # low | medium | high | xhigh | max；空 = 后端默认
```

会话用哪个 agent 不在这里配置：每个会话创建时自己选定，存在 `sessions/<id>.agent.json`（见 [Agent 会话](agent-sessions.md)）。旧配置里的 `[pi] session_id` 已不再使用，留着无害。

### canvases/<id>.excalidraw

Excalidraw 的导出格式，可直接拖进 excalidraw.com 打开：

```json
{ "type": "excalidraw", "version": 2, "source": "agora", "elements": [ … ], "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null }, "files": {} }
```

- 为了 git diff 可读：键按字母排序、两空格缩进、文件以换行结尾；同样的内容永远写出同样的字节，内容没变就不写。
- `elements` 保留原顺序（它就是图层顺序），已删除的元素（`isDeleted`）不写。
- 画布名不在这里，在 `workspace.json` 的 docs 里（改名不动场景文件）。
- Excalidraw 每次编辑会更新元素的 `version`/`versionNonce`/`updated`，diff 里会看到这些行，这是格式本身的噪声。
- 节点打开的子画布存在父节点的 `customData.childCanvas`（子画布 id，[嵌套画布](nested-canvas.md)）；子画布在 `workspace.json` 的画布条目可带 `reviewedAt`（「已核对」的时间）。
- 节点代表的代码路径存在元素的 `customData.codePaths`（glob 列表，[进度指针](progress-pointer.md)），和图一起提交。

### threads/<canvasId>.json

```json
{
  "seq": 2,
  "threads": [{
    "id": "k3x9…", "n": 1, "resolved": false, "createdAt": 1790524041935,
    "anchor": { "ids": ["redis"], "rel": { "x": 0.5, "y": 0.5 }, "last": { "x": 520, "y": 430 } },
    "createdBy": { "id": "mailto:ann@example.com", "name": "Ann" },
    "participants": [{ "id": "mailto:ann@example.com", "name": "Ann" }, { "id": "mailto:bob@example.com", "name": "Bob" }],
    "messages": [
      { "id": "…", "author": "human", "by": { "id": "mailto:ann@example.com", "name": "Ann" }, "text": "Redis 要不要换成集群版？", "at": 1790524041935 },
      { "id": "…", "author": "agent", "text": "…", "at": …, "turnId": "t-…" }
    ]
  }]
}
```

- `author` 是角色：`human` / `agent` / `system`。人写的消息带 `by`（作者 id 与显示名），所以一条线程可以有多个人参与；`participants` 是 `createdBy` 与各条 `by` 的去重列表，读取时重新推导，写它只为方便人和工具直接读文件。
- 本机用户：`git config user.email` 有值时 id 为 `mailto:<email>`，否则 `local:<登录名>`；显示名取 `git config user.name`，没有就用登录名。由服务端在 `/api/project` 的 `me` 里给出。
- Agent 回复用 `turnId` 指向会话里的那一轮；会话记录不提交时，别人克隆后看得到回复文字，看不到那一轮的步骤。
- 线程是否正在等 Agent（内存里的 `agent: running`）不落盘。
- **编辑**：改过的消息带 `editedAt`（界面显示「已编辑」）。只有写这条消息的人能改（`by.id` 相同；没有 `by` 的旧消息算本机用户的）。
- **删除是墓碑**：删掉的消息留 `{id, author, at, by, text: "", deleted: true, updatedAt}`，正文不留；删掉的整条线程留 `{id, n, createdAt, createdBy, anchor, deleted: true, resolved: true, updatedAt, messages: []}`，编号 `n` 不复用。留墓碑是为了按 id 合并时不被另一方手里的旧副本「合并回来」。界面不显示墓碑；一条线程的消息全删光了，线程也不再显示。每个人能删自己的消息；本机用户（作者）还能删任何人的消息和整条线程（包括锚点丢失的）。删除在页面里可撤销一次（提示条，6 秒）：撤销把原文重新写回，不是从文件里找回（文件里已经没有正文）。
- **`updatedAt`**：线程或消息写入之后又被改动（编辑、删除、撤销、解决 / 重新打开）的时间。合并时同一个 id 两边都有，就取 `updatedAt` 更晚的一份；都没有时以作者页为准（与之前一致）。

### sessions/<id>.agent.json

`{ "agent": "claude", "model": "sonnet", "effort": "", "nativeId": "…uuid…", "createdAt": …, "started": false }`。只由服务端写，选定后不可改（不同选择返回 409），`nativeId` 只能从空设一次；`started` 表示原生会话已经存在（见 [Agent 会话](agent-sessions.md)）。对话本身在 CLI 自己的会话日志里，Agora 跟随读取，不复制。

### sessions/<id>.jsonl

每行一条记录，只追加：

```
{"t":"session","session":{"id":"s-…","canvasId":"c1","createdAt":…,"turnIds":["t-1"]}}
{"t":"turn","turn":{"id":"t-1","status":"running","steps":[…],…}}
{"t":"turn","turn":{"id":"t-1","status":"applied","reply":{…,"batchId":"b-1"},…}}
{"t":"batch","id":"b-1","batch":{"before":[…],"after":[…]}}
```

- 读取时折叠：最后一条 `session` 是会话头，每个 turn / batch 取该 id 的最后一条。每一轮的每一步变化都会追加一条新的 turn 快照，历史留在文件里。
- `batch` 是这一轮改图的撤销数据（改前的元素），只写被某一轮引用的。
- 进程崩溃在半行上：读取时丢掉解析不了的行，不影响其他记录。
- 删除会话把它挪进回收站（下一节），不删。

### trash/：回收站

删除画布或会话 = 把它的文件用 `rename` 挪进 `trash/<毫秒时间>-<canvas|session>-<id>/`（在写锁里），同目录 `manifest.json`：

```json
{ "trashId": "1790580000000-canvas-c2", "kind": "canvas", "id": "c2", "at": 1790580000000, "title": "架构 B",
  "entry": { …workspace.json 里的条目… }, "place": { "groupId": "g1", "index": 1, "docIndex": 3 },
  "files": [{ "rel": "canvases/c2.excalidraw", "name": "canvases__c2.excalidraw" }, …],
  "linked": ["s-…"], "sharesEnded": ["a1b2c3d4"] }
```

- 画布：`canvases/<id>.excalidraw`、`threads/<id>.json`。会话：`sessions/<id>.jsonl`、`sessions/<id>.agent.json`、`sessions/snapshots/<id>.jsonl`、`run/usage/<id>.jsonl`；manifest 的 `native` 记着原生日志在哪（Agora 从不删它）。
- manifest 先写、文件后挪：中途崩溃留下的条目照样能恢复。恢复时目标 id 已被占用（git 带回了同 id 的画布）就换成 `<id>-r1`，绝不覆盖；页面随后把指向旧 id 的东西改过来：它的会话（manifest 的 `linked`）和父节点上的子画布链接（`customData.childCanvas`）。
- 只认自己写得出来的 manifest：目录名里的时间、kind、id 与 manifest 一致，每个文件都是这个 kind 的固定文件、名字是 `rel` 把 `/` 换成 `__`；不跟随符号链接，目标必须落在 `.agora/` 里。回收站只在本机：被 git 跟踪的条目（`git add -f`、别人的仓库带来的）不列出、不恢复，`agora doctor` 会提示移出 git。
- 保留 30 天：服务启动时和之后每小时清扫一次，过期的删掉；每次进、出、彻底删除都记进本机注册表。
- 目录自带 `*` 的 `.gitignore`；`git clean -fdx` 会清掉它，由仓库外的每日备份兜底。

### workspace.json

`{ "v": 2, "docs": [...], "root": <分屏树>, "focused": "<doc id>" }`，语义见 [工作区交互模型](workspace-model.md)：docs 列出所有画布和会话（含已关闭，带名字），root 是分组、tab 和分屏比例。

会话条目带着会话的身份，随 git 走（没有任何对话内容）：

```json
{ "id": "p-s-…", "kind": "session", "sessionId": "s-…", "title": "", "topic": "加 Kafka",
  "canvasId": "c2", "agent": "claude", "model": "haiku", "effort": "", "nativeId": "…uuid…", "createdAt": 1790573159939, "started": true }
```

页面保存工作区时从会话记录和绑定填进去（绑定、关联画布变了就跟着变）；`sessions/` 仍是本机的权威。新 clone、换机器或 `git clean -fdx` 之后：会话仍挂在原来的画布下，名字仍是「Claude Code · 加 Kafka」，不会被当成空白的新会话，也不会显示 agent 选择器，而是按情况显示成卡片（`snapshot.origins`，见 [Agent 会话 §1](agent-sessions.md#1-会话模型)）。只有服务端说项目是空的（`snapshot.empty`：没有 workspace.json，也没有任何画布文件）时，首次打开才建示例画布和它的会话，而且写示例画布时 `base: null`，文件已经存在就 409，绝不覆盖。workspace.json 缺失、为空或读不了、但 `canvases/` 里有文件时进入**恢复模式**：按磁盘上的画布（名字「已恢复画布 <id>」）和会话记录重建列表，页面顶部说明一次。清单里有、但 `sessions/<id>.jsonl` 不在的会话（`git clean -fdx`、重新 clone 后）挂在条目记下的画布下（旧条目没有 `canvasId` 的显示在「未关联画布」下），不写盘，直到这个会话里发生了什么（选了画布、恢复、分叉、开始一轮）。

读不了的文件（git 合并冲突、无效 JSON、没有读权限）不会让整个 snapshot 失败：`snapshot.errors` 逐个列出 `{file, error: "merge-conflict" | "invalid-json" | "unreadable", line}`，其余照常返回；页面说明是哪个文件第几行，并且不写这个文件，直到解决后刷新。workspace.json 缺失而磁盘上唯一的画布读不了时，也算「不是首次运行」：恢复模式把它列出来（「已恢复画布 c7（文件读不了）」），不写示例。

## 2. 写入：原子 + 版本，以及仓库外的兜底

- 版本 = 文件字节的 sha256 前 16 位。读取接口同时返回内容和版本。
- JSON 文件：临时文件（同目录 `.<name>.<pid>.<rand>.tmp`）写完 fsync，再 `os.replace` 换上；失败时旧文件不动，临时文件删掉。jsonl：整段记录一次 `O_APPEND` 写入后 fsync。
- 每次写都带 `base`（这个页面上次看到的版本；`null` 表示「我认为文件不存在」）。服务端在锁内（进程内锁 + `run/write.lock` 文件锁）比对：不一致就拒绝，返回 `409 {conflict, file, current, base}`，不覆盖。内容与磁盘完全相同的写直接成功，不算冲突。
- 前端对每个文件串行写，一次只有一个请求在路上，成功后记下新版本。遇到 409，这个文件的后续写入先扣住，页面顶部出现提示：「……在别处被改过（另一个窗口、编辑器或 git），这里的改动还没保存」，两个选择：
  - **载入磁盘上的版本**：丢掉这个页面未保存的改动，重新加载。
  - **用这里的覆盖**：带 `force` 写入这个页面的最新内容（会话记录则整份重写）。
- 服务不可达时提示「项目服务连不上，改动暂未保存」，恢复后自动补写。
- 外部改动（`git checkout`、手改文件）不会被主动推送到已打开的页面；下一次这个文件的写入会以冲突的形式发现它。

**仓库外的兜底**（`server/canvas/backup.py`，都在 `$AGORA_STATE_DIR` 下，`git clean -fdx`、仓库被删都碰不到）：

- **本地版本历史** `history/<项目 id>/<实例 id>/<文件>/<毫秒时间>`：画布、线程文件、`workspace.json` 被覆盖之前，旧内容先存一份。每一份是「那一刻被覆盖之前的内容」，当前内容就是文件本身。同一个文件 10 分钟最多存一次，最多 50 份、不超过 30 天，每份副本总共不超过 200MB（先删最旧的）。已经不存在的文件（删掉的画布）的版本在最后一份之后再留 30 天；以前的实例 30 天没写入就整个删掉（每小时清扫一次）。兜住 `git reset --hard`、`git checkout -- .agora`、误覆盖和不常提交的人。`agora history [<文件>]` 列出，`agora history <文件> --restore <毫秒时间>` 写回去（写回之前，当前内容无论 10 分钟规则如何都会存一份；开着的页面下次保存时会报冲突）。
- **每日备份** `backups/<项目 id>/<实例 id>/<毫秒时间>.tar.gz`：只在本机的那部分 `.agora/` —— `sessions/`（改图记录、绑定、轨迹快照）、`trash/`、`local/`。服务启动时和之后每小时检查一次，满 24 小时就备份，保留 7 份、总共不超过 500MB（最新的一份总会留下）；这三个目录超过 200MB 时，这一份不带轨迹快照（先去掉最大的）。`agora backup` 立即备份，`agora restore [--from latest|<毫秒时间>]` 放回缺的文件（`--overwrite` 才覆盖已有的）。放回时跳过现在在回收站里的会话，以及备份之后进过回收站、从回收站恢复过或被彻底删除的会话和回收站条目（按注册表的时间）：备份不会让同一个原生会话多出第二个 Agora 会话。

## 3. 接口（`/api/project`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `` | 项目信息：id、name、root、config、me、empty、instanceId |
| GET | `/health` | `{ok, root, pid}`，`agora up` 用来确认端口上是不是这个项目 |
| GET | `/snapshot` | 全部内容与版本：workspace、canvases（scene + threads）、sessions（折叠后）、bindings、errors、`local`（实例 id 与待提示的变化）、`origins`（不能直接续接的会话） |
| POST | `/local/ack` | 页面已经提示过移动 / 复制 / 新 clone，清掉 |
| PUT | `/workspace`、`/canvases/{id}`、`/threads/{id}` | `{data, base, force?}` → `{version}` 或 409 |
| POST | `/threads/{id}/merge` | `{data}` → `{version, data}`：按 id 合并进磁盘上的线程文件，从不 409。页面保存线程走这个（分享访客会同时写同一个文件，见 [分享 §4](sharing.md#4-两方同时写评论按操作合并)） |
| GET | `/events` | SSE：`threads`（别人写入后的整份线程文件与版本）、`shares`（分享列表变了）、`trash`（回收站变了） |
| POST | `/sessions/{id}/append` | `{records, base, force?}` |
| PUT | `/sessions/{id}` | 整份重写 |
| GET | `/trash` | 回收站：`{items: [manifest + expiresAt + daysLeft], keepDays}`，新的在前 |
| POST | `/trash/canvas/{id}` | `{entry, place, title}`：画布连同评论进回收站；先结束它的分享 |
| POST | `/trash/session/{id}` | 同上：会话连同绑定、记录、快照、用量；先关掉它的终端、停掉无头一轮 |
| POST | `/trash/{trashId}/restore` | 放回去 → `{item, id, canvas?: {scene, version, threads}, session?: {state, version}, binding?}` |
| DELETE | `/trash/{trashId}` | 彻底删除 → `{ok, native}`（原生日志在哪） |
| POST | `/import` | 一次性导入；项目非空时 409 |

id 只允许 `[A-Za-z0-9._-]`，不能以点开头。

## 4. 命令

```bash
path/to/agora/bin/agora up                 # 在当前目录：没有 .agora/ 就初始化，起本项目服务（或复用已在跑的），打印 URL
path/to/agora/bin/agora up --project ~/x   # 指定项目
path/to/agora/bin/agora open               # up，再打开浏览器（--no-browser 只打印 URL）
path/to/agora/bin/agora status             # 在跑就打印 run/server.json，否则退出码 1
path/to/agora/bin/agora down               # 停掉，确认端口释放
path/to/agora/bin/agora init               # 只建 .agora/
```

- `bin/agora` 包一层 `uv run --project <agora 仓库>`，当前目录保持为项目目录；也可以 `PYTHONPATH=<仓库> uv run --project <仓库> python -m agora_cli up`。
- 默认服务构建好的 `web/dist`（先 `cd web && npm run build`）。`--dev` 另起 vite（热更新）代理到本项目后端，页面地址是 vite 的；`--web-port` 指定 vite 端口。
- 同一项目重复 `up` 复用在跑的实例（按 `run/server.json` 的 pid + `/health` 的项目根确认）；两个 `up` 同时进来由 `run/up.lock` 串行。进程崩溃留下的旧记录会被清掉重启。
- `up` 先对账（上面的表）：移动、复制、新 clone 各打印一段说明。`run/server.json` 里记的进程只有在命令行确认是 `agora_cli serve --project <这个项目>` 时才会被当作残留停掉：`cp -r` 一个正在跑的项目会把原项目的 `server.json` 一起复制过来，那个服务属于原项目。
- 服务进程另在项目外持有一把锁并留一份记录：`$AGORA_STATE_DIR/servers/<实例 id>.{lock,json}`（默认 `~/.local/state/agora`；旧版本按根路径哈希命名的记录照样认）。锁文件里写着服务的 pid。`run/` 丢了（`git clean -fdx`）时，`up` 从这份记录找到还在跑的服务并写回 `run/server.json`，不会起第二个；记录也没了时，第二个 `serve` 拿不到锁直接退出。`down` 同样按这份记录停掉服务；服务卡住不应答、`run/` 和记录都没了时，按锁文件里的 pid 找到它，确认命令行是 `agora_cli serve --project <这个项目>` 再停。`down` 还会关掉这个实例的 tmux 服务器，以及旧版本按路径哈希命名、这个实例在以前的位置用过的 tmux 服务器。
- 服务运行中项目目录被移走、改名或删除：比较 inode（设备号变了但 inode 相同、`config.toml` 里的项目 id 也相同时算重新挂载，不算移走），所有写入返回 `410 {gone: true}`，不会在旧路径上重新长出 `.agora/`；页面提示在新位置运行 `agora up`，没保存的改动留在页面里，可以「下载为 .excalidraw」。只删了 `.agora/`、项目目录还在时单独说明（「.agora 被删除了」）。`/health` 带着 `gone`：`up` 不会复用这样的服务；项目移走后在新位置 `up`，会先停掉留在旧路径上的那个。其他写入失败（磁盘满、没权限、只读）返回 `{error, file}`（500 / 507），页面显示「保存失败」和原因，保留改动，可以重试或下载；页面只在服务端确认写入之后才记下「这个文件已经是这些内容」。
- 只监听 `127.0.0.1`。

```bash
agora doctor            # 只读，什么都不写（不对账、不写回 server.json）。检查本机数据：这是哪份副本（移动 / 复制 / 新 clone）、清单里的会话有没有绑定和改图记录、原生日志在不在、Claude 会话是否快到 30 天清理、画布文件与清单是否一致、回收站、旧 tmux 服务器、备份
agora doctor --fix      # 先对账，再放回能精确放回的：清单里缺记录的那几个会话从最新备份放回（在回收站里的、属于另一份副本或另一台机器的不放），这份副本自己的会话绑定从本机注册表（另一份副本的会话不绑定，提示在页面上分叉），agora-canvas skill 链接（也是被忽略的文件）；今天还没备份就备份一次。从不删除任何东西
agora backup | restore [--from …] [--overwrite] | history [<文件>] [--restore <时间>]
```

`doctor` 发现问题时退出码 1。`git clean -fdx` 之后跑一次 `agora doctor --fix`：实例 id 按注册表认回（tmux、分享隧道、备份都对得上），会话的绑定和改图记录回来，原生对话本来就在 CLI 自己的目录里。

## 5. 从浏览器旧数据迁移

以前的版本把工作区存在浏览器 IndexedDB（库 `agora`，键 `workspace` / `canvas:<id>` / `sessions`）。首次连接一个**空**项目（没有 `workspace.json` 也没有画布）时，如果这个浏览器里有旧数据且没导入过，就整份导入（旧评论记为本机用户所写），然后在 localStorage 记下 `agora.legacyImported`，以后不再导入；IndexedDB 里的旧数据原样保留，不删。

IndexedDB 按 origin 隔离：旧数据在哪个地址存的，就要从那个地址打开一次才能导入。以前开发时用的是 `http://localhost:5181`，所以迁移用：

```bash
cd my-project && path/to/agora/bin/agora open --dev --web-port 5181
```

## 6. 分享

已实现，见 [分享](sharing.md)：访客身份 `guest:<随机>` 与本机用户同构写进同一个线程文件；访客只读画布、只写评论（新线程、回复，以及编辑 / 删除 / 撤销删除自己的消息）；线程写入改成服务端按操作 / 按 id 合并；访客的新评论经 SSE 推到作者页。和当初预留的差别：访客不能标记解决（改由作者决定）；访客拿不到 workspace 和会话，只拿到被分享的那一块画布。
