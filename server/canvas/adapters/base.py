"""The adapter contract: what "supporting a CLI" is made of, as separately implementable
capabilities. The registry (registry.py) derives a CLI's tier from which ones an adapter has:

- T1 (full session agent): everything T2 has, plus ``Headless``, ``Interactive``, ``Catalog``,
  ``Binding``. Only these can be picked for an Agora session.
- T2 (observed agent): ``Locator`` + ``Projector`` + ``ToolVocab`` (+ optional ``Subagents``):
  trajectory, pointer, workstation figure — read-only.
- T3 (receipts only): a ``ReceiptSource`` (Seedmux tickets) knows it ran, where, and what it said.
- T0 (inferred): nothing but file events in a directory (not implemented yet).

Design: web/docs/cli-adapters.md. Capabilities are checked with ``isinstance(a, Locator)`` etc.
(runtime-checkable protocols: the check is "has these members").
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable

Tier = Literal["T1", "T2", "T3", "T0"]
TIERS: tuple[Tier, ...] = ("T1", "T2", "T3", "T0")
Via = Literal["native", "seedmux", "inferred"]

# Tool activity vocabulary shared with the page (web/src/session/trajectoryModel.ts `Activity`).
ACTIVITIES = ("read", "search", "write", "edit", "commands", "webFetch", "webSearch", "subagents", "plan", "questions", "tools")


def lower_tier(t: Tier) -> Tier:
    """One step down: T1 → T2 → T3 → T0 (T0 stays)."""
    i = TIERS.index(t)
    return TIERS[min(i + 1, len(TIERS) - 1)]


# ——— versions ———
_NUM = re.compile(r"\d+(?:\.\d+)*")


def parse_version(s: str | None) -> tuple[int, ...] | None:
    """The first dotted number in ``s`` ("codex-cli 0.157.1" → (0, 157, 1)); None if there is none."""
    m = _NUM.search(s or "")
    return tuple(int(x) for x in m.group(0).split(".")) if m else None


@dataclass(frozen=True)
class VersionRange:
    """``">=0.153,<0.158"``: comma-separated bounds on the dotted version; empty = anything."""

    spec: str

    def contains(self, version: str | None) -> bool | None:
        """True / False, or None when the version is not known."""
        v = parse_version(version)
        if v is None:
            return None
        for part in (p.strip() for p in self.spec.split(",") if p.strip()):
            m = re.match(r"(>=|<=|==|<|>)\s*(.+)", part)
            if not m:
                continue
            op, bound = m.group(1), parse_version(m.group(2)) or ()
            n = max(len(v), len(bound))
            a, b = v + (0,) * (n - len(v)), bound + (0,) * (n - len(bound))
            ok = {">=": a >= b, "<=": a <= b, "==": a == b, "<": a < b, ">": a > b}[op]
            if not ok:
                return False
        return True

    def label(self) -> str:
        lo = re.search(r">=\s*([\d.]+)", self.spec)
        hi = re.search(r"<\s*([\d.]+)", self.spec)
        if lo and hi:
            return f"{lo.group(1)}–<{hi.group(1)}"
        return self.spec or "任意"


# ——— references and links ———
@dataclass(frozen=True)
class ParentLink:
    """Why a run is taken to be another run's child, strongest evidence first:
    ``native`` (the CLI wrote the link), ``seedmux`` (a dispatch record), ``inferred``."""

    via: Via
    parent_run: str | None = None  # AgentRun id of the parent
    tool_call_id: str | None = None  # the parent's tool call that dispatched it
    task_id: str | None = None  # Seedmux T-xx
    evidence: str = ""


@dataclass(frozen=True)
class NativeRef:
    """One native session's address (never a credential)."""

    kind: str
    native_id: str
    path: Path | None = None  # its log file (or folder / database)
    cwd: str | None = None  # the working directory the CLI recorded
    parent: ParentLink | None = None
    label: str = ""  # nickname / description when the CLI gives one
    meta: dict[str, Any] = field(default_factory=dict, hash=False, compare=False)

    @property
    def run_id(self) -> str:
        return f"{self.kind}:{self.native_id}"


def tool_facts(activity: str, *, files: list[dict[str, str]] | None = None, reads: list[str] | None = None, waits_user: bool = False, spawn: dict[str, Any] | None = None) -> dict[str, Any]:
    """What the page needs to know about one tool call, without knowing tool names: its
    ``activity``, the files it ``reads``, whether it ``waitsUser``, and whether it ``spawn``s an
    agent (``{childKind?, childId?, taskId?, pane?}``). ``files`` (writes) are reported separately
    on the tool item, as before."""
    out: dict[str, Any] = {"activity": activity}
    if reads:
        out["reads"] = reads
    if waits_user:
        out["waitsUser"] = True
    if spawn:
        out["spawn"] = spawn
    if files:
        out["files"] = files
    return out


# ——— capabilities ———
@runtime_checkable
class Locator(Protocol):
    """T2: where a native session's log is."""

    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> Any: ...

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]: ...


@runtime_checkable
class Projector(Protocol):
    """T2: one log record → transcript item upserts + turn changes (transcript.py's shape)."""

    known_types: frozenset[str]

    def project(self, rec: dict[str, Any], st: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]: ...

    def record_type(self, rec: dict[str, Any]) -> str | None: ...


@runtime_checkable
class ToolVocab(Protocol):
    """T2: tool name + input → ``tool_facts`` (the page no longer knows tool names)."""

    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]: ...


@runtime_checkable
class Subagents(Protocol):
    """T2 optional: the native sub-agents a session started."""

    def children(self, ref: NativeRef, home: Path | None = None) -> list[NativeRef]: ...


@runtime_checkable
class Headless(Protocol):
    """T1: one turn without a terminal (the CLI's print / exec mode)."""

    assigns_id: Literal["agora", "cli"]
    can_fork_headless: bool

    def headless_args(self, cmd: list[str], req: Any, *, log_exists: bool = False) -> list[str]: ...


@runtime_checkable
class Interactive(Protocol):
    """T1: the terminal command that continues (or starts, or forks) a native session."""

    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: bool = False) -> list[str]: ...


@runtime_checkable
class Catalog(Protocol):
    """T1: the models and effort levels the CLI offers (agent_models.py's shape)."""

    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]: ...


@runtime_checkable
class Binding(Protocol):
    """T1: whether a native id survives the project moving, and how to carry it along if not."""

    survives_move: bool


class Adapter:
    """Metadata every adapter has. Capabilities are the methods above, implemented or not."""

    kind: str = ""
    name: str = ""
    binaries: tuple[str, ...] = ()
    tested: VersionRange = VersionRange("")
    max_tier: Tier = "T2"
    seedmux_names: tuple[str, ...] = ()  # how Seedmux's meta.json `agent` names this CLI
    log_hint: str = ""  # where its logs are, for people (AllDocs, doctor)
    delete_hint: str = ""  # how to delete a native session by hand (trash)
    icon: str = ""  # mark name the page draws (web/src/session/AgentAvatar.tsx)
    # Days after which the CLI deletes an untouched session log itself (Claude: 30); None = never.
    prunes_logs_after_days: int | None = None

    def installed(self) -> str | None:
        """Path of the first binary on PATH."""
        for b in self.binaries:
            p = shutil.which(b)
            if p:
                return p
        return None

    def version(self, env: dict[str, str] | None = None, timeout: float = 10) -> str | None:
        """``<binary> --version``, the first dotted number in it; None when not installed or unreadable."""
        exe = self.installed()
        if not exe:
            return None
        try:
            r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=timeout, env=env)
        except (OSError, subprocess.SubprocessError):
            return None
        v = parse_version(r.stdout or r.stderr)
        return ".".join(map(str, v)) if v else None

    def log_format(self, path: Path) -> str | None:
        """The log's own format version, when it records one (Pi header ``version``…)."""
        return None
