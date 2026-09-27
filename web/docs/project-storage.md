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
  run/                     server.json（pid、端口、URL）、日志、锁  不提交
  .gitignore               由 agora 生成：sessions/ run/ *.tmp *.lock
```

`.gitignore` 只在不存在时生成，之后归用户管；想提交会话记录就删掉 `sessions/` 那一行。

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

### sessions/<id>.agent.json

`{ "agent": "claude", "model": "sonnet", "effort": "", "nativeId": "…uuid…", "createdAt": … }`。只由服务端写，选定后不可改（不同选择返回 409），`nativeId` 只能从空设一次。对话本身在 CLI 自己的会话日志里，Agora 跟随读取，不复制。

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
- 删除会话删整个文件；撤销删除时整份重写。

### workspace.json

`{ "v": 2, "docs": [...], "root": <分屏树>, "focused": "<doc id>" }`，语义见 [工作区交互模型](workspace-model.md)：docs 列出所有画布和会话（含已关闭，带名字），root 是分组、tab 和分屏比例。它不在时（新项目）首次打开会建示例画布和它的会话。

## 2. 写入：原子 + 版本

- 版本 = 文件字节的 sha256 前 16 位。读取接口同时返回内容和版本。
- JSON 文件：临时文件（同目录 `.<name>.<pid>.<rand>.tmp`）写完 fsync，再 `os.replace` 换上；失败时旧文件不动，临时文件删掉。jsonl：整段记录一次 `O_APPEND` 写入后 fsync。
- 每次写都带 `base`（这个页面上次看到的版本；`null` 表示「我认为文件不存在」）。服务端在锁内（进程内锁 + `run/write.lock` 文件锁）比对：不一致就拒绝，返回 `409 {conflict, file, current, base}`，不覆盖。内容与磁盘完全相同的写直接成功，不算冲突。
- 前端对每个文件串行写，一次只有一个请求在路上，成功后记下新版本。遇到 409，这个文件的后续写入先扣住，页面顶部出现提示：「……在别处被改过（另一个窗口、编辑器或 git），这里的改动还没保存」，两个选择：
  - **载入磁盘上的版本**：丢掉这个页面未保存的改动，重新加载。
  - **用这里的覆盖**：带 `force` 写入这个页面的最新内容（会话记录则整份重写）。
- 服务不可达时提示「项目服务连不上，改动暂未保存」，恢复后自动补写。
- 外部改动（`git checkout`、手改文件）不会被主动推送到已打开的页面；下一次这个文件的写入会以冲突的形式发现它。

## 3. 接口（`/api/project`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `` | 项目信息：id、name、root、config、me、empty |
| GET | `/health` | `{ok, root, pid}`，`agora up` 用来确认端口上是不是这个项目 |
| GET | `/snapshot` | 全部内容与版本：workspace、canvases（scene + threads）、sessions（折叠后） |
| PUT | `/workspace`、`/canvases/{id}`、`/threads/{id}` | `{data, base, force?}` → `{version}` 或 409 |
| DELETE | `/canvases/{id}` | 同时删它的 threads |
| POST | `/sessions/{id}/append` | `{records, base, force?}` |
| PUT / DELETE | `/sessions/{id}` | 整份重写 / 删除 |
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
- 只监听 `127.0.0.1`。

## 5. 从浏览器旧数据迁移

以前的版本把工作区存在浏览器 IndexedDB（库 `agora`，键 `workspace` / `canvas:<id>` / `sessions`）。首次连接一个**空**项目（没有 `workspace.json` 也没有画布）时，如果这个浏览器里有旧数据且没导入过，就整份导入（旧评论记为本机用户所写），然后在 localStorage 记下 `agora.legacyImported`，以后不再导入；IndexedDB 里的旧数据原样保留，不删。

IndexedDB 按 origin 隔离：旧数据在哪个地址存的，就要从那个地址打开一次才能导入。以前开发时用的是 `http://localhost:5181`，所以迁移用：

```bash
cd my-project && path/to/agora/bin/agora open --dev --web-port 5181
```

## 6. 分享预留（本次不实现）

以后要让别人通过链接加入某块画布，主要是看和评论（指出哪里要改）。格式已经为此留好位置，分享不需要新的存储：

- **身份**：访客加入时给自己一个显示名，服务端给他一个 id（例如 `guest:<随机>`，或登录后的 `mailto:`）。他的评论和回复与本机用户完全同构：`author: "human"` + `by: {id, name}`，写进同一个 `threads/<canvasId>.json`；`participants` 自然包含他。现有线程不需要迁移。
- **权限**：访客只读画布、workspace 和会话；能写的只有评论线程（新线程、回复、标记解决）。服务端据此只对访客开放 `GET /snapshot`（去掉 sessions 与 config）和线程的写接口，画布写接口对访客返回 403。「交给 Agent」和会话仍只属于项目主人。
- **写入冲突**：访客和主人同时评论同一画布时，线程文件会被两方写。现在的整文件 CAS 在这种场景会频繁冲突，所以分享时线程写入改成**按操作提交**：客户端发「新建线程 / 追加消息 / 改 resolved」这样的操作（带消息 id），服务端在锁内读最新文件、应用操作、原子写回。追加消息和新建线程天然可合并（按 id 去重，`n` 由服务端按 `seq` 分配）；同一线程的 resolved 以后到者为准。这样访客之间、访客与主人之间不会互相覆盖，也不用弹冲突提示。画布本身访客不写，仍是主人单写、整文件 CAS。
- **推送**：多人同时在线需要把别人的新评论推到页面上（SSE：线程文件变化 → 推送新版本），这也会顺带解决「外部改动要等下次写入才发现」的问题。
- **提交**：访客评论落在可提交的线程文件里，主人照常 review 与提交；是否把访客身份（显示名）写进 git 由主人决定，必要时可只存 id、在 `config.toml` 里维护 id → 名字的映射。
