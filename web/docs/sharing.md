# 分享：经 Cloudflare Tunnel 让别人看画布和评论

作者把一块画布分享出去，拿到链接的人（访客）只能**看这块画布、读评论、发评论和回复**。改图、会话、Agent、终端、项目文件一律只属于作者本机。分享走作者自己的公开域名（本机是 `quietharbor.de`），有效期由作者选，到期或撤销后链接立即失效，Cloudflare 上为它建的东西随之删除。

实现：`server/canvas/share.py`（分享记录、令牌、生命周期、限流、访客可见内容）、`server/canvas/share_gateway.py`（访客唯一能到达的网关）、`server/canvas/cloudflare.py`（真实的 DNS / 隧道提供者）、`server/canvas/project_router.py`（`/api/share`、评论合并、推送、网关与清扫的启动）、`agora_cli/share.py`（命令）；前端 `web/src/share/SharePanel.tsx`（作者的分享按钮与列表）、`web/src/guest/`（访客页）、`web/src/persist.ts` 的 `followProject`（作者页收访客评论）。测试 `tests/test_share.py`、`web/src/comments/threads.test.ts`。

## 1. 用法

界面：顶栏「分享」→ 选画布、有效期（1 小时 / 1 天 / 7 天 / 自定义 1 分钟–90 天 / 直到撤销）→「创建链接」。链接**只显示这一次**（服务端只存令牌的哈希），复制后发给别人。下面的「当前分享」列出每个分享的剩余时间、访问次数、评论数和「撤销」；结束的分享留在「已结束」里。

命令（在项目目录，或 `--project`）：

```bash
agora share create --for 1d            # 默认分享聚焦的画布；--canvas <id|名字> 指定；--for 10m|2h|1d|7d|forever
agora share list                       # 表格；--json 输出记录（不含哈希）
agora share revoke <id>                # 立即结束一个；--all 结束本项目全部有效分享
```

退出码：0 成功 · 1 失败（信息在输出里）· 2 用法错误（时长、画布名）· 3 需要先 `agora up`（`create` 需要服务在跑：网关和隧道由它运行）。`list`、`revoke` 在服务没开时直接读写 `.agora/shares/`，`revoke` 自己完成 DNS 和隧道的清理。

## 2. 暴露方式：每个分享一个一级子域名

```
访客浏览器 ──https──> <项目名>-<6 位随机>.quietharbor.de  (Cloudflare 代理的 CNAME → <隧道 id>.cfargotunnel.com)
         ──> cloudflared（本项目一个命名隧道 agora-share-<项目 id 前 8 位>，只有一条 ingress）
         ──> 127.0.0.1:<网关端口>  share_gateway（白名单）──> 项目存储 / 事件
作者浏览器 ──> 127.0.0.1:<项目端口>  项目应用（不经过隧道）
```

- **子域名**：每个分享新建一条代理的 CNAME `<slug>-<随机>.<域名>`（一级子域名，Cloudflare 的通用证书覆盖 `*.<域名>`，不用单独签证书）。撤销或到期时按记录 id 删掉它，名字本身就不存在了（权威 DNS 返回 NXDOMAIN），不只是令牌失效。
- **令牌**：链接是 `https://<主机名>/s/<令牌>`，令牌 32 字节随机（`secrets.token_urlsafe(32)`）。网关验证后把它放进 `HttpOnly; Secure; SameSite=Lax` 的 cookie（有效期不超过分享本身），再 303 跳到 `/`，地址栏里就不再有令牌；`Referrer-Policy: no-referrer` 防止经 Referer 外泄。
- **隧道**：每个项目一个命名隧道，第一次分享时创建，凭据写在 `~/.config/agora/tunnels/<隧道 id>.json`（600），配置 `.yml` 在同一目录，里面只有一条 ingress：本项目的分享网关。所有分享的主机名都指向这一个隧道，网关按 Host 区分分享，所以增删分享不用重启 cloudflared。协议固定 HTTP/2（`AGORA_TUNNEL_PROTOCOL` 可改）：QUIC 用的 UDP 7844 在很多网络被挡，cloudflared 会一直重试 QUIC 连不上。
- **进程**：cloudflared 是项目服务的子进程，和它在同一个进程组，`agora down` 一起停掉；pid、隧道 id、网关端口写在 `.agora/run/share-tunnel.json`，日志 `.agora/run/cloudflared.log`。

**取舍**：另一种做法是一个固定主机名 + 路径令牌（整台机器一条 DNS 记录，分享之间只靠令牌区分）。它少了每次分享一次 DNS 写入（多一两秒），但撤销只能靠令牌检查，名字一直公开可探测；所有分享同源，一个分享页里的 cookie / 本地存储对其他分享可见；多个项目同时分享时还要一个机器级的进程统一路由。每个分享一个子域名把「撤销」做成了「这个名字不存在了」，也让分享之间天然隔离，所以选它。代价：每个分享要一次 Cloudflare API 调用；刚删掉的名字在别人的递归 DNS 缓存里可能还会留几分钟（这时它指向的隧道已删，Cloudflare 返回 530；网关也已不认这个主机名）。

## 3. 访客能做什么（白名单）

网关（`share_gateway.py`）只有这些路由，其余任何方法、任何路径都是 **403**（HTML 失效页或 `{"error": "forbidden"}`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/s/{令牌}` | 验证令牌 → 设分享 cookie 和访客 id cookie（`agora_guest`，16 位随机）→ 303 到 `/`；访问次数 +1 |
| GET | `/`、`/index.html` | 前端页面，注入 `<meta name="robots" content="noindex, nofollow">` 和 `<meta name="agora-guest">`（前端据此进访客模式） |
| GET | `/assets/*` | 前端静态文件（只在 `web/dist/assets` 里，路径穿越被拒） |
| GET | `/api/guest/state` | 被分享的那一块画布（只读）、它的评论线程、`me`（`guest:<id>`）、到期时间 |
| POST | `/api/guest/comments` | `{op: "create", threadId, id, anchor, text, name}` 新线程 / `{op: "reply", threadId, id, text, name}` 回复 |
| GET | `/api/guest/events` | SSE：`threads`（线程变化，已脱敏）、`canvas`（作者改图后的新元素）、`ended`（撤销或到期，页面切到失效页） |

**每个请求**先按 Host 找有效分享（找不到：403，连静态文件也不给）；`/s/` 之后的请求都要带这个分享的令牌 cookie，用 `hmac.compare_digest` 比对哈希（恒定时间）。

访客**不能**：改图（页面是 Excalidraw 的只读模式，且网关没有任何写画布的路由）、解决/重开线程、「交给 Agent」、撤销 Agent 的修改、看会话或轨迹、看进度指针（访客页不挂 `PointerLayer`，元素的 `customData` 整个去掉，所以 `codePaths` 也没有）、看本地路径（`root`、会话 id、turn id 都不下发）、访问 `/api/project`、`/api/agent`（包括终端和 `agora canvas apply` 用的桥接）、`/api/canvas`、`/api/share`、`/libraries`。

访客看到的线程经过 `guest_threads` 脱敏：消息只留 `id / author / text / at / tone / by`；非访客的身份 id（作者的 `mailto:邮箱`）换成 `member:<sha256 前 10 位>`，只保留显示名（git `user.name`）。

**评论的身份**：访客第一次评论前填显示名（存在他浏览器的 localStorage，最多 40 字）；服务端写入时用 cookie 里的访客 id：`by: {id: "guest:<id>", name}`，和本机用户的评论同构（`author: "human"`），写进同一个 `threads/<canvasId>.json`，`participants` 自然包含访客。线程编号 `n` 由服务端按 `seq` 分配。锚点必须指向画布上存在的元素，数值必须有限；正文最多 4000 字。

## 4. 两方同时写评论：按操作合并

访客和作者会同时写同一个线程文件，所以线程不再走整文件 CAS（`project-storage.md` §6 预留的方案）：

- 访客：`store.thread_op`，在项目写锁里读最新文件、应用「新建线程 / 追加消息」、原子写回。
- 作者页：保存线程改为 `POST /api/project/threads/{id}/merge`（`store.merge_threads`）：按 id 合并，作者页有的字段（resolved、消息改动）以作者页为准，磁盘上作者页没有的线程和消息（访客的）保留；两个新线程编号相撞时给作者页那条重新编号。合并从不返回 409，所以线程不会再弹「在别处被改过」。
- 推送：每次合并或访客写入，服务端发 `threads` 事件；作者页经 `GET /api/project/events`（SSE）收到后并入内存里的线程（只加不删），访客页经 `/api/guest/events` 收到脱敏后的版本。作者改图保存（`PUT /canvases/{id}`）发 `canvas` 事件，访客页随之更新画面。

## 5. 有效期、撤销与清理

- **判定**：令牌检查本身就看到期时间，到点那一刻起所有请求 403，不依赖清扫。
- **清扫**：项目服务每 5 秒清扫一次：结束到期的分享，重试没做完的清理。
- **结束一个分享**（撤销或到期）：先把 `endedAt / endReason` 写盘（此后令牌必然无效，Cloudflare 那边出什么错都不影响），通知在线访客页（`ended`），再按记录 id 删 DNS 记录；删失败记在 `cleanup: ["dns"]` 里，下次清扫重试（列表里显示「DNS 记录待清理」）。
- **没有有效分享时**：停 cloudflared，按名字 `agora-share-<项目 id 前 8 位>` 找到本项目的隧道并删除（`cloudflared tunnel delete -f <id>`），删掉它的凭据和配置文件。只动这个名字的隧道，账号里其他隧道不碰。
- **服务停止**（`agora down`）：cloudflared 一起停；有效分享留在记录里，下次 `agora up` 时先结束期间到期的，再为剩下的重新连上隧道。服务停着的这段时间，访客会看到 Cloudflare 的 530。
- **创建失败**：隧道连不上或 DNS 建不了时不留分享记录，已建的隧道由下一次清扫删除。

## 6. 记录与密钥放在哪

| 内容 | 位置 | 进 git |
|---|---|---|
| 分享记录：id、画布、主机名、**令牌的 sha256**、创建/到期/结束时间、访问/访客/评论数、DNS 记录 id、隧道 id、待清理项 | `.agora/shares/shares.json` | 否：模板 `.gitignore` 有 `shares/`，目录里另有一个 `*` 的 `.gitignore`（旧项目的 `.agora/.gitignore` 没有这一行也照样忽略） |
| 令牌原文 | 不存。只在创建时返回一次 | — |
| 隧道凭据与配置 | `~/.config/agora/tunnels/`（目录 700，凭据 600；`AGORA_CONFIG_DIR` 可改） | 否（不在项目里） |
| Cloudflare API 凭据 | `AGORA_CF_API_TOKEN` + `AGORA_CF_ZONE_ID`；没有就用 `cloudflared tunnel login` 生成的 `~/.cloudflared/cert.pem` 里那个 zone 范围的令牌（与 `cloudflared tunnel route dns` 用的是同一个），Agora 不复制它 | 否 |
| 分享域名 | `AGORA_SHARE_DOMAIN`；不设就用上面那个 zone 的名字 | — |

## 7. 威胁模型

| 威胁 | 处理 |
|---|---|
| 链接外泄给不该看的人 | 分享本来就是「有链接即可看、可评论」；控制手段是有效期和随时撤销。撤销后令牌、主机名、隧道都没了 |
| 猜令牌 / 爆破 | 256 位随机；`/s/` 每个地址每分钟 10 次；比较恒定时间；主机名本身也是随机的，不知道主机名连网关都到不了 |
| 从磁盘或 git 拿到令牌 | 只存哈希；记录不进 git |
| 访客越权改图、调 Agent、开终端、读会话或项目文件 | 隧道只通到网关，作者的应用不在隧道后面；网关白名单之外一律 403；作者应用拒绝带 `cf-*` 头或 Host 是分享主机名的请求（防止配置失误或 DNS rebinding 把它暴露出去） |
| 泄露本地信息 | 下发内容去掉 `customData`（代码路径）、会话/turn id、项目根路径；作者邮箱换成不透明 id；访客页不加载进度指针和会话 |
| 刷评论 / 占资源 | 写每地址每分钟 20 次，读 120 次，SSE 连接每分钟 10 次、每个分享最多 50 条；正文 4000 字、名字 40 字上限；地址取 `CF-Connecting-IP` |
| 冒充别的访客 | 访客 id 是网关发的随机 cookie，不签名；改 cookie 只能换一个 `guest:` 身份，显示名本来就是自填的，冒充不了作者（作者的 id 不是 `guest:`） |
| 被搜索引擎收录 / 被嵌入 | `noindex` meta 与 `X-Robots-Tag`；`X-Frame-Options: DENY`、`frame-ancestors 'none'`；接口 `Cache-Control: no-store` |
| Cloudflare 清理失败留下 DNS 记录 | 令牌已先失效；记录 id 留在 `cleanup` 里，清扫重试，列表可见 |

不防：拿到作者机器本身的人；作者自己把 `cert.pem` 或隧道凭据放进仓库。

## 8. 验收记录

2026-09-28 在 `/tmp/agora-share-e2e`（只有示例架构图）用真实的 `quietharbor.de` 实测，截图与探测记录在 `web/evidence/sharing/`：

1. 界面建 10 分钟分享（`01`；`02` 是修好弹层溢出后用假接口响应重拍的布局，链接是示例值）→ 访客页首次进入要名字（`03`）→ 在 Redis 上钉评论（`04`、`05`）→ 作者页没刷新就出现了钉子（等待检查 9 ms 即通过，`06`，带「访客」标记）→ 作者回复，访客页实时看到（`07`）。
2. 访客在页面上拖动、全选删除：画布文件哈希不变；13 个非白名单接口全部 403，`/api/guest/state` 里没有邮箱、代码路径、本地路径（`08`）。
3. 作者在列表里撤销（`09`）→ 访客页 0.3 秒内切到失效页，接口 403（`10`、`11`）；权威 DNS 对该主机名 NXDOMAIN，隧道已删。
4. `agora share create --for 2m` → 访客打开（`12`）→ 到期后页面自动失效，清扫在到期后 0.3 秒结束分享并删掉 DNS 和隧道（`13`）。

第一次尝试时 cloudflared 在这台机器上连不上 QUIC，45 秒超时，创建失败；隧道由清扫删除。之后固定用 HTTP/2。
