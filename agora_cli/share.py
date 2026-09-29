"""``agora share create|list|revoke``: share one canvas for viewing and commenting.

    agora share create [--canvas ID|名字] [--for 1h|1d|7d|10m|forever] [--max-opens N] [--domain ZONE] [--quick] [--json]
    agora share list   [--json]
    agora share revoke <id>|--all
    agora share export [--canvas ID|名字] [-o 文件]     the canvas as a share bundle file
    agora import <文件|分享链接>                          bring a bundle in as new canvases

``create`` needs the project's server (``agora up``): it runs the share gateway and the tunnel.
``list`` and ``revoke`` work without it (revoke then cleans up DNS and the tunnel itself).
The link's token is printed once by ``create`` and never stored (only its hash).
``create --quick`` needs no Cloudflare account: ``cf tunnels quick-start`` gives a temporary
trycloudflare.com address (one share at a time; it ends with ``revoke`` or ``agora down``).
``export`` / ``import`` work offline; a bundle, once handed over, cannot be taken back.

Exit codes: 0 ok · 1 failed (see message) · 2 bad usage · 3 needs ``agora up``.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from agora_cli.canvas import call, server_url


def remaining(ms: int | None) -> str:
    if ms is None:
        return "直到撤销"
    s = ms // 1000
    if s >= 86400:
        return f"{s // 86400}天{(s % 86400) // 3600}小时"
    if s >= 3600:
        return f"{s // 3600}小时{(s % 3600) // 60}分"
    return f"{s // 60}分{s % 60}秒"


def opens(s: dict[str, Any]) -> str:
    """Openings used / limit (distinct guests that entered), e.g. ``3/5`` or ``3`` (unlimited)."""
    n = s.get("opens", 0)
    return f"{n}/{s['maxOpens']}" if s.get("maxOpens") else str(n)


def table(shares: list[dict[str, Any]]) -> str:
    if not shares:
        return "没有分享。"
    rows = [("ID", "状态", "画布", "剩余", "打开", "评论", "地址")]
    label = {"active": "有效", "revoked": "已撤销", "expired": "已到期"}
    for s in shares:
        left = remaining(s.get("remainingMs")) if s["status"] == "active" else "—"
        rows.append((s["id"], label.get(s["status"], s["status"]), s.get("canvasTitle") or s["canvasId"], left, opens(s), str(s.get("comments", 0)), s["url"]))
    w = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w[i]) for i, c in enumerate(r)).rstrip() for r in rows)


def read_bundle(source: str) -> Any:
    """A bundle from a file, a share link (``https://host/s/<token>``: opens it like a guest and
    takes the bundle) or a direct bundle URL. Bounded in size; nothing is executed."""
    from server.canvas.share import MAX_BUNDLE_BYTES, BundleError

    if not re.match(r"^https?://", source, re.I):
        path = Path(source).expanduser()
        if not path.is_file():
            raise BundleError(f"{source}: no such file")
        if path.stat().st_size > MAX_BUNDLE_BYTES:
            raise BundleError(f"the file is over {MAX_BUNDLE_BYTES // 2**20} MB")
        raw = path.read_bytes()
    else:
        u = urlsplit(source)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        try:
            if u.path.startswith("/s/"):
                opener.open(source, timeout=30).close()  # sets the share cookie, counts one opening
                source = f"{u.scheme}://{u.netloc}/api/guest/bundle"
            with opener.open(source, timeout=60) as r:
                raw = r.read(MAX_BUNDLE_BYTES + 1)
        except (urllib.error.URLError, OSError) as e:
            raise BundleError(f"could not fetch the bundle: {e}") from None
        if len(raw) > MAX_BUNDLE_BYTES:
            raise BundleError(f"the bundle is over {MAX_BUNDLE_BYTES // 2**20} MB")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise BundleError("not an Agora share bundle (not JSON)") from None


def cmd_import(p, a) -> int:
    from server.canvas.share import BundleError, import_bundle

    p.store.init()
    try:
        res = import_bundle(p.store, read_bundle(a.source))
    except BundleError as e:
        print(f"agora import: {e}")
        return 1
    print(f"已导入 {res['canvases']} 块画布、{res['threads']} 条评论线程（评论是只读的历史）。画布 id {res['canvasId']}；已开着的页面刷新后在「所有画布」里能看到。")
    return 0


def cmd_export(p, a) -> int:
    from server.canvas.sessions import resolve_canvas
    from server.canvas.share import BundleError, canvas_titles, export_bundle, slug

    try:
        cid = resolve_canvas(p.store, a.canvas)
        title = canvas_titles(p.store).get(cid, "")
        data = export_bundle(p.store, cid, title)
    except (ValueError, BundleError) as e:
        print(f"agora share export: {e}")
        return 2
    out = Path(a.output or f"{slug(title or cid)}.agora-share.json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    print(f"{out}（{len(data['canvases'])} 块画布）\n分享包一旦给出去就收不回来：拿到文件的人可以随意保存和转发。")
    return 0


def cmd_share(p, a) -> int:
    from server.canvas.sessions import resolve_canvas
    from server.canvas.share import ShareManager, check_max_opens, parse_duration

    if a.action == "export":
        return cmd_export(p, a)
    base = server_url(p)
    if a.action == "create":
        try:
            ttl = parse_duration(a.duration)
            cid = resolve_canvas(p.store, a.canvas)
            check_max_opens(a.max_opens)
        except ValueError as e:
            print(f"agora share: {e}")
            return 2
        if not base:
            print("agora share: 项目服务没在运行，先 `agora up`（分享网关和隧道由它运行）")
            return 3
        code, res = call(base, "POST", "/api/share", {"canvasId": cid, "ttl": ttl, "maxOpens": a.max_opens, "quick": a.quick, "domain": a.domain}, timeout=120)
        if code != 200:
            zones = (res or {}).get("zones")
            if zones:  # several zones and none chosen: list them, the next step is --domain
                print(f"agora share: 账号里有多个域名，用 --domain 选一个：\n" + "\n".join(f"  {z}" for z in zones) + f"\n例如：agora share create --domain {zones[0]}（选过的会记住；也可以先用 --quick 要一个临时链接）")
                return 1
            print(f"agora share: 创建失败：{(res or {}).get('detail') or res}")
            return 1
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            s = res["share"]
            until = "直到撤销" if s["expiresAt"] is None else time.strftime("%Y-%m-%d %H:%M", time.localtime(s["expiresAt"] / 1000))
            limit = f"最多打开 {s['maxOpens']} 次" if s.get("maxOpens") else "不限打开次数"
            print(f"{res['url']}\n画布「{s.get('canvasTitle') or s['canvasId']}」· 有效期到 {until} · {limit} · id {s['id']}\n链接只显示这一次（只存了令牌的哈希）；撤销：agora share revoke {s['id']}")
            if s.get("quick"):
                print("临时地址：不需要 Cloudflare 账号；同一时间只有这一个分享；撤销或 agora down 后地址失效。这条隧道不支持实时推送，访客页每几秒自己刷新。")
        return 0

    if a.action == "list":
        if base:
            code, res = call(base, "GET", "/api/share")
            shares = res.get("shares", []) if code == 200 else []
        else:
            m = ShareManager(p.store)
            shares = m.list()
        print(json.dumps(shares, ensure_ascii=False, indent=2) if a.json else table(shares))
        return 0

    if a.action == "revoke":
        if not a.id and not a.all:
            print("usage: agora share revoke <id> | --all")
            return 2
        m = None if base else ShareManager(p.store)
        ids = [a.id] if a.id else [s["id"] for s in (m.list() if m else call(base, "GET", "/api/share")[1]["shares"]) if s["status"] == "active"]
        failed = 0
        for id in ids:
            if m is None:
                code, res = call(base, "DELETE", f"/api/share/{id}", timeout=120)
                if code != 200:
                    print(f"{id}: {(res or {}).get('detail') or res}")
                    failed += 1
                    continue
                s = res["share"]
            else:
                try:
                    s = m.revoke(id)
                except KeyError:
                    print(f"{id}: 没有这个分享")
                    failed += 1
                    continue
            left = "（DNS 记录待清理，下次启动服务时重试）" if s.get("cleanup") else ""
            print(f"{id}: {'已撤销' if s['status'] == 'revoked' else s['status']} · {s['host']}{left}")
        if m is not None:
            m.sweep()
        if not ids:
            print("没有有效的分享。")
        return 1 if failed else 0
    return 2


def add_parser(sub) -> None:
    s = sub.add_parser("share", help="share a canvas for viewing and commenting (Cloudflare Tunnel)")
    ssub = s.add_subparsers(dest="action", required=True)
    c = ssub.add_parser("create", help="new share link for one canvas")
    c.add_argument("--canvas", default=None, help="canvas id or name (default: the focused / only canvas)")
    c.add_argument("--for", dest="duration", default="1d", help="how long: 10m, 1h, 1d, 7d, … or forever (until revoked); default 1d")
    c.add_argument("--max-opens", dest="max_opens", type=int, default=None, metavar="N",
                   help="the link can be opened at most N times (each new browser counts once; reopening in the same browser does not); default: unlimited")
    c.add_argument("--domain", default=None, help="the Cloudflare zone to share under (asked for when the account has several; remembered; AGORA_SHARE_DOMAIN wins)")
    c.add_argument("--quick", action="store_true", help="no Cloudflare account: a temporary trycloudflare.com address via `cf tunnels quick-start` (one share at a time)")
    c.add_argument("--json", action="store_true")
    ex = ssub.add_parser("export", help="write the canvas (and the canvases below it) with its comments to a share bundle file")
    ex.add_argument("--canvas", default=None, help="canvas id or name (default: the focused / only canvas)")
    ex.add_argument("-o", "--output", default=None, help="file to write (default: <canvas>.agora-share.json)")
    li = ssub.add_parser("list", help="shares of this project")
    li.add_argument("--json", action="store_true")
    r = ssub.add_parser("revoke", help="end a share now")
    r.add_argument("id", nargs="?")
    r.add_argument("--all", action="store_true", help="every active share of this project")
    for x in (c, ex, li, r):
        x.add_argument("--project", default=None, help="project directory (default: the nearest with .agora/)")
    s.set_defaults(fn=cmd_share)
    i = sub.add_parser("import", help="bring a share bundle (file, share link or bundle URL) in as new canvases, comments read-only")
    i.add_argument("source", help="bundle file, share link, or bundle URL")
    i.add_argument("--project", default=None, help="project directory (default: the nearest with .agora/)")
    i.set_defaults(fn=cmd_import)
