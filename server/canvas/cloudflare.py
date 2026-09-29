"""The real share providers: Cloudflare reached through the ``cf`` CLI (``npx cf`` when it is not
installed). ``cf`` owns login and credentials (``cf auth login``); Agora keeps none of its own and
never reads them. Each call runs ``cf … `` and parses its JSON output.

- DNS: ``cf dns records create|get|delete`` in the zone named by ``AGORA_SHARE_DOMAIN``, else the one the
  person picked in the share window (share.py remembers it), else the account's only zone (``cf zones list``).
- Tunnels: ``cf tunnels create|list|delete``. A tunnel is remotely configured
  (``config_src: cloudflare``): its single ingress — the local share gateway — is set with
  ``cf tunnels config update`` on every start, and the connector is ``cf tunnels run <id>`` (cf's
  own cloudflared). cf fetches the tunnel token itself, so Agora never handles it and no process
  argument carries it (``--token <token>`` would show in ``ps``).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from server.canvas.share import CfProcess, cf_command, cf_cwd

LOGIN_HINT = "not logged in to Cloudflare: run `npx cf auth login` first"
CLEANUP_TRIES = 4


class CloudflareError(RuntimeError):
    pass


class NotLoggedIn(CloudflareError):
    pass


class CfMissing(CloudflareError):
    """No ``cf`` to run, and no ``npx cf`` to fetch (no npx, or no network for it)."""


class ZoneChoice(CloudflareError):
    """The account has several zones and none was chosen."""

    def __init__(self, zones: list[str]) -> None:
        super().__init__(f"the account has {len(zones)} zones: {', '.join(zones)}")
        self.zones = zones


_NO_NETWORK = ("enotfound", "eai_again", "econnrefused", "etimedout", "econnreset", "network", "getaddrinfo", "could not resolve")


def humanize(e: BaseException) -> str:
    """What to tell the person: the next step, in plain words, never an exception's class name."""
    cause = e if isinstance(e, CloudflareError) else e.__cause__
    if isinstance(cause, NotLoggedIn):
        return "还没登录 Cloudflare：在终端运行 `npx cf auth login`，完成后再点一次"
    if isinstance(cause, CfMissing):
        return "没找到 cf，也拉不到 npx cf：检查网络，或者先装 cf"
    if isinstance(cause, ZoneChoice):
        return f"账号里有多个域名（{'、'.join(cause.zones)}）：先选一个（命令行用 --domain）"
    reason = str(cause if isinstance(cause, CloudflareError) else e).strip().splitlines()[0][:200] if str(e).strip() else "原因不明"
    return f"{reason}。可以先用临时链接"


class CfCli:
    """Both providers (``DnsProvider`` and ``TunnelProvider`` in share.py) over the ``cf`` CLI."""

    def __init__(self, domain: str | None = None, command: list[str] | None = None) -> None:
        self.cmd = command or cf_command()
        self._domain = domain or os.environ.get("AGORA_SHARE_DOMAIN") or None

    # ——— running cf ———
    def _run(self, *args: str, zone: bool = False) -> Any:
        argv = [*self.cmd, *args, *(["-z", self._domain] if zone and self._domain else [])]
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=90, stdin=subprocess.DEVNULL, cwd=cf_cwd())
        except FileNotFoundError:
            raise CfMissing(f"{argv[0]} not found") from None
        if r.returncode != 0:
            text = (r.stderr or r.stdout).strip()
            if "auth login" in text or "not authenticated" in text.lower() or "unauthorized" in text.lower():
                raise NotLoggedIn(LOGIN_HINT)
            if self.cmd[0].endswith("npx") and any(w in text.lower() for w in _NO_NETWORK):
                raise CfMissing(text[-200:])
            what = " ".join(args[:3])
            raise CloudflareError(f"cf {what}: {text[-400:]}")
        out = r.stdout.strip()
        try:
            return json.loads(out) if out else None
        except json.JSONDecodeError:
            raise CloudflareError(f"cf {' '.join(args[:3])}: output is not JSON") from None

    def check_login(self) -> None:
        me = self._run("auth", "whoami")
        if not (isinstance(me, dict) and me.get("authenticated")):
            raise NotLoggedIn(LOGIN_HINT)

    # ——— DnsProvider ———
    def zones(self) -> list[str]:
        """The account's zones (``cf zones list``)."""
        return [str(z["name"]) for z in self._run("zones", "list") or []]

    def use_domain(self, name: str) -> None:
        self._domain = name

    def zone_name(self) -> str:
        if self._domain:
            return self._domain
        zones = self.zones()
        if not zones:
            raise CloudflareError("这个 Cloudflare 账号里没有域名")
        if len(zones) > 1:
            raise ZoneChoice(zones)
        self._domain = zones[0]
        return self._domain

    def create_cname(self, name: str, target: str, comment: str) -> str:
        self.zone_name()
        body = {"type": "CNAME", "name": name, "content": target, "proxied": True, "ttl": 1, "comment": comment[:100]}
        return str(self._run("dns", "records", "create", "--body", json.dumps(body), zone=True)["id"])

    def delete(self, record_id: str) -> None:
        """A record that is already gone is fine."""
        try:
            self._run("dns", "records", "delete", record_id, "--force", zone=True)
        except CloudflareError as e:
            if "not found" not in str(e).lower() and "81044" not in str(e):
                raise

    def exists(self, record_id: str) -> bool:
        try:
            self._run("dns", "records", "get", record_id, zone=True)
            return True
        except CloudflareError as e:
            if "not found" in str(e).lower() or "81044" in str(e):
                return False
            raise

    # ——— TunnelProvider ———
    def find(self, name: str) -> str | None:
        rows = self._run("tunnels", "list", "--name", name, "--is-deleted", "false") or []
        live = [r for r in rows if r.get("name") == name and not r.get("deleted_at")]
        return str(live[0]["id"]) if live else None

    def create(self, name: str) -> str:
        return str(self._run("tunnels", "create", "--name", name, "--config-src", "cloudflare")["id"])

    def delete_tunnel(self, tunnel_id: str) -> None:
        """Drop the connections first (a tunnel with live connectors cannot be deleted), then the tunnel."""
        err: CloudflareError | None = None
        for _ in range(CLEANUP_TRIES):
            try:
                self._run("tunnels", "connections", "cleanup", tunnel_id, "--force")
                self._run("tunnels", "delete", tunnel_id, "--force")
                return
            except CloudflareError as e:
                err = e
                time.sleep(2)
        raise err or CloudflareError("tunnel not deleted")

    def start(self, tunnel_id: str, port: int, log: Path) -> CfProcess:
        body = {"config": {"ingress": [{"service": f"http://127.0.0.1:{port}"}]}}
        self._run("tunnels", "config", "update", tunnel_id, "--body", json.dumps(body))
        log.parent.mkdir(parents=True, exist_ok=True)
        start = log.stat().st_size if log.exists() else 0
        env = {**os.environ, "TUNNEL_TRANSPORT_PROTOCOL": os.environ.get("AGORA_TUNNEL_PROTOCOL") or "http2"}  # QUIC (UDP 7844) is blocked on many networks
        with open(log, "ab") as fh:
            # Same process group as the project server: `agora down` stops it with the server.
            proc = subprocess.Popen([*self.cmd, "tunnels", "run", tunnel_id], stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, cwd=cf_cwd())
        return CfProcess(proc, log, start, "")


class CfDns:
    def __init__(self, cf: CfCli) -> None:
        self.cf = cf
        self.zone_name, self.zones, self.use_domain, self.create_cname, self.delete, self.exists = cf.zone_name, cf.zones, cf.use_domain, cf.create_cname, cf.delete, cf.exists


class CfTunnels:
    def __init__(self, cf: CfCli) -> None:
        self.cf = cf
        self.find, self.create, self.delete, self.start = cf.find, cf.create, cf.delete_tunnel, cf.start


def default_providers() -> tuple[CfDns, CfTunnels]:
    cf = CfCli()
    cf.check_login()
    return CfDns(cf), CfTunnels(cf)
