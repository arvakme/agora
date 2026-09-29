"""``agora dispatch`` and ``agora reply``: give a task to another session, and hand the receipt back.

    agora dispatch --to <session> | --new claude|codex|pi  --task-file t.md [--scope 'server/**'] [--model M --effort E]
    agora dispatch status <id> | wait <id> [--timeout S] | interrupt <id> | list [--active]
    agora reply --request <id> --status done|failed|blocked [-f reply.md | --text '…']

The giver is the session this runs in (``$AGORA_SESSION``, set for every agent process Agora starts): no
guessing from a terminal pane. Everything goes through the project's server (``agora up``); ``reply`` alone
falls back to writing the receipt under ``.agora/dispatch/<id>/`` when the server cannot be reached, and the
server takes it up next time it looks at that dispatch. One JSON object is printed.

Exit codes: 0 ok · 1 refused (see the JSON) · 2 bad usage · 3 needs the server.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from agora_cli.canvas import call, out, server_url

STATES_DONE = ("done", "failed", "blocked", "idle_no_reply", "interrupted")


def cmd_dispatch(p, a) -> int:
    base = server_url(p)
    if not base:
        return out({"error": "Agora 服务没在运行：先在项目里 `agora up`（派发经服务端记录和投递）。"}, 3)
    if a.action in ("status", "wait", "interrupt"):
        if not a.rid:
            return out({"error": f"usage: agora dispatch {a.action} <id>"}, 2)
        if a.action == "status":
            code, body = call(base, "GET", f"/api/agent/dispatches/{a.rid}")
        elif a.action == "interrupt":
            code, body = call(base, "POST", f"/api/agent/dispatches/{a.rid}/interrupt")
        else:
            code, body = call(base, "GET", f"/api/agent/dispatches/{a.rid}/wait?timeout={a.timeout}", timeout=a.timeout + 30)
        ok = code == 200
        # wait: 0 when it ended in done, 1 for any other end, 4 when the time ran out (still going)
        if ok and a.action == "wait":
            state = body.get("state")
            return out(body, 0 if state == "done" else 1 if state in STATES_DONE else 4)
        return out(body, 0 if ok else 1)
    if a.action == "list":
        code, body = call(base, "GET", f"/api/agent/dispatches?active={1 if a.active else 0}" + (f"&session={a.session}" if a.session else ""))
        return out(body, 0 if code == 200 else 1)
    # create
    if bool(a.to) == bool(a.new):
        return out({"error": "usage: agora dispatch (--to <session> | --new claude|codex|pi) --task-file <file> [--scope …]"}, 2)
    if not a.task_file and not a.text:
        return out({"error": "the task: --task-file <file> (or --text '…')"}, 2)
    src = a.session or os.environ.get("AGORA_SESSION")
    text = a.text if a.text is not None else (sys.stdin.read() if a.task_file == "-" else Path(a.task_file).read_text())
    body = {
        "source": {"kind": "session", "sessionId": src} if src else {"kind": "user"},
        "to": a.to,
        "new": a.new,
        "task": text,
        "scope": a.scope or [],
        "model": a.model or "",
        "effort": a.effort or "",
    }
    code, res = call(base, "POST", "/api/agent/dispatches", body)
    return out(res, 0 if code == 200 and not res.get("error") else 1 if code in (200, 400, 404, 409) else 3)


def cmd_reply(p, a) -> int:
    text = a.text if a.text is not None else (Path(a.file).read_text() if a.file and a.file != "-" else sys.stdin.read() if a.file == "-" else "")
    base = server_url(p)
    session = a.session or os.environ.get("AGORA_SESSION")
    if base:
        code, res = call(base, "POST", f"/api/agent/dispatches/{a.request}/reply", {"status": a.status, "text": text, "session": session})
        return out(res, 0 if code == 200 else 1)
    # No server: the receipt is a file the server reads when it next looks at this dispatch.
    from server.canvas.dispatch_store import ID_RE, REPLY_STATUSES

    if a.status not in REPLY_STATUSES or not ID_RE.fullmatch(a.request):
        return out({"error": f"--request is a dispatch id, --status one of {', '.join(REPLY_STATUSES)}"}, 2)
    folder = p.store.dir / "dispatch" / a.request
    if not (p.store.dir / "dispatch" / f"{a.request}.json").exists():
        return out({"error": f"no dispatch {a.request} in this project"}, 1)
    from server.canvas.project import ProjectStore

    ProjectStore._atomic(folder / "reply.md", text.encode())
    ProjectStore._atomic(folder / "reply.status", a.status.encode())
    return out({"queued": True, "note": "Agora 服务没在运行：回执已写进项目，服务下次看这条派发时接收。", "dir": str(folder)}, 3)


def add_parsers(sub) -> None:
    d = sub.add_parser("dispatch", help="give a task to another session (or a new one); status / wait / interrupt / list")
    d.add_argument("action", nargs="?", choices=["status", "wait", "interrupt", "list"], default=None, help="omit to give a task")
    d.add_argument("rid", nargs="?", help="the dispatch id (status / wait / interrupt)")
    d.add_argument("--project", default=None, help="project directory (default: $AGORA_PROJECT or the nearest .agora/)")
    d.add_argument("--to", default=None, help="the session (id) to give the task to")
    d.add_argument("--new", default=None, choices=["claude", "codex", "pi"], help="give it to a new session of this agent")
    d.add_argument("--task-file", default=None, help="the task text (a file, or - for stdin)")
    d.add_argument("--text", default=None, help="the task text itself")
    d.add_argument("--scope", nargs="*", default=None, help="where the work belongs, e.g. 'server/**' (a hint, not a sandbox)")
    d.add_argument("--model", default=None)
    d.add_argument("--effort", default=None)
    d.add_argument("--session", default=None, help="the giving session (default: $AGORA_SESSION); list: only dispatches of this session")
    d.add_argument("--timeout", type=float, default=600.0, help="wait: seconds")
    d.add_argument("--active", action="store_true", help="list: only the ones that are not over")
    d.set_defaults(fn=cmd_dispatch)

    r = sub.add_parser("reply", help="hand the receipt of a dispatched task back to whoever gave it")
    r.add_argument("--request", required=True, help="the dispatch id (in the message that gave you the task)")
    r.add_argument("--status", required=True, choices=["done", "failed", "blocked"])
    r.add_argument("-f", "--file", default=None, help="the reply text (a file, or - for stdin)")
    r.add_argument("--text", default=None)
    r.add_argument("--project", default=None)
    r.add_argument("--session", default=None, help="the replying session (default: $AGORA_SESSION)")
    r.set_defaults(fn=cmd_reply)
