"""``agora dev status`` and ``agora dev gc``: every Agora server on this machine, the code each runs, and clearing
the dead ones. The records are the ones ``serve`` writes under the machine state dir (``servers/<instance>.json``);
nothing else is kept, so there is no second list to fall out of step."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agora_cli.main import alive, health, is_serve, state_dir, stop

SHORT_SHA = 7


def _records() -> list[tuple[Path, dict[str, Any]]]:
    out = []
    for path in sorted((state_dir() / "servers").glob("*.json")):
        try:
            rec = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue  # unreadable: shown by neither command, never deleted
        if isinstance(rec, dict) and rec.get("pid") and rec.get("root"):
            out.append((path, rec))
    return out


def _row(rec: dict[str, Any]) -> dict[str, Any]:
    pid, port = rec["pid"], rec.get("port") or 0
    running = alive(pid)
    answering = running and (health(port) or {}).get("pid") == pid
    return {
        "root": rec["root"],
        "pid": pid,
        "port": port,
        "mode": rec.get("mode"),
        "startedAt": rec.get("startedAt"),
        "sha": rec.get("sha"),
        "dirty": bool(rec.get("dirty")),
        "alive": running,
        "answering": answering,
        "rootGone": not Path(rec["root"]).exists(),
    }


def instances() -> list[dict[str, Any]]:
    """Answering servers first, then the ones that run but do not answer, then the stopped."""
    return sorted((_row(rec) for _, rec in _records()), key=lambda r: (not r["answering"], not r["alive"], r["root"]))


def gc() -> list[dict[str, Any]]:
    """Clear what no longer serves, return the rows cleared. A record whose process is gone is removed with its lock.
    A server still running on a folder that is gone is stopped, once its command line says it is an Agora server for
    that folder. A running server that does not answer is left alone: ``agora down`` finds it through that record."""
    cleared = []
    for path, rec in _records():
        row = _row(rec)
        if row["alive"]:
            if not (row["rootGone"] and is_serve(rec["pid"], rec["root"])):
                continue
            stop(rec["pid"])
        path.unlink(missing_ok=True)
        path.with_suffix(".lock").unlink(missing_ok=True)
        cleared.append(row)
    return cleared


def _describe(row: dict[str, Any]) -> str:
    state = "answering" if row["answering"] else "not answering" if row["alive"] else "stopped"
    sha = (row["sha"] or "unknown")[:SHORT_SHA] + ("+dirty" if row["dirty"] else "")
    gone = "  (project folder is gone)" if row["rootGone"] else ""
    return f"{state:<13} {sha:<14} port {row['port']:<6} pid {row['pid']:<7} {row['root']}{gone}"


def cmd_status(_p, _a) -> int:
    rows = instances()
    for row in rows:
        print(_describe(row))
    if not rows:
        print("no Agora server records on this machine")
        return 0
    stopped = sum(not r["alive"] for r in rows)
    print(f"{sum(r['answering'] for r in rows)} answering, {len(rows) - stopped - sum(r['answering'] for r in rows)} not answering, {stopped} stopped" + ("  (`agora dev gc` clears the stopped)" if stopped else ""))
    return 0


def cmd_gc(_p, _a) -> int:
    cleared = gc()
    for row in cleared:
        print(f"cleared: {_describe(row)}")
    if not cleared:
        print("nothing to clear")
    return 0


def add_parsers(sub) -> None:
    dev = sub.add_parser("dev", help="every Agora server on this machine: status, gc").add_subparsers(dest="dev_cmd", required=True)
    for name, fn, help in (("status", cmd_status, "list the servers, the code (git SHA) each runs, and whether it answers"), ("gc", cmd_gc, "clear the records of servers that are gone")):
        dev.add_parser(name, help=help).set_defaults(fn=fn)
