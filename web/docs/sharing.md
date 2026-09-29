# 分享：经 Cloudflare Tunnel 让别人看画布和评论

作者把一块画布分享出去，拿到链接的人（访客）只能**看这块画布、读评论、发评论和回复，以及编辑、删除自己发的消息**。改图、会话、Agent、终端、项目文件一律只属于作者本机。分享走作者自己的公开域名（本机是 `quietharbor.de`），有效期由作者选，也可以限制最多被打开几次；到期或撤销后链接立即失效，Cloudflare 上为它建的东西随之删除。

实现：`server/canvas/share.py`（分享记录、令牌、生命周期、限流、访客可见内容）、`server/canvas/share_gateway.py`（访客唯一能到达的网关）、`server/canvas/cloudflare.py`（`cf` 命令行封装：DNS / 隧道提供者）、`server/canvas/project_router.py`（`/api/share`、评论合并、推送、网关与清扫的启动）、`agora_cli/share.py`（命令）；前端 `web/src/share/SharePanel.tsx`（作者的分享按钮与列表）、`web/src/guest/`（访客页）、`web/src/persist.ts` 的 `followProject`（作者页收访客评论）。测试 `tests/test_share.py`、`tests/test_share_bundle.py`（分享包、临时分享）、`web/src/guest/live.test.ts`、`web/src/comments/threads.test.ts`。

## 1. 用法

界面：顶栏「分享」→ 选画布、有效期（1 小时 / 1 天 / 7 天 / 自定义 1 分钟–90 天 / 直到撤销）、打开次数（不限次数 / 限制次数：最多打开 N 次，N 为 1–10000）→「创建链接」。链接**只显示这一次**（服务端只存令牌的哈希），复制后发给别人。下面的「当前分享」列出每个分享的剩余时间、打开次数（限制时是「打开 已用/上限」，用完变成提示色）、评论数和「撤销」；结束的分享留在「已结束」里。

命令（在项目目录，或 `--project`）：

```bash
agora share create --for 1d            # 默认分享聚焦的画布；--canvas <id|名字> 指定；--for 10m|2h|1d|7d|forever
agora share create --max-opens 5        # 最多打开 5 次（不写就是不限次数）
agora share list                       # 表格（「打开」列是 已用/上限 或已用次数）；--json 输出记录（不含哈希）
agora share revoke <id>                # 立即结束一个；--all 结束本项目全部有效分享
agora share create --quick             # 不要 Cloudflare 账号的临时地址，见 §10
agora share export -o x.agora-share.json   # 导出分享包（离线，不需要服务）；见 §9
agora import x.agora-share.json        # 把别人给的分享包（文件、分享链接或包的 URL）导入成本项目的新画布
```

退出码：0 成功 · 1 失败（信息在输出里）· 2 用法错误（时长、画布名、打开次数）· 3 需要先 `agora up`（`create` 需要服务在跑：网关和隧道由它运行）。`list`、`revoke` 在服务没开时直接读写 `.agora/shares/`，`revoke` 自己完成 DNS 和隧道的清理。

## 2. 暴露方式：每个分享一个一级子域名

```
访客浏览器 ──https──> <项目名>-<6 位随机>.quietharbor.de  (Cloudflare 代理的 CNAME → <隧道 id>.cfargotunnel.com)
         ──> cf tunnels run（本项目一个命名隧道 agora-share-<项目 id 前 8 位>，只有一条 ingress）
         ──> 127.0.0.1:<网关端口>  share_gateway（白名单）──> 项目存储 / 事件
作者浏览器 ──> 127.0.0.1:<项目端口>  项目应用（不经过隧道）
```

- **子域名**：每个分享新建一条代理的 CNAME `<slug>-<随机>.<域名>`（一级子域名，Cloudflare 的通用证书覆盖 `*.<域名>`，不用单独签证书）。撤销或到期时按记录 id 删掉它，名字本身就不存在了（权威 DNS 返回 NXDOMAIN），不只是令牌失效。
- **令牌**：链接是 `https://<主机名>/s/<令牌>`，令牌 32 字节随机（`secrets.token_urlsafe(32)`）。网关验证后把它放进 `HttpOnly; Secure; SameSite=Lax` 的 cookie（有效期不超过分享本身），再 303 跳到 `/`，地址栏里就不再有令牌；`Referrer-Policy: no-referrer` 防止经 Referer 外泄。
- **隧道**：每份项目（每个实例，见 [项目存储 §1](project-storage.md#本机状态localagora-之外的注册表)）一个命名隧道 `agora-share-<项目 id 前 8 位>-<实例 id 前 6 位>`：同一项目的两个克隆或 worktree 各用各的，撤销一边的最后一个分享不会拆掉另一边正在用的隧道。第一次分享时用 `cf tunnels create --config-src cloudflare` 创建（远程配置的隧道，Agora 不存任何隧道凭据）；每次启动连接器前 `cf tunnels config update` 写入唯一的一条 ingress：本项目的分享网关；连接器是 `cf tunnels run <隧道 id>`：令牌由 cf 自己取，Agora 不经手、不落盘、不进日志，进程参数里只有隧道 id（不用 `--token <令牌>`：它会出现在 `ps` 里，本机任何人都能读到，拿到的人可以用自己的连接器接入这条隧道）。实测 `ps` 里 cf、node、cloudflared 三个进程的参数都没有令牌；cf 怎么把令牌交给 cloudflared（环境变量等）没有进一步核实，能读到同用户进程环境的人仍然能拿到它，这与「能读作者机器」同级，见威胁模型的「不防」。所有分享的主机名都指向这一个隧道，网关按 Host 区分分享，所以增删分享不用重启连接器。协议固定 HTTP/2（`AGORA_TUNNEL_PROTOCOL` 可改）：QUIC 用的 UDP 7844 在很多网络被挡，cloudflared 会一直重试 QUIC 连不上。DNS 记录用 `cf dns records create`（CNAME 指向 `<隧道 id>.cfargotunnel.com`，走代理），撤销用 `cf dns records delete`。没登录时报「先运行 `npx cf auth login`」。
- **进程**：`cf tunnels run`（cf → node → cloudflared）是项目服务的子进程，和它在同一个进程组，`agora down` 一起停掉；pid、隧道 id、网关端口写在 `.agora/run/share-tunnel.json`，日志 `.agora/run/cloudflared.log`。

**取舍**：另一种做法是一个固定主机名 + 路径令牌（整台机器一条 DNS 记录，分享之间只靠令牌区分）。它少了每次分享一次 DNS 写入（多一两秒），但撤销只能靠令牌检查，名字一直公开可探测；所有分享同源，一个分享页里的 cookie / 本地存储对其他分享可见；多个项目同时分享时还要一个机器级的进程统一路由。每个分享一个子域名把「撤销」做成了「这个名字不存在了」，也让分享之间天然隔离，所以选它。代价：每个分享要一次 Cloudflare API 调用；刚删掉的名字在别人的递归 DNS 缓存里可能还会留几分钟（这时它指向的隧道已删，Cloudflare 返回 530；网关也已不认这个主机名）。

## 3. 访客能做什么（白名单）

网关（`share_gateway.py`）只有这些路由，其余任何方法、任何路径都是 **403**（HTML 失效页或 `{"error": "forbidden"}`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/s/{令牌}` | 验证令牌 → 新访客计一次打开（§5.1；次数用完则 403「打开次数已用完」页）→ 设分享 cookie 和访客 id cookie（`agora_guest`，16 位随机）→ 303 到 `/`；访问次数 +1 |
| GET | `/`、`/index.html` | 前端页面，注入 `<meta name="robots" content="noindex, nofollow">` 和 `<meta name="agora-guest">`（前端据此进访客模式） |
| GET | `/assets/*` | 前端静态文件（只在 `web/dist/assets` 里，路径穿越被拒） |
| GET | `/api/guest/state` | 被分享的那一块画布（只读）、它的评论线程、`me`（`guest:<id>`）、到期时间 |
| POST | `/api/guest/comments` | `{op: "create", threadId, id, anchor, text, name}` 新线程 / `{op: "reply", threadId, id, text, name}` 回复 / `{op: "edit", threadId, id, text}` 改自己的消息 / `{op: "delete", threadId, id}` 删自己的消息 / `{op: "restore", threadId, id, text, editedAt?}` 撤销删除（页面把原文送回）。edit / delete / restore 只对 `by.id` 等于 cookie 里访客 id 的消息生效，别人的（作者、Agent、其他访客）一律 403 `you can only change your own messages`；消息不存在或已删除再编辑是 404 |
| GET | `/api/guest/bundle` | 被分享的画布、子画布和评论打成一个分享包文件（`Content-Disposition: attachment`），内容与 `/api/guest/state` 同一个脱敏函数产出；见 §9 |
| GET | `/api/guest/events` | SSE：`threads`（线程变化，已脱敏）、`canvas`（作者改图后的新元素）、`ended`（撤销或到期，页面切到失效页） |

**每个请求**先按 Host 找有效分享（找不到：403，连静态文件也不给）；`/s/` 之后的请求都要带这个分享的令牌 cookie，用 `hmac.compare_digest` 比对哈希（恒定时间）；限制了打开次数的分享还要求访客 id cookie 是它放进来过的（只拿到令牌 cookie 绕不过次数）。

**嵌套画布**：`/api/guest/state?canvas=<id>` 与评论的 `canvasId` 可以是被分享画布下面的任一子画布（逐级可达），其他画布 403；节点只保留指向可达子图的 `customData.childCanvas`，见[嵌套画布 §8](nested-canvas.md#8-分享访客逐级进入)。

访客**不能**：改图（页面是 Excalidraw 的只读模式，且网关没有任何写画布的路由）、改或删别人的消息、删除整条线程、解决/重开线程、「交给 Agent」、撤销 Agent 的修改、看会话或轨迹、看进度指针（访客页不挂 `PointerLayer`，元素的 `customData` 整个去掉，所以 `codePaths` 也没有）、看本地路径（`root`、会话 id、turn id 都不下发）、访问 `/api/project`、`/api/agent`（包括终端和 `agora canvas apply` 用的桥接）、`/api/canvas`、`/api/share`、`/libraries`。

访客看到的线程经过 `guest_threads` 脱敏：消息只留 `id / author / text / at / tone / by / editedAt / updatedAt / deleted`（线程另留 `updatedAt / deleted`，墓碑让访客页也把删掉的收起来）；非访客的身份 id（作者的 `mailto:邮箱`）换成 `member:<sha256 前 10 位>`，只保留显示名（git `user.name`）。

**评论的身份**：访客第一次评论前填显示名（存在他浏览器的 localStorage，最多 40 字）；服务端写入时用 cookie 里的访客 id：`by: {id: "guest:<id>", name}`，和本机用户的评论同构（`author: "human"`），写进同一个 `threads/<canvasId>.json`，`participants` 自然包含访客。线程编号 `n` 由服务端按 `seq` 分配。锚点必须指向画布上存在的元素，数值必须有限；正文最多 4000 字。

## 4. 两方同时写评论：按操作合并

访客和作者会同时写同一个线程文件，所以线程不再走整文件 CAS（`project-storage.md` §6 预留的方案）：

- 访客：`store.thread_op`，在项目写锁里读最新文件、应用「新建线程 / 追加消息 / 编辑 / 删除 / 撤销删除」、原子写回。编辑、删除、撤销带 `actor`（`guest:<id>`），`thread_op` 自己比对消息的 `by.id`，不是本人就抛 `NotYours`（网关回 403）——检查在存储层，不只在网关。
- 作者页：保存线程改为 `POST /api/project/threads/{id}/merge`（`store.merge_threads`）：按 id 合并，作者页有的字段（resolved、消息改动）以作者页为准，除非磁盘上那份的 `updatedAt` 更晚（访客刚改过或删过）；磁盘上作者页没有的线程和消息（访客的）保留；删除是墓碑（`deleted: true`，正文清空），旧副本合并不回来；两个新线程编号相撞时给作者页那条重新编号。合并从不返回 409，所以线程不会再弹「在别处被改过」。作者删除任何人的消息、删除整条线程都走这条路（格式见 [项目存储](project-storage.md#threadscanvasidjson)）。
- 推送：每次合并或访客写入，服务端发 `threads` 事件；作者页经 `GET /api/project/events`（SSE）收到后并入内存里的线程（新的加进来；同一条取 `updatedAt` 更晚的一份，所以访客的编辑和删除也会同步过来），访客页经 `/api/guest/events` 收到脱敏后的版本。作者改图保存（`PUT /canvases/{id}`）发 `canvas` 事件，访客页随之更新画面。

## 5. 有效期、打开次数、撤销与清理

### 5.1 打开次数

- **计数口径**：访客经 `/s/{令牌}` 进入成功（令牌有效、没到期、没撤销、次数没用完）算一次打开。同一个浏览器（同一个 `agora_guest` cookie）再点链接、刷新页面都不另算；换浏览器、清掉 cookie 或无痕窗口算新访客。记录里 `opens` 是已用次数，`maxOpens` 是上限（`null` = 不限），`admitted` 是进来过的访客 id 的加盐 sha256 前 24 位（不对外返回）。原来的 `visits`（`/s/` 成功次数，含同一访客重复点击）和 `guests` 仍然记录。
- **用完之后**：新访客点链接得到 403「这个分享链接的打开次数已用完」页，不设任何 cookie。只拿到令牌 cookie、没有被放进来过的访客 id 的请求，页面和接口一律 403。**已经进来的访客不会被踢出**：他们的页面、SSE 和评论照常，重新点链接也能进（不再计数）。想让所有人立刻失效就撤销分享。
- **和频率限制的区别**：`/s/` 另有防刷的频率限制（同一网络地址每分钟 10 次，超过 429，见 §7），针对的是猜令牌和刷接口，与作者设的次数无关，也不计入打开次数。分享面板在创建时写明了这一点。
- 不限次数的分享同样统计 `opens`，只是不拦。

### 5.2 有效期、撤销与清理


- **判定**：令牌检查本身就看到期时间，到点那一刻起所有请求 403，不依赖清扫。
- **清扫**：项目服务每 5 秒清扫一次：结束到期的分享，重试没做完的清理。
- **锁**：分享记录的锁只在改记录时短暂持有；创建分享调用 `cf`（几秒到 45 秒）时不占它，访客的请求不会因此排队。创建、结束（撤销、到期、画布删除）、清扫、恢复、停止互相串行（另一把锁），它们调 `cf`（可能很慢：删除超时 90 秒、断开连接会重试）时都不占记录锁，只在改记录的那一下拿它。
- **结束一个分享**（撤销或到期）：先把 `endedAt / endReason` 写盘（此后令牌必然无效，Cloudflare 那边出什么错都不影响），通知在线访客页（`ended`），再按记录 id 删 DNS 记录；删失败记在 `cleanup: ["dns"]` 里，下次清扫重试（列表里显示「DNS 记录待清理」）。
- **没有有效分享时**：停连接器，按名字 `agora-share-<项目 id 前 8 位>-<实例 id 前 6 位>` 找到这份项目的隧道并删除（先 `cf tunnels connections cleanup <id> --force` 断开连接，再 `cf tunnels delete <id> --force`；连接刚断时删除可能要重试几次）。旧版本用的是不带实例的名字 `agora-share-<项目 id 前 8 位>`（所有副本同名）：这个名字的隧道只在这份项目自己的分享记录里出现过它的 id 时才删。账号里其他隧道不碰。
- **服务停止**（`agora down`）：连接器一起停；**还在有效期内的命名分享留着**——它的 DNS 记录和隧道继续留在你的 Cloudflare 账号里，记录也在，所以下次 `agora up` 时先结束期间到期的（删掉它们的 DNS 记录，没有有效分享了就连隧道一起删），再为剩下的重新连上隧道，**地址和链接不变**。服务停着的这段时间，访客会看到 Cloudflare 的 530。这意味着：`down` 之后如果再也不 `up`，有效期内的分享的记录和隧道会一直留在账号里，直到你 `agora share revoke --all` 把它们全部立即清掉（服务没开也能运行，它自己调 `cf` 删记录和隧道）。quick 分享不同：地址随进程消失，`down` 时直接结束。
- **创建失败**：隧道连不上或 DNS 建不了时不留分享记录，已建的隧道由下一次清扫删除。

## 6. 记录与密钥放在哪

| 内容 | 位置 | 进 git |
|---|---|---|
| 分享记录：id、画布、主机名、**令牌的 sha256**、创建/到期/结束时间、访问/访客/评论数、打开次数与上限、进来过的访客 id 哈希、DNS 记录 id、隧道 id、待清理项 | `.agora/shares/shares.json` | 否：模板 `.gitignore` 有 `shares/`，目录里另有一个 `*` 的 `.gitignore`（旧项目的 `.agora/.gitignore` 没有这一行也照样忽略） |
| 令牌原文 | 不存。只在创建时返回一次 | — |
| Cloudflare 凭据 | 归 `cf` 管（`npx cf auth login`）；Agora 不存、不读、不复制 | 否 |
| 分享域名 | `AGORA_SHARE_DOMAIN`；不设且账号里只有一个 zone 时用它的名字，否则报错要求设置 | — |

## 7. 威胁模型

| 威胁 | 处理 |
|---|---|
| 链接外泄给不该看的人 | 分享本来就是「有链接即可看、可评论」；控制手段是有效期和随时撤销。撤销后令牌、主机名、隧道都没了 |
| 猜令牌 / 爆破 | 256 位随机；`/s/` 每个地址每分钟 10 次；比较恒定时间；主机名本身也是随机的，不知道主机名连网关都到不了 |
| 从磁盘或 git 拿到令牌 | 只存哈希；记录不进 git |
| 访客越权改图、调 Agent、开终端、读会话或项目文件 | 隧道只通到网关，作者的应用不在隧道后面；网关白名单之外一律 403；作者应用拒绝带 `cf-*` 头或 Host 是分享主机名的请求（防止配置失误或 DNS rebinding 把它暴露出去） |
| 泄露本地信息 | 下发内容去掉 `customData`（代码路径）、会话/turn id、项目根路径；作者邮箱换成不透明 id；访客页不加载进度指针和会话 |
| 刷评论 / 占资源 | 写每地址每分钟 20 次，读 120 次，SSE 连接每分钟 10 次、每个分享最多 50 条；正文 4000 字、名字 40 字上限；地址取 `CF-Connecting-IP` |
| 冒充别的访客 | 访客 id 是网关发的随机 cookie，不签名；改 cookie 只能换一个 `guest:` 身份，显示名本来就是自填的，冒充不了作者（作者的 id 不是 `guest:`）。编辑 / 删除按 cookie 里的访客 id 判断，要改别人的消息得先拿到对方的 cookie（HttpOnly，页面脚本读不到） |
| 绕过打开次数 | 次数按访客 id 计，只对新 id 计数；限制次数的分享只服务它放进来过的 id，复制令牌 cookie 不够；伪造一个没放进来过的 id 也是 403。清 cookie 重进会占用一个新名额——这正是「每个浏览器算一次」的口径 |
| 被搜索引擎收录 / 被嵌入 | `noindex` meta 与 `X-Robots-Tag`；`X-Frame-Options: DENY`、`frame-ancestors 'none'`；接口 `Cache-Control: no-store` |
| 分享包被转发、留存 | 无法撤回：包的内容不比访客页多，但拿到文件的人可以随意保存和转发；界面和命令输出都写明「收不回来」。撤销分享只影响链接 |
| 恶意 / 超大的分享包 | 导入先整体校验再写盘：体积、块数、元素数、线程数、消息长度有上限；只收基本图形，丢掉 `customData`、`embeddable`、`iframe`、`image`、非 http(s) 链接；只写 `.agora/`；导入的作者 id 是 `imported:` 前缀，不会冒充访客或本机用户 |
| quick 地址是公网地址、没有独立主机名隔离 | 同一时间只有一个分享；令牌、cookie、白名单和限流与普通分享一致；撤销 / `agora down` 停整棵进程树，地址随后返回 530 |
| Cloudflare 清理失败留下 DNS 记录 | 令牌已先失效；记录 id 留在 `cleanup` 里，清扫重试，列表可见 |

不防：拿到作者机器本身的人；作者自己把 `cf` 的登录凭据放进仓库。

## 8. 验收记录

2026-09-28 在 `/tmp/agora-share-e2e`（只有示例架构图）用真实的 `quietharbor.de` 实测，截图与探测记录在 `web/evidence/sharing/`：

1. 界面建 10 分钟分享（`01`；`02` 是修好弹层溢出后用假接口响应重拍的布局，链接是示例值）→ 访客页首次进入要名字（`03`）→ 在 Redis 上钉评论（`04`、`05`）→ 作者页没刷新就出现了钉子（等待检查 9 ms 即通过，`06`，带「访客」标记）→ 作者回复，访客页实时看到（`07`）。
2. 访客在页面上拖动、全选删除：画布文件哈希不变；13 个非白名单接口全部 403，`/api/guest/state` 里没有邮箱、代码路径、本地路径（`08`）。
3. 作者在列表里撤销（`09`）→ 访客页 0.3 秒内切到失效页，接口 403（`10`、`11`）；权威 DNS 对该主机名 NXDOMAIN，隧道已删。
4. `agora share create --for 2m` → 访客打开（`12`）→ 到期后页面自动失效，清扫在到期后 0.3 秒结束分享并删掉 DNS 和隧道（`13`）。

第一次尝试时 cloudflared 在这台机器上连不上 QUIC，45 秒超时，创建失败；隧道由清扫删除。之后固定用 HTTP/2。

2026-09-28 修补轮（评论可删改、打开次数），用本地网关 harness 实测（真实的项目应用和分享网关，Cloudflare DNS / cloudflared 换成 `tests/test_share.py` 里的假实现，分享主机名落在 `*.localhost`），截图与记录在 `web/evidence/polish/`：

5. 作者在分享面板选「限制次数 · 最多打开 2 次」（`11`）→ 访客甲进入、钉评论、改成「Redis 要不要用集群？」显示「已编辑」（`12`）、删除后提示条撤销、磁盘上先是墓碑再恢复原文（`13`）；访客在别人的消息上没有编辑 / 删除按钮（`14`），直接调接口删改作者或其他访客的消息都是 403（`15`）。
6. 访客乙进入（第 2 次）→ 访客丙得到「打开次数已用完」页（`16`）；丙拿着复制来的令牌 cookie 调 `/api/guest/state` 仍是 403；乙带着自己的 cookie 再点链接照常进入，次数不变（`17`）；作者列表显示「打开 2/2」（`18`），`agora share list` 的「打开」列是 `2/2`（`19`）。

2026-09-29 分享包与临时分享（示例项目 `sh-proj`，真实的 `cf tunnels quick-start`；证据在 delivery-verify 的 `round-02/evidence/SH/`）：

7. `agora share export` → 在另一个空项目 `agora import` → 页面上画布、子图（点节点右下角进入）、两个评论钉都在；导出文件里没有 `codePaths`、邮箱、会话 id、本机路径。
8. `agora share create --quick` 约 8 秒给出地址；访客页正常显示、能评论，评论落进 `sh-proj/.agora/threads`；SSE 被缓冲，页面 5 秒后改为轮询，作者新评论约 8 秒内出现；第二个 quick 分享被拒；`agora share revoke --all` 与 `agora down` 之后进程都没了、地址 530。

2026-09-29 改用 `cf`（`tests/test_cloudflare.py` 用桩 `cf` 覆盖建、撤、未登录、失败回滚），在真实的 `quietharbor.de` 上端到端：`agora share create` 建出 `sh2-proj-<随机>.quietharbor.de`（代理的 CNAME 加一个远程配置的隧道，4 个连接）→ 访客用 Playwright 打开、评论落进 `.agora/threads` → `agora share revoke` 约 16 秒结束：`cf dns records list` 和 `cf tunnels list` 里都没有了，地址返回 530，连接器进程没了；quietharbor.de 的记录和账号的隧道列表回到测试前。第一次撤销暴露了 `connections cleanup` 也要 `--force`，已修。证据在 delivery-verify 的 `round-02/evidence/SH2/`。

## 9. 分享包：让别的开发者带走、导入到自己的 Agora

一个分享包是一个 JSON 文件（`*.agora-share.json`）：被分享的画布和它下面的所有子画布、它们的评论线程、一份清单（格式名 `agora-share-bundle`、版本 1、来源项目名、根画布、导出时间）。**内容就是访客能看到的东西，不多一点**：元素和评论线程都走同一个函数（`share.py` 的 `guest_canvas`，访客页的 `/api/guest/state` 也用它），所以代码路径（`customData`，只留指向子画布的链接）、会话与 turn id、项目根路径、作者邮箱都不在里面。

**拿到包的三种方式**：作者 `agora share export [--canvas …] [-o 文件]`（离线，服务不用开）；访客在访客页点「导入到我的 Agora」→ 下载（网关的 `GET /api/guest/bundle`，和其他访客接口一样要令牌 cookie，只读、不接受 POST）；`agora import <分享链接>`（打开一次链接、取包，算一次打开，受打开次数限制）。

**导入**（`agora import <文件|分享链接|包的 URL>`，在当前项目；没有 `.agora/` 就创建）：

- 每块画布得到**新 id**，标题是 `来自 <来源项目> · <原标题>`；子画布之间的链接改成新 id，指向包外的链接丢掉。已有的工作区布局不动（新画布在「所有画布」里）；项目里还没有工作区时新建一个，打开就停在导入的画布上。导入两次得到两份，从不覆盖。
- 评论线程作为历史导入：作者标为 `imported:<哈希>`（保留显示名，不保留 id，不会和任何在线访客或本机用户撞上），线程带 `imported: {from}`。已删除的消息和线程不带，锚点元素没来的线程丢掉。
- 包是**不可信输入**：先整体校验、都通过才写盘，写到一半出错就删掉已写的文件。限制：文件不超过 20 MB、200 块画布、每块 20000 个元素（合计 50000）、每块 2000 条线程、每条线程 200 条消息、消息 4000 字。只收基本图形（矩形、菱形、椭圆、箭头、线、手绘、文字、框）；`embeddable`、`iframe`、`image` 和未知类型丢掉；`customData` 全丢（只留改写后的子画布链接）；`link` 只留 http(s)；坐标、尺寸必须是有限数。不执行包里的任何内容，只写 `.agora/` 里的文件。
- **已知缺口**：导入的线程在数据上只读（`imported` 标记、别人的作者 id），但评论弹层的「交给 Agent」、回复框和删除按钮目前仍然显示，`dispatch` 也没有按 `imported` 拒绝——这两处在 `web/src/comments/`、`server/canvas/dispatch.py`，不在这次改动范围，需要后续跟进。

**撤不回**：分享包一旦给出去，收不回来——撤销分享只让链接失效，已下载或已导出的文件谁拿着都能用。导出命令的输出和访客页的下载弹层都写明了这一点。

## 10. 临时分享（`--quick`）：不要 Cloudflare 账号

`agora share create --quick`：起 `cf tunnels quick-start http://127.0.0.1:<网关端口>`（`PATH` 里有 `cf` 就直接用；没有就 `npx --yes cf@1.0.0-beta.5`，固定在测过的版本，`AGORA_CF_VERSION` 可以改；命名分享用同一个命令），从它的输出里取出 `https://<随机>.trycloudflare.com`，这个主机名就是分享的主机名，其余（路径令牌 `/s/<令牌>`、cookie、打开次数、限流、白名单）和普通分享完全一样。

- **同一时间只有一个分享**：有任何有效分享时不能建 quick 分享，quick 分享在时也不能建普通分享（同一个主机名，没法靠主机名区分分享）。
- **结束**：`agora share revoke`、到期、删除画布，或 `agora down`（服务停止时 quick 分享一并结束——地址本来就随进程消失，没法恢复）；结束时整棵进程树（cf → node → cloudflared）都被停掉。服务崩溃后遗留的 quick 记录在下次清扫时结束。cf 进程自己退出，也会在下次清扫时结束这个分享。
- **协议**：默认 QUIC（UDP 7844）在很多网络被挡，cloudflared 一直重试，地址返回 Cloudflare 1033；所以给它设 `TUNNEL_TRANSPORT_PROTOCOL=http2`（`AGORA_TUNNEL_PROTOCOL` 可改）。

**2026-09-29 实测**（`cf` 通过 `npx`，未登录 Cloudflare，只有示例项目的数据；地址用完即撤销）：

- **免登录**：可以。`cf tunnels quick-start` 不需要账号，直接给出地址；`cf` 用的是本机 `PATH` 里已有的 `cloudflared`（没有的话它怎么获取，没验证）。
- **SSE 不通**：一个每秒推一条的 SSE 接口，经 quick 隧道后 6 条在流结束时一起到（缓冲）；直连本地则是逐条到。所以访客页（`web/src/guest/live.ts`）先连 `/api/guest/events`，网关一开头会发 `hello`；5 秒内没收到就关掉、改成每 4 秒轮询 `/api/guest/state`（评论、作者改图、失效都靠它）。实测：访客页打开的时候作者新发的评论在约 8 秒内出现在访客页上（5 秒等 `hello` + 一次轮询）。普通命名隧道不受影响（`hello` 正常到达就不轮询）。
- **QUIC**：这台机器上 UDP 7844 被挡，默认协议连不上（地址 1033 / 530）；改 HTTP/2 后 `Registered tunnel connection`，页面 200。
- **地址生命周期**：创建约 8 秒（`cf` 启动、申请地址、连接）；撤销后进程立即停止，地址返回 530（隧道已不存在）。
- **限制**：Cloudflare 说明 quick 隧道没有可用性保证、只适合试用；并发请求数等具体限制没有实测。
