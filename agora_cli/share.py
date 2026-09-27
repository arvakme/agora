"""``agora share create|list|revoke``: share one canvas for viewing and commenting.

    agora share create [--canvas ID|名字] [--for 1h|1d|7d|10m|forever] [--json]
    agora share list   [--json]
    agora share revoke <id>|--all

``create`` needs the project's server (``agora up``): it runs the share gateway and the tunnel.
``list`` and ``revoke`` work without it (revoke then cleans up DNS and the tunnel itself).
The link's token is printed once by ``create`` and never stored (only its hash).

Exit codes: 0 ok · 1 failed (see message) · 2 bad usage · 3 needs ``agora up``.
"""

from __future__ import annotations

import json
import time
from typing import Any

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


def table(shares: list[dict[str, Any]]) -> str:
    if not shares:
        return "没有分享。"
    rows = [("ID", "状态", "画布", "剩余", "访问", "评论", "地址")]
    label = {"active": "有效", "revoked": "已撤销", "expired": "已到期"}
    for s in shares:
        left = remaining(s.get("remainingMs")) if s["status"] == "active" else "—"
        rows.append((s["id"], label.get(s["status"], s["status"]), s.get("canvasTitle") or s["canvasId"], left, str(s.get("visits", 0)), str(s.get("comments", 0)), s["url"]))
    w = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w[i]) for i, c in enumerate(r)).rstrip() for r in rows)


def cmd_share(p, a) -> int:
    from server.canvas.sessions import resolve_canvas
    from server.canvas.share import ShareManager, parse_duration

    base = server_url(p)
    if a.action == "create":
        try:
            ttl = parse_duration(a.duration)
            cid = resolve_canvas(p.store, a.canvas)
        except ValueError as e:
            print(f"agora share: {e}")
            return 2
        if not base:
            print("agora share: 项目服务没在运行，先 `agora up`（分享网关和隧道由它运行）")
            return 3
        code, res = call(base, "POST", "/api/share", {"canvasId": cid, "ttl": ttl}, timeout=120)
        if code != 200:
            print(f"agora share: 创建失败：{(res or {}).get('detail') or res}")
            return 1
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            s = res["share"]
            until = "直到撤销" if s["expiresAt"] is None else time.strftime("%Y-%m-%d %H:%M", time.localtime(s["expiresAt"] / 1000))
            print(f"{res['url']}\n画布「{s.get('canvasTitle') or s['canvasId']}」· 有效期到 {until} · id {s['id']}\n链接只显示这一次（只存了令牌的哈希）；撤销：agora share revoke {s['id']}")
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
    c.add_argument("--json", action="store_true")
    li = ssub.add_parser("list", help="shares of this project")
    li.add_argument("--json", action="store_true")
    r = ssub.add_parser("revoke", help="end a share now")
    r.add_argument("id", nargs="?")
    r.add_argument("--all", action="store_true", help="every active share of this project")
    for x in (c, li, r):
        x.add_argument("--project", default=None, help="project directory (default: the nearest with .agora/)")
    s.set_defaults(fn=cmd_share)
