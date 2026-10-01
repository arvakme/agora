"""``agora dev status`` and ``agora dev gc``: every Agora server on this machine, the code each runs, and clearing
the dead ones. The records are the ones ``serve`` writes under the machine state dir (``servers/<instance>.json``);
nothing else is kept, so there is no second list to fall out of step."""

from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import Any

from agora_cli.main import alive, health, state_dir

SHORT_SHA = 7


def _records() -> list[tuple[Path, dict[str, Any]]]:
    out = []
    for path in sorted((state_dir() / "servers").glob("*.json")):
        try:
            rec = json.loads(path.read_text())
        except (OSError, ValueError):  # ValueError: bad JSON or bytes that are not UTF-8
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
        "dirty": rec.get("dirty"),
        "alive": running,
        "answering": answering,
        "rootGone": not Path(rec["root"]).exists(),
    }


def instances() -> list[dict[str, Any]]:
    """Answering servers first, then the ones that run but do not answer, then the stopped."""
    return sorted((_row(rec) for _, rec in _records()), key=lambda r: (not r["answering"], not r["alive"], r["root"]))


def _unheld(lock: Path):
    """The instance lock, taken without waiting; None when a server holds it (it runs, or is starting: it takes the
    lock before it writes its record). Held while the record goes, so a starting server cannot be answered by a
    record that is about to be deleted. The lock file itself stays: it is what the next server of this instance locks."""
    try:
        fd = open(lock, "a+")
    except OSError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fd.close()
        return None
    return fd


def gc() -> list[dict[str, Any]]:
    """Remove the records of servers that are gone, return the rows removed. Nothing that runs is touched or stopped:
    a server that does not answer is for ``agora down`` (it finds it through that record), and one whose project
    folder is gone is shown by ``status`` for the person to stop."""
    cleared = []
    for path, rec in _records():
        row = _row(rec)
        if row["alive"]:
            continue
        held = _unheld(path.with_suffix(".lock"))
        if held is None:
            continue
        with held:
            path.unlink(missing_ok=True)
        cleared.append(row)
    return cleared


def _sha(row: dict[str, Any]) -> str:
    """The commit, with ``+dirty`` for uncommitted changes and ``+?`` when git could not say."""
    if not row["sha"]:
        return "unknown"
    return row["sha"][:SHORT_SHA] + {False: "", True: "+dirty", None: "+?"}[row["dirty"]]


def _describe(row: dict[str, Any]) -> str:
    state = "answering" if row["answering"] else "not answering" if row["alive"] else "stopped"
    gone = ""
    if row["rootGone"]:
        gone = f"  (project folder is gone; `kill {row['pid']}` to stop it)" if row["alive"] else "  (project folder is gone)"
    return f"{state:<13} {_sha(row):<14} port {row['port']:<6} pid {row['pid']:<7} {row['root']}{gone}"


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
