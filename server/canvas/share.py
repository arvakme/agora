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
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from server.canvas.project import ProjectStore, dump_json

SHARES_DIR = "shares"
DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$")
UNITS = {"s": 1, "m": 60, "min": 60, "h": 3600, "d": 86400, "w": 7 * 86400}
FOREVER = ("forever", "never", "manual", "0")
MAX_TTL_S = 90 * 86400
MIN_TTL_S = 60
MAX_OPENS = 10000
READY_TIMEOUT_S = 45.0


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


def guest_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Scene elements without ``customData`` (code paths of the progress pointer, animation metadata)."""
    return [{k: v for k, v in e.items() if k != "customData"} for e in elements if not e.get("isDeleted")]


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
    ) -> None:
        self.store = store
        self.file = ShareFile(store)
        self._providers_factory = providers
        self._providers: tuple[DnsProvider, TunnelProvider] | None = None
        self.config_dir = config_dir or Path(os.environ.get("AGORA_CONFIG_DIR") or Path.home() / ".config" / "agora")
        self._domain = domain or os.environ.get("AGORA_SHARE_DOMAIN") or None
        self.clock = clock
        self.on_change = on_change
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
    def create(self, canvas_id: str, ttl_s: int | None, canvas_title: str = "", max_opens: int | None = None) -> tuple[dict[str, Any], str]:
        """New share → (public record, full URL with the token). The token is not kept."""
        check_ttl(ttl_s)
        check_max_opens(max_opens)
        if self.gateway_port is None:
            raise ShareError("the share gateway is not running (start the project with `agora up`)")
        with self.lock:
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
        """Server stop: stop the connector. Active shares stay recorded and resume on the next ``up``."""
        with self.lock:
            if self.proc is not None:
                self.proc.stop()
                self.proc = None
            self._write_state(None)
