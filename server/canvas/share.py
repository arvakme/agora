"""Sharing a canvas: a link on the owner's public domain that lets anyone who has it look at one
canvas and comment on it, for as long as the owner chose. Design: web/docs/sharing.md.

- A share is a record in ``.agora/shares/shares.json`` (ignored by git): canvas, hostname,
  sha256 of the token (the token itself is shown once and never stored), expiry, visit count,
  and the ids of the Cloudflare resources it uses (DNS record, tunnel) so cleanup is by id.
- Each share gets its own first-level hostname ``<project>-<random>.<domain>`` (a proxied CNAME
  to this project's named tunnel), so the universal certificate covers it and revoking it
  removes the name itself, not only the token.
- One ``cloudflared`` connector per project runs while at least one share is active; its only
  ingress is the local share gateway (share_gateway.py), never the owner's app.
- Ending a share (revoke or expiry) invalidates the token at once, deletes its DNS record, and
  when no share is left stops the connector and deletes the tunnel and its credentials.

Cloudflare is reached through two small providers (``DnsProvider``, ``TunnelProvider``) so the
lifecycle is tested with fakes; the real ones live in cloudflare.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from server.canvas import nested
from server.canvas.project import ID_RE, ProjectStore, dump_json

SHARES_DIR = "shares"
DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$")
UNITS = {"s": 1, "m": 60, "min": 60, "h": 3600, "d": 86400, "w": 7 * 86400}
FOREVER = ("forever", "never", "manual", "0")
MAX_TTL_S = 90 * 86400
MIN_TTL_S = 60
MAX_OPENS = 10000
READY_TIMEOUT_S = 45.0
MAX_TEXT = 4000
MAX_NAME = 40


def parse_duration(text: str | None) -> int | None:
    """``10m`` / ``2h`` / ``1d`` / ``7d`` → seconds; ``forever`` (until revoked) → None."""
    t = (text or "").strip().lower()
    if t in FOREVER:
        return None
    m = DURATION_RE.match(t)
    if not m:
        raise ValueError(f"duration must look like 10m, 2h, 1d, 7d or forever, got {text!r}")
    secs = int(float(m.group(1)) * UNITS[m.group(2)])
    return check_ttl(secs)


def check_ttl(secs: int | None) -> int | None:
    if secs is None:
        return None
    if secs < MIN_TTL_S or secs > MAX_TTL_S:
        raise ValueError(f"duration must be between 1 minute and 90 days, got {secs}s")
    return int(secs)


def check_max_opens(n: int | None) -> int | None:
    if n is None:
        return None
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_OPENS:
        raise ValueError(f"max opens must be a whole number from 1 to {MAX_OPENS}, got {n!r}")
    return n


def guest_key(guest_id: str) -> str:
    return hashlib.sha256(f"agora-guest:{guest_id}".encode()).hexdigest()[:24]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def slug(name: str, n: int = 20) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:n].strip("-")
    return s or "agora"


# ——— providers ———
class DnsProvider(Protocol):
    def zone_name(self) -> str: ...
    def create_cname(self, name: str, target: str, comment: str) -> str: ...
    def delete(self, record_id: str) -> None: ...
    def exists(self, record_id: str) -> bool: ...


class TunnelProcess(Protocol):
    pid: int

    def alive(self) -> bool: ...
    def wait_ready(self, timeout: float) -> bool: ...
    def stop(self) -> None: ...


class TunnelProvider(Protocol):
    def find(self, name: str) -> str | None: ...
    def create(self, name: str, credentials: Path) -> str: ...
    def delete(self, tunnel_id: str) -> None: ...
    def start(self, tunnel_id: str, credentials: Path, config: Path, log: Path) -> TunnelProcess: ...


# ——— records ———
@dataclass
class Share:
    id: str
    canvasId: str
    host: str
    tokenHash: str
    createdAt: int
    expiresAt: int | None
    canvasTitle: str = ""
    endedAt: int | None = None
    endReason: str | None = None  # revoked | expired
    visits: int = 0
    lastVisitAt: int | None = None
    guests: int = 0
    comments: int = 0
    dnsRecordId: str | None = None
    tunnelId: str | None = None
    cleanup: list[str] = field(default_factory=list)  # what is still left to remove after it ended
    # Opening limit: None = unlimited. ``opens`` counts distinct guests (guest-id cookies) that
    # entered through /s/<token>; ``admitted`` holds their hashed ids so a returning guest (same
    # browser) is not counted again, and so that once the limit is reached only they get in.
    maxOpens: int | None = None
    opens: int = 0
    admitted: list[str] = field(default_factory=list)
    quick: bool = False  # an account-less trycloudflare.com address; ends with its ``cf`` process

    def active(self, now_ms: int) -> bool:
        return self.endedAt is None and (self.expiresAt is None or now_ms < self.expiresAt)

    def public(self, now_ms: int) -> dict[str, Any]:
        """What the owner's page and ``agora share list`` see (no hash)."""
        d = {k: v for k, v in asdict(self).items() if k not in ("tokenHash", "admitted")}
        d["status"] = "active" if self.active(now_ms) else (self.endReason or "expired")
        d["url"] = f"https://{self.host}/"
        d["remainingMs"] = None if self.expiresAt is None or not self.active(now_ms) else self.expiresAt - now_ms
        return d


class ShareFile:
    """``.agora/shares/shares.json`` behind the project's write lock. The directory carries its own
    ``.gitignore`` (``*``) so the records stay out of git even in projects whose ``.agora/.gitignore``
    predates sharing."""

    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self.dir = store.dir / SHARES_DIR
        self.path = self.dir / "shares.json"

    def _ensure(self) -> None:
        self.store.check_alive()  # a moved project gets no new .agora/ at its old path
        self.dir.mkdir(exist_ok=True)
        gi = self.dir / ".gitignore"
        if not gi.exists():
            gi.write_text("# Share records (hashes, hostnames, Cloudflare ids): local only.\n*\n")

    def load(self) -> list[Share]:
        try:
            raw = json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return []
        fields = set(Share.__dataclass_fields__)
        return [Share(**{k: v for k, v in r.items() if k in fields}) for r in raw.get("shares", [])]

    def save(self, shares: list[Share]) -> None:
        self._ensure()
        with self.store._locked():
            self.store._atomic(self.path, dump_json({"format": 1, "shares": [asdict(s) for s in shares]}))


# ——— rate limiting ———
class RateLimiter:
    """Token buckets keyed by (kind, key): ``rate`` requests per ``per`` seconds, bursting to ``rate``."""

    def __init__(self, limits: dict[str, tuple[int, float]], clock: Callable[[], float] = time.monotonic) -> None:
        self.limits = limits
        self.clock = clock
        self.buckets: dict[tuple[str, str], tuple[float, float]] = {}
        self.lock = threading.Lock()

    def allow(self, kind: str, key: str) -> bool:
        rate, per = self.limits[kind]
        now = self.clock()
        with self.lock:
            tokens, at = self.buckets.get((kind, key), (float(rate), now))
            tokens = min(float(rate), tokens + (now - at) * rate / per)
            if tokens < 1:
                self.buckets[(kind, key)] = (tokens, now)
                return False
            self.buckets[(kind, key)] = (tokens - 1, now)
            if len(self.buckets) > 20000:  # forget idle keys
                self.buckets = {k: v for k, v in self.buckets.items() if now - v[1] < 600}
            return True


# ——— what a guest may see ———
def guest_person(p: dict[str, Any] | None) -> dict[str, Any] | None:
    """Guests keep their ids; everyone else (``mailto:…`` of the owner) becomes an opaque id."""
    if not isinstance(p, dict):
        return None
    pid = str(p.get("id") or "")
    if not pid.startswith("guest:"):
        pid = "member:" + hashlib.sha256(pid.encode()).hexdigest()[:10]
    return {"id": pid, "name": str(p.get("name") or "")[:60]}


def guest_threads(file: dict[str, Any] | None) -> dict[str, Any]:
    """The threads file without session links, turn ids or anyone's email."""
    out = []
    for t in (file or {}).get("threads") or []:
        msgs = []
        for m in t.get("messages") or []:
            gm = {k: m[k] for k in ("id", "author", "text", "at", "tone", "editedAt", "updatedAt", "deleted") if k in m}
            if m.get("by"):
                gm["by"] = guest_person(m["by"])
            msgs.append(gm)
        gt = {k: t[k] for k in ("id", "n", "anchor", "resolved", "createdAt", "updatedAt", "deleted") if k in t}
        if t.get("createdBy"):
            gt["createdBy"] = guest_person(t["createdBy"])
        gt["messages"] = msgs
        gt["participants"] = [x for x in (guest_person(p) for p in t.get("participants") or []) if x]
        out.append(gt)
    return {"seq": (file or {}).get("seq", 0), "threads": out}


def guest_elements(elements: list[dict[str, Any]], children: set[str] | frozenset[str] = frozenset()) -> list[dict[str, Any]]:
    """Scene elements without ``customData`` (code paths of the progress pointer, animation metadata).
    A node that opens a child canvas the share reaches keeps only that link (``childCanvas``), so a
    guest can step into it; links to canvases outside the share are dropped."""
    out = []
    for e in elements:
        if e.get("isDeleted"):
            continue
        g = {k: v for k, v in e.items() if k != "customData"}
        child = ((e.get("customData") or {}).get("childCanvas"))
        if isinstance(child, str) and child in children:
            g["customData"] = {"childCanvas": child}
        out.append(g)
    return out


def finite(v: Any, lo: float = -1e7, hi: float = 1e7) -> float:
    if not isinstance(v, int | float) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError("bad number")
    return float(v)


def clean_anchor(a: Any, element_ids: set[str]) -> dict[str, Any]:
    if not isinstance(a, dict):
        raise ValueError("anchor must be an object")
    ids = a.get("ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 8 or not all(isinstance(i, str) and i in element_ids for i in ids):
        raise ValueError("anchor must name elements on this canvas")
    rel, last = a.get("rel") or {}, a.get("last") or {}
    return {
        "ids": ids,
        "rel": {"x": finite(rel.get("x"), 0, 1), "y": finite(rel.get("y"), 0, 1)},
        "last": {"x": finite(last.get("x")), "y": finite(last.get("y"))},
    }


def clean_text(v: Any, n: int, what: str) -> str:
    if not isinstance(v, str) or not v.strip():
        raise ValueError(f"{what} is required")
    v = v.strip()
    if len(v) > n:
        raise ValueError(f"{what} is longer than {n} characters")
    return v


def canvas_titles(store: ProjectStore) -> dict[str, str]:
    ws = store.read("workspace")
    return {str(d["id"]): str(d.get("title") or "") for d in ((ws or ({}, ""))[0] or {}).get("docs") or [] if isinstance(d, dict) and d.get("kind", "canvas") == "canvas" and d.get("id")}


def guest_canvas(store: ProjectStore, cid: str, allowed: set[str]) -> dict[str, Any]:
    """One canvas as a guest (or a bundle) sees it: elements and comments, sanitized. The only
    place that decides what leaves the project."""
    scene = store.read("canvas", cid)
    threads = store.read("threads", cid)
    return {"elements": guest_elements((scene or ({}, ""))[0].get("elements") or [], allowed), "threads": guest_threads(threads[0] if threads else None)}


# ——— bundles: a share as a file (web/docs/sharing.md §9) ———
BUNDLE_FORMAT = "agora-share-bundle"
BUNDLE_VERSION = 1
MAX_BUNDLE_BYTES = 20 * 1024 * 1024
MAX_BUNDLE_CANVASES = 200
MAX_CANVAS_ELEMENTS = 20000
MAX_BUNDLE_ELEMENTS = 50000
MAX_CANVAS_THREADS = 2000
MAX_THREAD_MESSAGES = 200
MAX_TITLE = 120
# Drawing primitives only: embeddables, iframes and images pull in outside content.
IMPORT_ELEMENT_TYPES = frozenset({"rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame", "magicframe"})


class BundleError(ValueError):
    """A bundle that cannot leave (unknown canvas) or must not come in (malformed, too big)."""


def export_bundle(store: ProjectStore, root: str, title: str = "") -> dict[str, Any]:
    """The canvas ``root`` and every canvas below it, as a guest would see them, plus a manifest."""
    if store.read("canvas", root) is None:
        raise BundleError(f"no canvas {root!r} in this project")
    allowed = nested.reachable(store, root)
    titles = canvas_titles(store)
    canvases = {cid: {"title": titles.get(cid) or (title if cid == root else ""), **guest_canvas(store, cid, allowed)} for cid in sorted(allowed) if store.read("canvas", cid) is not None}
    name = store.config().get("project", {}).get("name") or store.root.name
    return {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "manifest": {"project": str(name), "root": root, "title": canvases[root]["title"], "createdAt": int(time.time() * 1000)},
        "canvases": canvases,
    }


def _imported_person(p: Any) -> dict[str, str]:
    """Imported authors keep their names but never an id that could match a live guest or member."""
    p = p if isinstance(p, dict) else {}
    return {"id": "imported:" + hashlib.sha256(str(p.get("id") or "").encode()).hexdigest()[:10], "name": str(p.get("name") or "")[:60]}


def _import_element(e: Any, kids: dict[str, str]) -> dict[str, Any] | None:
    if not isinstance(e, dict):
        raise BundleError("an element is not an object")
    eid = e.get("id")
    if not isinstance(eid, str) or not ID_RE.match(eid) or len(eid) > 64:
        raise BundleError("an element has no valid id")
    if e.get("isDeleted") or e.get("type") not in IMPORT_ELEMENT_TYPES:
        return None
    try:
        for k in ("x", "y"):
            finite(e.get(k), -1e9, 1e9)
        for k in ("width", "height", "angle", "opacity", "strokeWidth", "fontSize"):
            if k in e:
                finite(e[k], -1e9, 1e9)
    except ValueError:
        raise BundleError(f"element {eid!r} has a number that is not finite") from None
    out = {k: v for k, v in e.items() if k not in ("customData", "link")}
    link = e.get("link")
    if isinstance(link, str) and re.match(r"^https?://", link, re.I) and len(link) <= 2000:
        out["link"] = link
    child = (e.get("customData") or {}).get("childCanvas") if isinstance(e.get("customData"), dict) else None
    if isinstance(child, str) and child in kids:
        out["customData"] = {"childCanvas": kids[child]}
    return out


def _import_threads(file: Any, element_ids: set[str], source: str) -> tuple[list[dict[str, Any]], int]:
    threads: list[dict[str, Any]] = []
    for t in (file.get("threads") if isinstance(file, dict) else None) or []:
        if not isinstance(t, dict) or t.get("deleted"):
            continue
        if len(threads) >= MAX_CANVAS_THREADS:
            raise BundleError("too many threads on one canvas")
        msgs = t.get("messages") or []
        if not isinstance(msgs, list) or len(msgs) > MAX_THREAD_MESSAGES:
            raise BundleError("too many messages in one thread")
        tid = t.get("id")
        try:
            anchor = clean_anchor(t.get("anchor"), element_ids)
        except ValueError:
            continue  # its element did not come along
        if not isinstance(tid, str) or not ID_RE.match(tid) or len(tid) > 32:
            raise BundleError("a thread has no valid id")
        kept = []
        for m in msgs:
            if not isinstance(m, dict) or m.get("deleted"):
                continue
            mid = m.get("id")
            if not isinstance(mid, str) or not ID_RE.match(mid) or len(mid) > 32:
                raise BundleError("a message has no valid id")
            text = m.get("text")
            if not isinstance(text, str) or len(text) > MAX_TEXT:
                raise BundleError(f"a message text is too long (over {MAX_TEXT} characters)")
            at = m.get("at")
            kept.append({"id": mid, "author": "human", "by": _imported_person(m.get("by")), "text": text, "at": int(finite(at, 0, 1e14)) if at is not None else 0})
        if not kept:
            continue
        people = {p["id"]: p for p in (m["by"] for m in kept)}
        thread = {
            "id": tid,
            "n": len(threads) + 1,
            "anchor": anchor,
            "resolved": bool(t.get("resolved")),
            "createdAt": int(finite(t.get("createdAt"), 0, 1e14)) if t.get("createdAt") is not None else 0,
            "createdBy": kept[0]["by"],
            "imported": {"from": source},
            "messages": kept,
            "participants": list(people.values()),
        }
        threads.append(thread)
    return threads, len(threads)


def import_bundle(store: ProjectStore, data: Any) -> dict[str, Any]:
    """Bring a bundle in as new canvases (new ids, titles marked as coming from elsewhere) with
    its comments as read-only history. Everything in it is untrusted: it is validated first and
    nothing is written unless all of it is good; only files under ``.agora/`` are ever written."""
    if not isinstance(data, dict) or data.get("format") != BUNDLE_FORMAT:
        raise BundleError("not an Agora share bundle")
    if data.get("version") != BUNDLE_VERSION:
        raise BundleError(f"unsupported bundle version {data.get('version')!r} (this Agora reads version {BUNDLE_VERSION})")
    src = data.get("canvases")
    manifest = data.get("manifest") if isinstance(data.get("manifest"), dict) else {}
    if not isinstance(src, dict) or not src:
        raise BundleError("the bundle has no canvases")
    if len(src) > MAX_BUNDLE_CANVASES:
        raise BundleError(f"too many canvases (over {MAX_BUNDLE_CANVASES})")
    if any(not isinstance(k, str) or not ID_RE.match(k) or len(k) > 64 for k in src):
        raise BundleError("a canvas id is not valid")
    root = manifest.get("root")
    if root not in src:
        raise BundleError("the manifest's root canvas is not in the bundle")
    project = str(manifest.get("project") or "另一个项目")[:60]
    ids = {old: f"c-{secrets.token_hex(4)}" for old in src}
    total = 0
    planned: dict[str, tuple[str, dict[str, Any], dict[str, Any] | None]] = {}
    n_threads = 0
    for old, c in src.items():
        if not isinstance(c, dict) or not isinstance(c.get("elements"), list):
            raise BundleError(f"canvas {old!r} has no element list")
        if len(c["elements"]) > MAX_CANVAS_ELEMENTS:
            raise BundleError(f"too many elements on one canvas (over {MAX_CANVAS_ELEMENTS})")
        total += len(c["elements"])
        if total > MAX_BUNDLE_ELEMENTS:
            raise BundleError(f"too many elements in the bundle (over {MAX_BUNDLE_ELEMENTS})")
        els = [x for x in (_import_element(e, ids) for e in c["elements"]) if x is not None]
        threads, n = _import_threads(c.get("threads"), {e["id"] for e in els}, project)
        n_threads += n
        title = f"来自 {project} · {str(c.get('title') or '画布')[:MAX_TITLE]}"
        planned[old] = (title, {"elements": els}, {"seq": len(threads), "threads": threads} if threads else None)
    written: list[tuple[str, str]] = []
    try:
        for old, (_, scene, threads) in planned.items():
            store.write("canvas", ids[old], scene, base=None)
            written.append(("canvas", ids[old]))
            if threads:
                store.write("threads", ids[old], threads, base=None)
                written.append(("threads", ids[old]))
        ws = store.read("workspace")
        docs = [{"id": ids[old], "kind": "canvas", "title": title} for old, (title, _, _) in planned.items()]
        if ws is None:
            layout = {"kind": "group", "id": f"g-{secrets.token_hex(3)}", "tabs": [ids[root]], "active": ids[root]}  # a workspace the page can open
            store.write("workspace", None, {"v": 2, "docs": docs, "root": layout, "focused": ids[root]}, base=None)
        else:
            cur, version = ws
            store.write("workspace", None, {**cur, "docs": [*(cur.get("docs") or []), *docs]}, base=version)
    except Exception:
        for kind, cid in reversed(written):
            store.delete(kind, cid)
        raise
    return {"canvasId": ids[root], "canvases": len(planned), "threads": n_threads}


# ——— quick share: `cf tunnels quick-start`, no Cloudflare account ———
QUICK_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
QUICK_READY = b"Registered tunnel connection"


def _descendants(pid: int) -> list[int]:
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    kids = [int(x) for x in out]
    return [d for k in kids for d in _descendants(k)] + kids


class QuickTunnel:
    """A running ``cf tunnels quick-start``: the address it printed, and its process tree
    (cf → node → cloudflared) that has to end with it."""

    def __init__(self, proc: subprocess.Popen, log: Path, start_size: int, host: str) -> None:
        self.proc, self.pid, self.log, self.start_size, self.host = proc, proc.pid, log, start_size, host

    def alive(self) -> bool:
        return self.proc.poll() is None

    def wait_ready(self, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline and self.alive():
            if QUICK_READY in _tail(self.log, self.start_size):
                return True
            time.sleep(0.25)
        return False

    def stop(self) -> None:
        pids = _descendants(self.pid) + ([self.pid] if self.alive() else [])
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in pids:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            deadline = time.time() + 5
            while time.time() < deadline and any(_running(p) for p in pids):
                time.sleep(0.1)
            if not any(_running(p) for p in pids):
                break
        self.proc.poll()


def _running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() not in ("", "Z")


def _tail(log: Path, start: int) -> bytes:
    try:
        with open(log, "rb") as fh:
            fh.seek(start)
            return fh.read()
    except FileNotFoundError:
        return b""


def start_quick_tunnel(port: int, log: Path, timeout: float = READY_TIMEOUT_S) -> QuickTunnel:
    """``cf tunnels quick-start http://127.0.0.1:<port>`` (or ``npx cf``), address parsed from its output."""
    cf = [shutil.which("cf") or "npx", *([] if shutil.which("cf") else ["--yes", "cf"])]
    log.parent.mkdir(parents=True, exist_ok=True)
    start = log.stat().st_size if log.exists() else 0
    env = {**os.environ, "TUNNEL_TRANSPORT_PROTOCOL": os.environ.get("AGORA_TUNNEL_PROTOCOL") or "http2"}  # QUIC (UDP 7844) is blocked on many networks
    with open(log, "ab") as fh:
        # Same process group as the project server: `agora down` stops it with the server.
        proc = subprocess.Popen([*cf, "tunnels", "quick-start", f"http://127.0.0.1:{port}"], stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
    deadline = time.time() + timeout
    while time.time() < deadline and proc.poll() is None:
        m = QUICK_URL_RE.search(_tail(log, start).decode("utf-8", "replace"))
        if m:
            return QuickTunnel(proc, log, start, m.group(0).removeprefix("https://"))
        time.sleep(0.25)
    q = QuickTunnel(proc, log, start, "")
    q.stop()
    raise ShareError(f"`cf tunnels quick-start` printed no address within {timeout:.0f}s (is Node / npx available and the network up?); see {log}")


# ——— lifecycle ———
class ShareError(RuntimeError):
    pass


class ShareManager:
    def __init__(
        self,
        store: ProjectStore,
        *,
        providers: Callable[[], tuple[DnsProvider, TunnelProvider]] | None = None,
        config_dir: Path | None = None,
        domain: str | None = None,
        clock: Callable[[], float] = time.time,
        on_change: Callable[[], None] | None = None,
        quick: Callable[[int, Path], TunnelProcess] | None = None,
    ) -> None:
        self.store = store
        self.file = ShareFile(store)
        self._providers_factory = providers
        self._providers: tuple[DnsProvider, TunnelProvider] | None = None
        self.config_dir = config_dir or Path(os.environ.get("AGORA_CONFIG_DIR") or Path.home() / ".config" / "agora")
        self._domain = domain or os.environ.get("AGORA_SHARE_DOMAIN") or None
        self.clock = clock
        self.on_change = on_change
        self._quick = quick or start_quick_tunnel
        self.gateway_port: int | None = None
        self.proc: TunnelProcess | None = None
        self.lock = threading.RLock()
        self.shares = self.file.load()
        # A tunnel may exist that nothing needs any more (left by a crash): check once on start.
        self.tunnel_dirty = any(s.tunnelId for s in self.shares if s.endedAt is None or s.cleanup)

    # ——— helpers ———
    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def providers(self) -> tuple[DnsProvider, TunnelProvider]:
        if self._providers is None:
            if self._providers_factory is None:
                from server.canvas.cloudflare import default_providers

                self._providers = default_providers()
            else:
                self._providers = self._providers_factory()
        return self._providers

    def domain(self) -> str:
        if not self._domain:
            self._domain = self.providers()[0].zone_name()
        return self._domain

    @property
    def tunnel_name(self) -> str:
        """``agora-share-<project id>-<instance id>``: two copies or worktrees of one project each
        get their own tunnel, so ending one's last share never tears down the other's."""
        from server.canvas.local import Local

        iid = Local(self.store).instance_id().replace("-", "")[:6]
        return f"{self.legacy_tunnel_name}-{iid}" if iid else self.legacy_tunnel_name

    @property
    def legacy_tunnel_name(self) -> str:
        """The name builds before instance ids used (shared by every copy of the project)."""
        return f"agora-share-{str(self.store.info()['id']).replace('-', '')[:8]}"

    def _tunnel_files(self, tunnel_id: str) -> tuple[Path, Path]:
        d = self.config_dir / "tunnels"
        return d / f"{tunnel_id}.json", d / f"{tunnel_id}.yml"

    def _save(self) -> None:
        self.file.save(self.shares)
        if self.on_change:
            self.on_change()

    def get(self, id: str) -> Share | None:
        return next((s for s in self.shares if s.id == id), None)

    def active(self) -> list[Share]:
        now = self.now_ms()
        return [s for s in self.shares if s.active(now)]

    def list(self) -> list[dict[str, Any]]:
        now = self.now_ms()
        with self.lock:
            return [s.public(now) for s in sorted(self.shares, key=lambda s: -s.createdAt)]

    # ——— guest checks (hot path: no Cloudflare calls, no disk writes) ———
    def by_host(self, host: str) -> Share | None:
        host = host.split(":")[0].lower()
        now = self.now_ms()
        return next((s for s in self.shares if s.host == host and s.active(now)), None)

    def verify(self, host: str, token: str | None) -> Share | None:
        """The active share for this hostname if ``token`` is its token (constant-time compare)."""
        share = self.by_host(host)
        if share is None or not token or len(token) > 200:
            return None
        return share if hmac.compare_digest(token_hash(token), share.tokenHash) else None

    def admit(self, share: Share, guest_id: str) -> bool:
        """A guest enters through /s/<token>. The first entry of each guest counts as one opening;
        once ``maxOpens`` openings are used up, only guests who already entered get in."""
        key = guest_key(guest_id)
        with self.lock:
            if key in share.admitted:
                return True
            if share.maxOpens is not None and share.opens >= share.maxOpens:
                return False
            share.admitted.append(key)
            share.opens += 1
            self._save()
            return True

    def is_admitted(self, share: Share, guest_id: str | None) -> bool:
        """Past /s/: an opening-limited share only serves guests it admitted (a copied share cookie
        without an admitted guest id doesn't get around the limit). Unlimited shares serve anyone
        holding the token."""
        return share.maxOpens is None or (guest_id is not None and guest_key(guest_id) in share.admitted)

    def note_visit(self, share: Share, new_guest: bool) -> None:
        with self.lock:
            share.visits += 1
            share.guests += 1 if new_guest else 0
            share.lastVisitAt = self.now_ms()
            self._save()

    def note_comment(self, share: Share) -> None:
        with self.lock:
            share.comments += 1
            self._save()

    # ——— create ———
    def create(self, canvas_id: str, ttl_s: int | None, canvas_title: str = "", max_opens: int | None = None, *, quick: bool = False) -> tuple[dict[str, Any], str]:
        """New share → (public record, full URL with the token). The token is not kept.
        ``quick``: an account-less trycloudflare.com address, one share at a time, gone with its process."""
        check_ttl(ttl_s)
        check_max_opens(max_opens)
        if self.gateway_port is None:
            raise ShareError("the share gateway is not running (start the project with `agora up`)")
        with self.lock:
            if quick or any(s.quick for s in self.active()):
                return self._create_quick(canvas_id, ttl_s, canvas_title, max_opens, quick)
            dns, _ = self.providers()
            host = f"{slug(str(self.store.info()['name']))}-{secrets.token_hex(3)}.{self.domain()}".lower()
            token = secrets.token_urlsafe(32)
            now = self.now_ms()
            share = Share(
                id=secrets.token_hex(4),
                canvasId=canvas_id,
                canvasTitle=canvas_title,
                host=host,
                tokenHash=token_hash(token),
                createdAt=now,
                expiresAt=None if ttl_s is None else now + ttl_s * 1000,
                maxOpens=max_opens,
            )
            tunnel_id = self._ensure_tunnel()
            self.tunnel_dirty = True
            share.tunnelId = tunnel_id
            try:
                share.dnsRecordId = dns.create_cname(host, f"{tunnel_id}.cfargotunnel.com", f"agora share {share.id} (expires {'never' if ttl_s is None else share.expiresAt})")
            except Exception as e:
                self._teardown_if_idle()
                raise ShareError(f"could not create the DNS record for {host}: {e}") from e
            self.shares.append(share)
            self._save()
            return share.public(now), f"https://{host}/s/{token}"

    def _create_quick(self, canvas_id: str, ttl_s: int | None, canvas_title: str, max_opens: int | None, quick: bool) -> tuple[dict[str, Any], str]:
        if self.active():
            raise ShareError("a quick share allows one share at a time: end the current one first (`agora share revoke --all`)" if quick else "a quick share is running and takes the only slot; end it first (`agora share revoke --all`)")
        assert self.gateway_port is not None
        proc = self._quick(self.gateway_port, self.store.run_dir / "cf-quick.log")
        if not proc.wait_ready(READY_TIMEOUT_S):
            proc.stop()
            raise ShareError(f"the quick tunnel did not connect within {READY_TIMEOUT_S:.0f}s; see {self.store.run_dir / 'cf-quick.log'}")
        self.proc = proc
        self._write_state("quick")
        token = secrets.token_urlsafe(32)
        now = self.now_ms()
        share = Share(
            id=secrets.token_hex(4), canvasId=canvas_id, canvasTitle=canvas_title, host=proc.host.lower(), tokenHash=token_hash(token),
            createdAt=now, expiresAt=None if ttl_s is None else now + ttl_s * 1000, maxOpens=max_opens, quick=True,
        )
        self.shares.append(share)
        self._save()
        return share.public(now), f"https://{share.host}/s/{token}"

    def _ensure_tunnel(self) -> str:
        """This project's tunnel exists and its connector is running and registered."""
        _, tunnels = self.providers()
        tid = next((s.tunnelId for s in self.active() if s.tunnelId), None) or tunnels.find(self.tunnel_name)
        if tid:
            cred, cfg = self._tunnel_files(tid)
            if not cred.exists():  # a tunnel we can't run (credentials lost): replace it
                tunnels.delete(tid)
                tid = None
        if not tid:
            cred_tmp = self.config_dir / "tunnels" / f"new-{secrets.token_hex(4)}.json"
            cred_tmp.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(cred_tmp.parent, 0o700)
            tid = tunnels.create(self.tunnel_name, cred_tmp)
            self.tunnel_dirty = True
            cred, cfg = self._tunnel_files(tid)
            os.replace(cred_tmp, cred)
            os.chmod(cred, 0o600)
        cred, cfg = self._tunnel_files(tid)
        if self.proc is None or not self.proc.alive():
            cfg.write_text(
                f"tunnel: {tid}\ncredentials-file: {cred}\nno-autoupdate: true\n"
                # QUIC (UDP 7844) is blocked on many networks and cloudflared keeps retrying it; HTTP/2 always works.
                f"protocol: {os.environ.get('AGORA_TUNNEL_PROTOCOL') or 'http2'}\n"
                f"ingress:\n  - service: http://127.0.0.1:{self.gateway_port}\n"
            )
            self.proc = tunnels.start(tid, cred, cfg, self.store.run_dir / "cloudflared.log")
            self._write_state(tid)
            if not self.proc.wait_ready(READY_TIMEOUT_S):
                self.proc.stop()
                self.proc = None
                raise ShareError(f"cloudflared did not connect within {READY_TIMEOUT_S:.0f}s; see {self.store.run_dir / 'cloudflared.log'}")
        return tid

    def _write_state(self, tid: str | None) -> None:
        path = self.store.run_dir / "share-tunnel.json"
        if tid is None or self.proc is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(json.dumps({"tunnelId": tid, "name": self.tunnel_name, "pid": self.proc.pid, "gatewayPort": self.gateway_port}) + "\n")

    # ——— end ———
    def revoke(self, id: str) -> dict[str, Any]:
        with self.lock:
            share = self.get(id)
            if share is None:
                raise KeyError(id)
            if share.endedAt is None:
                self._end(share, "revoked")
            return share.public(self.now_ms())

    def end_for_canvas(self, canvas_id: str, reason: str = "canvas-deleted") -> list[str]:
        """End every live share of one canvas (it was deleted). Returns the ids ended now."""
        ended = []
        with self.lock:
            for s in self.shares:
                if s.canvasId == canvas_id and s.endedAt is None:
                    self._end(s, reason)
                    ended.append(s.id)
        return ended

    def sweep(self) -> list[str]:
        """End expired shares; retry unfinished cleanup. Returns ids ended now."""
        ended = []
        with self.lock:
            now = self.now_ms()
            for s in self.shares:
                if s.endedAt is None and not s.active(now):
                    self._end(s, "expired")
                    ended.append(s.id)
                elif s.endedAt is None and s.quick and (self.proc is None or not self.proc.alive()):
                    self._end(s, "revoked")  # its address died with the process
                    ended.append(s.id)
                elif s.endedAt is not None and s.cleanup:
                    self._cleanup(s)
                    self._save()
            if self.tunnel_dirty and not self.active():
                self._teardown_if_idle()
        return ended

    def _end(self, share: Share, reason: str) -> None:
        share.endedAt = self.now_ms()
        share.endReason = reason
        share.cleanup = ["dns"] if share.dnsRecordId else []
        self._save()  # the token is dead from here on, whatever happens with Cloudflare below
        self._cleanup(share)
        self._save()

    def _cleanup(self, share: Share) -> None:
        if "dns" in share.cleanup and share.dnsRecordId:
            try:
                self.providers()[0].delete(share.dnsRecordId)
                share.cleanup.remove("dns")
            except Exception:
                pass  # retried by the next sweep
        if not self.active():
            self._teardown_if_idle()

    def _teardown_if_idle(self) -> None:
        """No active share: stop the connector, delete this project's tunnel and its local files."""
        if self.active():
            return
        if self.proc is not None:
            self.proc.stop()
            self.proc = None
        self._write_state(None)
        if not self.tunnel_dirty:  # only quick shares (or none) ran: no Cloudflare account involved
            return
        _, tunnels = self.providers()
        try:
            tid = tunnels.find(self.tunnel_name)
            # A tunnel under the old shared name is deleted only when this copy's own share records
            # name it (another copy may be using a tunnel of that name).
            ours = {s.tunnelId for s in self.shares if s.tunnelId}
            legacy = tunnels.find(self.legacy_tunnel_name) if self.legacy_tunnel_name != self.tunnel_name else None
            for t in [x for x in (tid, legacy if legacy in ours else None) if x]:
                tunnels.delete(t)
                for f in self._tunnel_files(t):
                    f.unlink(missing_ok=True)
            self.tunnel_dirty = False
        except Exception:
            self.tunnel_dirty = True  # retried by the next sweep

    # ——— process lifecycle ———
    def resume(self) -> None:
        """Server start: end what expired while it was down, reconnect the tunnel for the rest."""
        with self.lock:
            self.sweep()
            if self.active() and self.gateway_port is not None:
                try:
                    self._ensure_tunnel()
                except Exception:
                    pass

    def shutdown(self) -> None:
        """Server stop: stop the connector. Named shares stay recorded and resume on the next ``up``;
        a quick share cannot (its address dies with the process), so it ends here."""
        with self.lock:
            for s in [s for s in self.shares if s.quick and s.endedAt is None]:
                self._end(s, "revoked")
            if self.proc is not None:
                self.proc.stop()
                self.proc = None
            self._write_state(None)
