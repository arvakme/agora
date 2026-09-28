"""``agora canvas …`` and ``agora skill …``: the commands the agora-canvas skill teaches.

Every canvas command prints one JSON object. With the project's server running (``agora
up``) they go through it, so writes reach the open page (which validates, checks
freshness, applies one undoable batch and records it in the session). With no server,
``read``/``list``/``search``/``schema`` read the project's files directly and writes ask
for ``agora up``.

Exit codes: 0 ok · 1 refused (invalid / stale / error, see the JSON) · 2 bad usage ·
3 needs the server or an open page.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]


def find_root(explicit: str | None) -> Path:
    """--project, else $AGORA_PROJECT, else the nearest ancestor with .agora/config.toml, else cwd."""
    if explicit:
        return Path(explicit).resolve()
    if os.environ.get("AGORA_PROJECT"):
        return Path(os.environ["AGORA_PROJECT"]).resolve()
    here = Path.cwd().resolve()
    for d in [here, *here.parents]:
        if (d / ".agora" / "config.toml").exists():
            return d
    return here


def out(obj: Any, code: int = 0) -> int:
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def call(base: str, method: str, path: str, body: Any = None, timeout: float = 60) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except json.JSONDecodeError:
            return e.code, {"error": str(e)}


def read_input(arg: str | None) -> Any:
    """JSON from --json/--file argument text, or stdin."""
    raw = arg if arg is not None else sys.stdin.read()
    if arg is not None and not arg.lstrip().startswith(("{", "[")) and Path(arg).is_file():
        raw = Path(arg).read_text()
    return json.loads(raw)


def server_url(p) -> str | None:
    st = p.live()
    return f"http://127.0.0.1:{st['port']}" if st else None


def cmd_canvas(p, a) -> int:
    from server.canvas import schemas
    from server.canvas.sessions import canvas_names, file_read, resolve_canvas, save_read

    store = p.store
    session = a.session or os.environ.get("AGORA_SESSION") or None
    canvas = a.canvas or os.environ.get("AGORA_CANVAS") or None
    base = server_url(p)
    try:
        if a.action == "schema":
            name = {"ops": "plan.schema.json", "anim": "anim.schema.json"}[a.what]
            return out(schemas.load(name))

        if a.action == "list":
            if base:
                code, body = call(base, "GET", "/api/agent/canvas/list")
                return out(body, 0 if code == 200 else 1)
            return out({"canvases": [{"id": i, "name": n} for i, n in canvas_names(store).items()], "sessions": [{"id": s, **b} for s, b in store.bindings().items()], "page": False, "server": False})

        if a.action == "read":
            if base:
                code, body = call(base, "POST", "/api/agent/canvas/read", {"canvas": canvas, "session": session})
                return out(body, 0 if code == 200 else 1)
            cid = resolve_canvas(store, canvas, session)
            got = file_read(store, cid)
            token = save_read(store, cid, got.pop("versions"))
            info = {"id": cid, "name": got["name"], **{k: got["scene"].pop(k) for k in ("path", "parent") if k in got["scene"]}}
            return out({"canvas": info, "base": token, "source": "file", "scene": got["scene"]})

        if a.action == "child":
            parent = a.parent or canvas
            if a.op == "list" and not base:
                from server.canvas import nested

                cid = resolve_canvas(store, parent, session)
                names = canvas_names(store)
                return out({"canvas": {"id": cid, "name": names.get(cid, cid)}, "children": nested.list_children(store, cid, names)})
            if not base:
                return out({"error": "Agora 服务没在运行：先在项目里 `agora open`（子画布由打开的页面创建和挂接）。"}, 3)
            if a.op != "list" and not a.node:
                return out({"error": f"usage: agora canvas child {a.op} --node <id|label> [--parent <canvas>]" + (" --child <canvas>" if a.op == "link" else "")}, 2)
            code, res = call(base, "POST", "/api/agent/canvas/child", {"op": a.op, "canvas": parent, "session": session, "node": a.node, "child": a.child, "title": a.title}, timeout=60)
            if code == 503:
                return out(res, 3)
            if code == 400:
                return out(res, 2)
            ok = code == 200 and (a.op == "list" or res.get("status") in ("created", "exists", "linked", "unlinked"))
            return out(res, 0 if ok else 1)

        if a.action == "search":
            q = " ".join(a.query)
            if base:
                code, body = call(base, "GET", f"/api/canvas/library/search?limit={a.limit}&q={urllib.request.quote(q)}")
                return out(body, 0 if code == 200 else 1)
            from server.canvas.library import Library

            return out({"items": Library().search(q, a.limit)})

        if a.action == "link":
            if not base:
                return out({"error": "Agora 服务没在运行：先在项目里 `agora open`（关联由打开的页面写进画布）。"}, 3)
            if a.json is not None:
                links = read_input(a.json)
                if not isinstance(links, dict):
                    return out({"error": "--json takes an object: {\"<element id or label>\": [\"glob\", …]}"}, 2)
            elif a.element:
                links = {a.element: list(a.globs or [])}
            else:
                return out({"error": "usage: agora canvas link <element> <glob…> | --json '{…}' [--clear]"}, 2)
            code, res = call(base, "POST", "/api/agent/canvas/link", {"canvas": canvas, "session": session, "links": links, "clear": a.clear}, timeout=60)
            if code == 503:
                return out(res, 3)
            if code == 400:
                return out(res, 2)
            return out(res, 0 if code == 200 and res.get("status") == "linked" else 1)

        if a.action in ("apply", "anim"):
            if not base:
                return out({"error": "Agora 服务没在运行：先在项目里 `agora open`（改图由打开的页面执行）。"}, 3)
            payload = read_input(a.json)
            if a.action == "apply":
                if isinstance(payload, list):
                    payload = {"ops": payload}
                body = {"canvas": canvas, "session": session, "base": a.base, "ops": payload.get("ops"), "note": a.note or payload.get("note")}
            else:
                body = {"canvas": canvas, "session": session, "script": payload}
            code, res = call(base, "POST", f"/api/agent/canvas/{a.action}", body, timeout=90)
            if code == 503:
                return out(res, 3)
            ok = code == 200 and res.get("status") in ("applied", "mounted", "empty")
            return out(res, 0 if ok else 1)
    except (ValueError, json.JSONDecodeError) as e:
        return out({"error": str(e)}, 2)
    return 2


def cmd_skill(p, a) -> int:
    from server.canvas.agents import SKILL_DIR, install_skill

    agents = ["claude", "pi", "codex"] if a.agent == "all" else [a.agent]
    return out({"skill": str(SKILL_DIR), "installed": install_skill(p.root, agents, copy=a.copy)})


def add_parsers(sub) -> None:
    c = sub.add_parser("canvas", help="read and edit this project's canvases (used by the agora-canvas skill)")
    c.add_argument("--project", default=None, help="project directory (default: $AGORA_PROJECT or the nearest .agora/)")
    csub = c.add_subparsers(dest="action", required=True)
    for name, help in (
        ("list", "canvases and agent sessions of this project"),
        ("read", "the canvas as the model sees it, plus a base token for apply"),
        ("search", "search the asset library"),
        ("apply", "apply typed ops (JSON on stdin or --json) as one undoable change"),
        ("anim", "mount an animation script (JSON on stdin or --json)"),
        ("schema", "print the JSON schema of ops or animation scripts"),
        ("link", "associate a diagram element with code paths (globs) for the progress pointer"),
        ("child", "nested canvases: create / link / unlink the canvas a node opens into, or list them"),
    ):
        s = csub.add_parser(name, help=help)
        s.add_argument("--canvas", default=None, help="canvas id or name (default: $AGORA_CANVAS / the session's canvas)")
        s.add_argument("--session", default=None, help="Agora session id (default: $AGORA_SESSION)")
        if name == "search":
            s.add_argument("query", nargs="+")
            s.add_argument("--limit", type=int, default=8)
        if name == "apply":
            s.add_argument("--base", required=True, help="the base token printed by `agora canvas read`")
            s.add_argument("--note", default=None, help="one short sentence for the person")
        if name in ("apply", "anim"):
            s.add_argument("--json", default=None, help="JSON text or a file path (default: stdin)")
        if name == "schema":
            s.add_argument("what", choices=["ops", "anim"])
        if name == "child":
            s.add_argument("op", choices=["create", "link", "unlink", "list"])
            s.add_argument("--parent", default=None, help="the parent canvas (id or name; default: --canvas / $AGORA_CANVAS)")
            s.add_argument("--node", default=None, help="the node on the parent canvas: its id or exact label")
            s.add_argument("--child", default=None, help="link: the existing canvas to open from the node")
            s.add_argument("--title", default=None, help="create: the child canvas's name (default: the node's label)")
        if name == "link":
            s.add_argument("element", nargs="?", help="element id or its exact label")
            s.add_argument("globs", nargs="*", help="code paths relative to the project root, e.g. 'server/**' 'web/src/api/*.ts'")
            s.add_argument("--json", default=None, help='several at once: {"<element>": ["glob", …], …} (text or a file path)')
            s.add_argument("--clear", action="store_true", help="replace the element's paths with the given ones (none = remove them)")
    c.set_defaults(fn=cmd_canvas)

    k = sub.add_parser("skill", help="put the agora-canvas skill where Pi / Claude Code / Codex find it in this project")
    k.add_argument("--project", default=None)
    ksub = k.add_subparsers(dest="skill_action", required=True)
    i = ksub.add_parser("install", help="link skills/agora-canvas into the project (.claude/skills, .agents/skills)")
    i.add_argument("--agent", choices=["all", "claude", "pi", "codex"], default="all")
    i.add_argument("--copy", action="store_true", help="copy instead of symlink")
    k.set_defaults(fn=cmd_skill)
