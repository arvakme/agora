"""``agora doctor`` and the local safety-net commands.

    agora doctor [--fix] [--json]            what is wrong with this project's local state, and what can be put back
    agora backup                             back up sessions/, trash/, local/ now (outside the project)
    agora restore [--from latest|<ms>] [--overwrite]   put back files from a backup (missing ones only by default)
    agora history [<file>]                   earlier versions of canvases / threads / workspace.json kept outside the project
    agora history <file> --restore <ms>      write one of them back (an open page reports it as a conflict)

Doctor checks (web/docs/project-storage.md §4): which copy this is (and whether it moved / was copied
/ is a fresh clone), listed sessions without a binding here (restorable from the machine registry)
or without their record (restorable from a backup), native logs that are missing / ambiguous / in
another directory, Claude Code sessions close to Claude's 30-day cleanup, canvases listed without a
file and files not listed, the trash, tmux servers left under old names, and backups. ``--fix``
restores what can be restored exactly: records from the newest backup (missing files only), bindings
from the registry, a backup when there is none from today. It never deletes anything.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

STALE_DAYS = 20


def _claude_cleanup_set() -> bool:
    try:
        return "cleanupPeriodDays" in json.loads((Path.home() / ".claude" / "settings.json").read_text())
    except (OSError, ValueError):
        return False


def diagnose(p, *, fix: bool = False) -> list[dict[str, Any]]:
    """Findings: {level: ok|info|warn|error, what, message, fix?: str, fixed?: bool}."""
    from server.canvas import agents
    from server.canvas.backup import Backups
    from server.canvas.trash import Trash

    out: list[dict[str, Any]] = []

    def say(level: str, what: str, message: str, **kw: Any) -> None:
        out.append({"level": level, "what": what, "message": message, **kw})

    store, local = p.store, p.local
    if not store.exists():
        say("error", "project", f"{store.dir} 不存在：这里还不是 Agora 项目（`agora init` 或 `agora up`）")
        return out
    p.reconcile()
    inst = local.instance() or {}
    say("ok", "instance", f"实例 {inst.get('instanceId', '?')[:8]} · {store.root}")
    kind = (local.change() or {}).get("kind")
    if kind:
        say("info", "instance", {"moved": f"项目从 {local.change().get('from')} 移过来", "copied": f"这是 {local.change().get('from')} 的副本", "fresh": "新 clone / 换机器 / 本机记录被清掉", "reattached": "本机记录丢过，已按注册表认回"}.get(kind, kind) + "（页面会提示一次）")

    st = p.live()
    say("ok" if st else "info", "server", f"服务在跑：{st['url']}（pid {st['pid']}）" if st else "服务没在跑（`agora up`）")

    ws = store.read_workspace_quiet() or {}
    docs = [d for d in ws.get("docs") or [] if isinstance(d, dict)]
    backups = Backups(store, local)
    # ——— records and bindings (git clean -fdx, a fresh clone) ———
    listed = [d for d in docs if d.get("kind") == "session" and isinstance(d.get("sessionId"), str)]
    no_record = [d["sessionId"] for d in listed if not (store.dir / "sessions" / f"{d['sessionId']}.jsonl").exists()]
    if no_record:
        have = backups.list()
        if fix and have:
            got = backups.restore()
            say("info", "records", f"从备份 {time.strftime('%Y-%m-%d %H:%M', time.localtime(have[0]['at'] / 1000))} 放回了 {len(got)} 个文件（只放回缺的）", fixed=True)
            no_record = [s for s in no_record if not (store.dir / "sessions" / f"{s}.jsonl").exists()]
        if no_record:
            level = "warn" if have else "info"
            say(level, "records", f"{len(no_record)} 个会话没有改图记录（sessions/<id>.jsonl）" + ("：最新的备份里有，`agora doctor --fix` 放回" if have and not fix else "：没有备份可以放回（改图记录只在本机）"), sessions=no_record, fix="restore-backup" if have else None)
    bindings = store.bindings()
    registry = local.registry.binds(local.project_id())
    missing = [d["sessionId"] for d in listed if d["sessionId"] not in bindings]
    recoverable = [s for s in missing if s in registry]
    if recoverable and fix:
        for sid in recoverable:
            e = registry[sid]
            store.bind(sid, agent=e["agent"], model=e.get("model") or "", effort=e.get("effort") or "", native_id=e.get("nativeId"), at=int(time.time() * 1000), started=e.get("started") if e.get("started") is not None else bool(e.get("nativeId")))
            local.note("import", sessionId=sid, agent=e["agent"], model=e.get("model"), nativeId=e.get("nativeId"), reason="doctor")
        say("info", "bindings", f"从本机注册表恢复了 {len(recoverable)} 个会话的绑定", sessions=recoverable, fixed=True)
        bindings = store.bindings()
    elif recoverable:
        gone = not (store.dir / "sessions").exists() or not any((store.dir / "sessions").glob("*.agent.json"))
        say("warn", "bindings", ("看起来 .agora/sessions/ 被删了（git clean -x？）。" if gone else "") + f"本机注册表里有 {len(recoverable)} 个会话的绑定，`agora doctor --fix` 恢复", sessions=recoverable, fix="restore-bindings")
    foreign = [s for s in missing if s not in registry]
    if foreign:
        say("info", "bindings", f"{len(foreign)} 个会话是在别的机器或别的位置建的（本机没有它们的记录）：页面上显示只读卡片", sessions=foreign)

    # ——— native logs ———
    now = time.time()
    stale = []
    for sid, b in sorted(bindings.items()):
        if not b.get("nativeId") or b.get("pendingFork"):
            continue
        look = agents.locate_log(b["agent"], b["nativeId"], store.root, hint=(b.get("log") or {}).get("path"))
        if look.state != "found":
            if b.get("started", True):
                say("warn", "native", f"{sid}：{agents.native_problem(b['agent'], b['nativeId'], look)}", session=sid, candidates=[str(c) for c in look.candidates])
            continue
        if b["agent"] == "claude" and look.path is not None:
            idle = (now - look.path.stat().st_mtime) / 86400
            if idle >= STALE_DAYS:
                stale.append((sid, int(idle)))
    if stale and not _claude_cleanup_set():
        say("warn", "claude-cleanup", f"{len(stale)} 个 Claude Code 会话超过 {STALE_DAYS} 天没有活动（{', '.join(f'{s} {d} 天' for s, d in stale)}）。Claude Code 默认 30 天后删除会话记录；要保留，在 ~/.claude/settings.json 里设 cleanupPeriodDays。Agora 已为这些会话保存轨迹快照。", sessions=[s for s, _ in stale])
    copies = local.copies()
    if copies:
        say("info", "copies", f"{len(copies)} 个会话是从 {next(iter(copies.values())).get('from')} 复制来的，在这里只读，可以在页面上分叉继续", sessions=sorted(copies))

    # ——— canvases ———
    listed_canvases = {d["id"] for d in docs if d.get("kind") == "canvas" and d.get("id")}
    files = {q.name.removesuffix(".excalidraw") for q in (store.dir / "canvases").glob("*.excalidraw")}
    if listed_canvases - files:
        say("warn", "canvases", f"清单里有、文件不在的画布：{', '.join(sorted(listed_canvases - files))}（git 里找得回来，或者在回收站）")
    if files - listed_canvases and docs:
        say("warn", "canvases", f"有文件、清单里没有的画布：{', '.join(sorted(files - listed_canvases))}")
    if not ws and files:
        say("warn", "canvases", "workspace.json 缺失或读不了：打开页面会按磁盘上的画布恢复列表")

    items = Trash(store).list()
    if items:
        soon = [m for m in items if m["daysLeft"] <= 3]
        say("info", "trash", f"回收站里有 {len(items)} 项" + (f"，{len(soon)} 项 3 天内清除" if soon else ""))

    # ——— leftovers and backups ———
    sockets = [s for s in local.legacy_sockets() if s != local.socket() and _tmux_alive(s)]
    if sockets:
        say("warn", "tmux", f"旧名字下还有 tmux 服务器在跑：{', '.join(sockets)}（`agora down` 会关掉）")
    last = backups.list()
    if fix and backups.due():
        made = backups.make(force=True)
        if made:
            say("info", "backup", f"做了一次备份：{made['path']}", fixed=True)
            last = backups.list()
    if last:
        age = (time.time() * 1000 - last[0]["at"]) / 3600000
        say("ok" if age < 48 else "warn", "backup", f"最近一次本机备份 {age:.0f} 小时前（{len(last)} 份，{backups.dir}）")
    elif not fix:
        say("warn", "backup", "还没有本机备份（`agora backup` 或 `agora doctor --fix`）", fix="backup")
    return out


def _tmux_alive(socket: str) -> bool:
    try:
        return subprocess.run(["tmux", "-L", socket, "list-sessions"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


MARK = {"ok": "  ok ", "info": "  ·  ", "warn": "注意 ", "error": "问题 "}


def cmd_doctor(p, a) -> int:
    findings = diagnose(p, fix=a.fix)
    if a.json:
        print(json.dumps(findings, ensure_ascii=False, indent=2))
    else:
        for f in findings:
            print(f"{MARK[f['level']]}{f['message']}{'（已修复）' if f.get('fixed') else ''}")
    return 1 if any(f["level"] in ("warn", "error") and not f.get("fixed") for f in findings) else 0


def cmd_backup(p, _a) -> int:
    from server.canvas.backup import Backups

    p.reconcile()
    made = Backups(p.store, p.local).make(force=True)
    print(f"backed up: {made['path']} ({made['size']} bytes)" if made else "nothing to back up (no sessions/, trash/ or local/)")
    return 0


def cmd_restore(p, a) -> int:
    from server.canvas.backup import Backups

    p.reconcile()
    b = Backups(p.store, p.local)
    at = None if a.source in (None, "latest") else int(a.source)
    try:
        got = b.restore(at, overwrite=a.overwrite)
    except FileNotFoundError as e:
        print(f"agora: {e}", file=sys.stderr)
        return 1
    print("\n".join(f"restored {g}" for g in got) or "nothing to restore: every file is already there (--overwrite to replace)")
    return 0


def cmd_history(p, a) -> int:
    from server.canvas.backup import FileHistory

    h = FileHistory(p.local)
    if a.restore:
        if not a.file:
            print("usage: agora history <file> --restore <ms>", file=sys.stderr)
            return 2
        data = h.read(a.file, int(a.restore))
        kind, _, rest = a.file.partition("/")
        target = {"canvases": "canvas", "threads": "threads"}.get(kind)
        if a.file == "workspace.json":
            p.store.write("workspace", None, json.loads(data), base=None, force=True)
        elif target:
            p.store.write(target, rest.rsplit(".", 1)[0], json.loads(data), base=None, force=True)
        else:
            print(f"agora: not a file Agora keeps versions of: {a.file}", file=sys.stderr)
            return 2
        print(f"restored {a.file} from {a.restore} (the version it replaced is kept too)")
        return 0
    if a.file:
        for v in h.versions(a.file):
            print(f"{v['at']}  {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(v['at'] / 1000))}  {v['size']} bytes")
    else:
        for f in h.files():
            vs = h.versions(f)
            print(f"{f}  {len(vs)} versions, newest {time.strftime('%Y-%m-%d %H:%M', time.localtime(vs[0]['at'] / 1000))}")
    return 0


def add_parsers(sub) -> None:
    s = sub.add_parser("doctor", help="check this project's local state; --fix restores what can be restored")
    s.add_argument("--project", default=None)
    s.add_argument("--fix", action="store_true", help="restore records from the newest backup and bindings from the registry")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_doctor)
    s = sub.add_parser("backup", help="back up sessions/, trash/, local/ outside the project now")
    s.add_argument("--project", default=None)
    s.set_defaults(fn=cmd_backup)
    s = sub.add_parser("restore", help="put back files from a backup (missing ones only)")
    s.add_argument("--project", default=None)
    s.add_argument("--from", dest="source", default="latest", help="latest (default) or a backup's time in ms")
    s.add_argument("--overwrite", action="store_true")
    s.set_defaults(fn=cmd_restore)
    s = sub.add_parser("history", help="earlier versions of canvases / threads / workspace.json")
    s.add_argument("file", nargs="?", help="e.g. canvases/c1.excalidraw, threads/c1.json, workspace.json")
    s.add_argument("--restore", metavar="MS", help="write this version back")
    s.add_argument("--project", default=None)
    s.set_defaults(fn=cmd_history)
