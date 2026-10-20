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

from server.i18n import lang, tr

STALE_DAYS = 20


def _claude_cleanup_set() -> bool:
    try:
        return "cleanupPeriodDays" in json.loads((Path.home() / ".claude" / "settings.json").read_text())
    except (OSError, ValueError):
        return False


def diagnose(p, *, fix: bool = False) -> list[dict[str, Any]]:
    """Findings: {level: ok|info|warn|error, what, message, fix?: str, fixed?: bool}."""
    from server.canvas import adapters, agents
    from server.canvas.backup import Backups
    from server.canvas.local import session_origins
    from server.canvas.trash import Trash

    out: list[dict[str, Any]] = []

    def say(level: str, what: str, message: str, **kw: Any) -> None:
        out.append({"level": level, "what": what, "message": message, **kw})

    store, local = p.store, p.local
    if not store.exists():
        say("error", "project", tr(f"{store.dir} 不存在：这里还不是 Agora 项目（`agora init` 或 `agora up`）", f"{store.dir} does not exist: this is not an Agora project yet (`agora init` or `agora up`)"))
        return out
    if lang() == "en":
        labels = {"moved": "The project moved here from {}", "copied": "This is a copy of {}", "fresh": "A new clone / another machine / local records cleared", "reattached": "Local records were lost and recovered from the registry", "upgraded": "A project from an older version, upgraded in place"}
    else:
        labels = {"moved": "项目从 {} 移过来", "copied": "这是 {} 的副本", "fresh": "新 clone / 换机器 / 本机记录被清掉", "reattached": "本机记录丢过，按注册表认回", "upgraded": "旧版本的项目，原地升级"}
    once = tr("（页面会提示一次）", " (the page will mention it once)")
    if fix:
        p.reconcile()
        kind = (local.change() or {}).get("kind")
        if kind:
            say("info", "instance", labels.get(kind, kind).format(local.change().get("from")) + once)
    else:
        # Without --fix nothing is written: say what `agora up` / --fix would settle, act as that instance.
        seen = local.classify()
        local.peek()
        if seen["kind"] not in ("same", "new"):
            say("warn" if seen["kind"] in ("moved", "copied") else "info", "instance", labels.get(seen["kind"], seen["kind"]).format(seen.get("from")) + tr("：还没对账，`agora up` 或 `agora doctor --fix` 处理", ": not reconciled yet; `agora up` or `agora doctor --fix` settles it"), fix="reconcile")
        else:
            kind = (local.change() or {}).get("kind")
            if kind:
                say("info", "instance", labels.get(kind, kind).format(local.change().get("from")) + once)
    say("ok", "instance", tr(f"实例 {(local.instance_id() or '（未建）')[:8]} · {store.root}", f"Instance {(local.instance_id() or '(none yet)')[:8]} · {store.root}"))

    # p.live() writes run/server.json back when it is missing: only with --fix.
    st = p.live() if fix else next((x for x in (p.state(), p.registered()) if p.answering(x)), None)
    say("ok" if st else "info", "server", tr(f"服务在跑：{st['url']}（pid {st['pid']}）", f"Server running: {st['url']} (pid {st['pid']})") if st else tr("服务没在跑（`agora up`）", "Server not running (`agora up`)"))

    ws = store.read_workspace_quiet() or {}
    docs = [d for d in ws.get("docs") or [] if isinstance(d, dict)]
    backups = Backups(store, local)
    # ——— records and bindings (git clean -fdx, a fresh clone) ———
    listed = [d for d in docs if d.get("kind") == "session" and isinstance(d.get("sessionId"), str)]
    in_trash = {m["id"] for m in Trash(store).list() if m["kind"] == "session"}
    # Only this copy's own sessions come back from a backup: not one in the trash, not one that is
    # listed here but belongs to another copy (its native session is that copy's).
    origins = session_origins(store, local)
    no_record = [d["sessionId"] for d in listed if not (store.dir / "sessions" / f"{d['sessionId']}.jsonl").exists() and d["sessionId"] not in in_trash and (origins.get(d["sessionId"]) or {}).get("state") not in ("other-copy", "foreign")]
    if no_record:
        have = backups.list()
        if fix and have:
            got = backups.restore(sessions=set(no_record))
            say("info", "records", tr(f"从备份 {time.strftime('%Y-%m-%d %H:%M', time.localtime(have[0]['at'] / 1000))} 放回了 {len(got)} 个文件（只放回这几个会话缺的）", f"Put back {len(got)} files from the {time.strftime('%Y-%m-%d %H:%M', time.localtime(have[0]['at'] / 1000))} backup (only what these sessions were missing)"), fixed=True)
            no_record = [s for s in no_record if not (store.dir / "sessions" / f"{s}.jsonl").exists()]
            origins = session_origins(store, local)
        if no_record:
            level = "warn" if have else "info"
            say(level, "records", tr(f"{len(no_record)} 个会话没有改图记录（sessions/<id>.jsonl）", f"{len(no_record)} sessions have no edit record (sessions/<id>.jsonl)") + (tr("：最新的备份里有，`agora doctor --fix` 放回", ": the latest backup has them; `agora doctor --fix` puts them back") if have and not fix else tr("：备份里也没有（改图记录只在本机）", ": not in the backups either (edit records live only on this machine)")), sessions=no_record, fix="restore-backup" if have else None)
    bindings = store.bindings()
    recoverable = [sid for sid, o in origins.items() if o["state"] == "recoverable"]
    if recoverable and fix:
        for sid in recoverable:
            e = origins[sid]
            store.bind(sid, agent=e["agent"], model=e.get("model") or "", effort=e.get("effort") or "", native_id=e.get("nativeId"), at=int(time.time() * 1000), started=e.get("started") if e.get("started") is not None else bool(e.get("nativeId")))
            local.note("import", sessionId=sid, agent=e["agent"], model=e.get("model"), nativeId=e.get("nativeId"), reason="doctor")
        say("info", "bindings", tr(f"从本机注册表恢复了 {len(recoverable)} 个会话的绑定", f"Restored the bindings of {len(recoverable)} sessions from this machine's registry"), sessions=recoverable, fixed=True)
        bindings = store.bindings()
    elif recoverable:
        gone = not (store.dir / "sessions").exists() or not any((store.dir / "sessions").glob("*.agent.json"))
        say("warn", "bindings", (tr("看起来 .agora/sessions/ 被删了（git clean -x？）。", ".agora/sessions/ looks deleted (git clean -x?). ") if gone else "") + tr(f"本机注册表里有 {len(recoverable)} 个会话的绑定，`agora doctor --fix` 恢复", f"This machine's registry has bindings for {len(recoverable)} sessions; `agora doctor --fix` restores them"), sessions=recoverable, fix="restore-bindings")
    others = sorted(sid for sid, o in origins.items() if o["state"] == "other-copy")
    if others:
        say("info", "bindings", tr(f"{len(others)} 个会话属于本机的另一份副本（{origins[others[0]].get('root')}）：不在这里绑定；要在这里接着用，在页面上「在这里分叉继续」", f"{len(others)} sessions belong to another copy on this machine ({origins[others[0]].get('root')}): not bound here; to keep using them here, choose “Fork here and continue” on the page"), sessions=others)
    foreign = sorted(sid for sid, o in origins.items() if o["state"] == "foreign")
    if foreign:
        say("info", "bindings", tr(f"{len(foreign)} 个会话是在别的机器或别的位置建的（本机没有它们的记录）：页面上显示只读卡片", f"{len(foreign)} sessions were made on another machine or in another place (no record of them here): the page shows them as read-only cards"), sessions=foreign)

    # ——— native logs ———
    now = time.time()
    stale = []
    for sid, b in sorted(bindings.items()):
        if not b.get("nativeId") or b.get("pendingFork"):
            continue
        look = agents.locate_log(b["agent"], b["nativeId"], store.root, hint=(b.get("log") or {}).get("path"))
        if look.state != "found":
            if b.get("started", True):
                say("warn", "native", tr(f"{sid}：", f"{sid}: ") + agents.native_problem(b["agent"], b["nativeId"], look), session=sid, candidates=[str(c) for c in look.candidates])
            continue
        if getattr(adapters.get(b["agent"]), "prunes_logs_after_days", None) and look.path is not None:
            idle = (now - look.path.stat().st_mtime) / 86400
            if idle >= STALE_DAYS:
                stale.append((sid, int(idle)))
    if stale and not _claude_cleanup_set():
        say("warn", "claude-cleanup", tr(f"{len(stale)} 个 Claude Code 会话超过 {STALE_DAYS} 天没有活动（{', '.join(f'{s} {d} 天' for s, d in stale)}）。Claude Code 默认 30 天后删除会话记录；要保留，在 ~/.claude/settings.json 里设 cleanupPeriodDays。Agora 已为这些会话保存轨迹快照。", f"{len(stale)} Claude Code sessions have been idle for over {STALE_DAYS} days ({', '.join(f'{s} {d} d' for s, d in stale)}). Claude Code deletes session records after 30 days by default; to keep them, set cleanupPeriodDays in ~/.claude/settings.json. Agora has saved trajectory snapshots of these sessions."), sessions=[s for s, _ in stale])
    # agora skill links (.claude/skills, .agents/skills) are ignored files: git clean removes them too.
    want = sorted({b["agent"] for b in bindings.values() if b.get("agent") in agents.SKILL_DIRS})
    unlinked = [k for k in want if not (store.root / agents.SKILL_DIRS[k] / agents.SKILL_NAME).exists()]
    if unlinked and fix:
        agents.install_skill(store.root, unlinked)
        say("info", "skill", tr(f"重新链接了 agora skill（{', '.join(agents.NAMES[k] for k in unlinked)}）", f"Relinked the agora skill ({', '.join(agents.NAMES[k] for k in unlinked)})"), fixed=True)
    elif unlinked:
        say("warn", "skill", tr(f"{', '.join(agents.NAMES[k] for k in unlinked)} 的 agora skill 链接不在了（git clean？）：终端里的 agent 读不到它；`agora doctor --fix` 或 `agora skill install` 重新链接", f"The agora skill link for {', '.join(agents.NAMES[k] for k in unlinked)} is gone (git clean?): agents in the terminal can't read it; `agora doctor --fix` or `agora skill install` relinks it"), fix="skill")
    copies = local.copies()
    if copies:
        say("info", "copies", tr(f"{len(copies)} 个会话是从 {next(iter(copies.values())).get('from')} 复制来的，在这里只读，可以在页面上分叉继续", f"{len(copies)} sessions were copied from {next(iter(copies.values())).get('from')}: read-only here; fork them on the page to continue"), sessions=sorted(copies))

    # ——— canvases ———
    listed_canvases = {d["id"] for d in docs if d.get("kind") == "canvas" and d.get("id")}
    files = {q.name.removesuffix(".excalidraw") for q in (store.dir / "canvases").glob("*.excalidraw")}
    if listed_canvases - files:
        say("warn", "canvases", tr(f"清单里有、文件不在的画布：{', '.join(sorted(listed_canvases - files))}（git 里找得回来，或者在回收站）", f"Canvases listed but without a file: {', '.join(sorted(listed_canvases - files))} (recoverable from git, or in the trash)"))
    if files - listed_canvases and docs:
        say("warn", "canvases", tr(f"有文件、清单里没有的画布：{', '.join(sorted(files - listed_canvases))}", f"Canvas files not in the list: {', '.join(sorted(files - listed_canvases))}"))
    if not ws and files:
        say("warn", "canvases", tr("workspace.json 缺失或读不了：打开页面会按磁盘上的画布恢复列表", "workspace.json is missing or unreadable: opening the page rebuilds the list from the canvases on disk"))

    tracked = Trash(store).committed()
    if tracked:
        say("warn", "trash", tr(f".agora/trash 里有 {len(tracked)} 项被 git 跟踪（回收站只该在本机）：Agora 不列出也不恢复它们；用 `git rm -r --cached .agora/trash` 移出 git", f"{len(tracked)} items in .agora/trash are tracked by git (the trash should stay on this machine): Agora neither lists nor restores them; take them out of git with `git rm -r --cached .agora/trash`"))
    items = Trash(store).list()
    if items:
        soon = [m for m in items if m["daysLeft"] <= 3]
        say("info", "trash", tr(f"回收站里有 {len(items)} 项" + (f"，{len(soon)} 项 3 天内清除" if soon else ""), f"{len(items)} items in the trash" + (f", {len(soon)} purged within 3 days" if soon else "")))

    # ——— leftovers and backups ———
    sockets = [s for s in local.legacy_sockets() if s != local.socket() and _tmux_alive(s)]
    if sockets:
        say("warn", "tmux", tr(f"旧名字下还有 tmux 服务器在跑：{', '.join(sockets)}（`agora down` 会关掉）", f"tmux servers still running under old names: {', '.join(sockets)} (`agora down` closes them)"))
    last = backups.list()
    if fix and backups.due() and local.instance_id():
        made = backups.make(force=True)
        if made:
            say("info", "backup", tr(f"做了一次备份：{made['path']}", f"Made a backup: {made['path']}"), fixed=True)
            last = backups.list()
    if last:
        age = (time.time() * 1000 - last[0]["at"]) / 3600000
        say("ok" if age < 48 else "warn", "backup", tr(f"最近一次本机备份 {age:.0f} 小时前（{len(last)} 份，{backups.dir}）", f"Last local backup {age:.0f} h ago ({len(last)} kept, {backups.dir})"))
    elif not fix:
        say("warn", "backup", tr("还没有本机备份（`agora backup` 或 `agora doctor --fix`）", "No local backup yet (`agora backup` or `agora doctor --fix`)"), fix="backup")
    return out


def _tmux_alive(socket: str) -> bool:
    try:
        return subprocess.run(["tmux", "-L", socket, "list-sessions"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _mark(level: str) -> str:
    """The column before a finding's words (both languages are the same width on a terminal)."""
    return {"ok": "  ok ", "info": "  ·  ", "warn": tr("注意 ", "warn "), "error": tr("问题 ", "error")}[level]


def cmd_doctor_agents(p, a) -> int:
    """``agora doctor --agents``: every CLI Agora has an adapter for — installed version against the
    tested range, log format, record types its adapter does not know (drift), tier. Read-only;
    ``--record <kind>`` re-records that CLI's fixture in /tmp (a real, cheap model run)."""
    from server.canvas.adapters import drift

    if a.record:
        import subprocess as sp

        from server.paths import CHECKOUT, ROOT

        if not CHECKOUT:
            print("agora: --record re-records a fixture in the agora repo and needs a checkout of it; this copy is installed", file=sys.stderr)
            return 2
        script = ROOT / "scripts" / "record_agent_fixture.py"
        if not script.exists():
            print(f"agora: {script} is missing", file=sys.stderr)
            return 2
        return sp.call([sys.executable, str(script), a.record])
    rows = drift.probe_all(root=p.root if p else None)
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print(drift.table(rows))
    return doctor_agents_exit(rows)


def doctor_agents_exit(rows: list[dict[str, Any]]) -> int:
    """``agora doctor --agents`` exit code: 1 only when an installed CLI would be degraded (version
    outside the tested range, or unknown records above the threshold) and the project has not
    trusted it (``.agora/agents.toml`` ``trust_untested``); 0 otherwise — unknown records below the
    threshold are only noted in the output (review P2-3)."""
    return 1 if any(r["installed"] and r["degraded"] and not r["degraded"].get("trusted") for r in rows) else 0


def cmd_doctor(p, a) -> int:
    if getattr(a, "agents", False) or getattr(a, "record", None):
        return cmd_doctor_agents(p, a)
    findings = diagnose(p, fix=a.fix)
    if a.json:
        print(json.dumps(findings, ensure_ascii=False, indent=2))
    else:
        for f in findings:
            print(f"{_mark(f['level'])}{f['message']}{tr('（已修复）', ' (fixed)') if f.get('fixed') else ''}")
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
        if a.file != "workspace.json" and not target:
            print(f"agora: not a file Agora keeps versions of: {a.file}", file=sys.stderr)
            return 2
        current = p.store.dir / a.file
        if current.exists():
            h.keep(a.file, current.read_bytes(), force=True)  # what is replaced now is kept, whatever the 10-minute rule says
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
            print(f"{v['at']}  {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(v['at'] / 1000))}  {v['size']} bytes  (what the file held before a write at that time)")
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
    s.add_argument("--agents", action="store_true", help="the coding-agent CLIs: versions vs. tested range, unknown log records (drift), tiers")
    s.add_argument("--record", metavar="KIND", default=None, help="with --agents: re-record KIND's fixture in /tmp with its cheapest model (spends a few cents)")
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
