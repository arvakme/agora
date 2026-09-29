"""The real share providers: Cloudflare reached through the ``cf`` CLI (``npx cf`` when it is not
installed). ``cf`` owns login and credentials (``cf auth login``); Agora keeps none of its own and
never reads them. Each call runs ``cf … `` and parses its JSON output.

- DNS: ``cf dns records create|get|delete`` in the zone named by ``AGORA_SHARE_DOMAIN`` (or the
  account's only zone).
- Tunnels: ``cf tunnels create|list|delete``. A tunnel is remotely configured
  (``config_src: cloudflare``): its single ingress — the local share gateway — is set with
  ``cf tunnels config update`` on every start, and the connector is ``cf tunnels run --token``
  (cf's own cloudflared). The token exists only in that call's arguments; it is never written
  anywhere.
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


class CfCli:
    """Both providers (``DnsProvider`` and ``TunnelProvider`` in share.py) over the ``cf`` CLI."""

    def __init__(self, domain: str | None = None, command: list[str] | None = None) -> None:
        self.cmd = command or cf_command()
        self._domain = domain or os.environ.get("AGORA_SHARE_DOMAIN") or None

    # ——— running cf ———
    def _run(self, *args: str, zone: bool = False, secret: bool = False, text_ok: bool = False) -> Any:
        argv = [*self.cmd, *args, *(["-z", self._domain] if zone and self._domain else [])]
        r = subprocess.run(argv, capture_output=True, text=True, timeout=90, stdin=subprocess.DEVNULL, cwd=cf_cwd())
        if r.returncode != 0:
            text = (r.stderr or r.stdout).strip()
            if "auth login" in text or "not authenticated" in text.lower() or "unauthorized" in text.lower():
                raise CloudflareError(LOGIN_HINT)
            what = " ".join(args[:3])
            raise CloudflareError(f"cf {what}: {'(output withheld)' if secret else text[-400:]}")
        out = r.stdout.strip()
        try:
            return json.loads(out) if out else None
        except json.JSONDecodeError:
            if text_ok:
                return out
            raise CloudflareError(f"cf {' '.join(args[:3])}: output is not JSON") from None

    def check_login(self) -> None:
        me = self._run("auth", "whoami")
        if not (isinstance(me, dict) and me.get("authenticated")):
            raise CloudflareError(LOGIN_HINT)

    # ——— DnsProvider ———
    def zone_name(self) -> str:
        if self._domain:
            return self._domain
        zones = self._run("zones", "list") or []
        if len(zones) != 1:
            raise CloudflareError("set AGORA_SHARE_DOMAIN to the Cloudflare zone to share under (the account has " + ("none" if not zones else f"{len(zones)} zones") + ")")
        self._domain = str(zones[0]["name"])
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
        token = self._run("tunnels", "token", "get", tunnel_id, secret=True, text_ok=True)
        if not isinstance(token, str) or not token:
            raise CloudflareError("cf tunnels token get: no token")
        log.parent.mkdir(parents=True, exist_ok=True)
        start = log.stat().st_size if log.exists() else 0
        env = {**os.environ, "TUNNEL_TRANSPORT_PROTOCOL": os.environ.get("AGORA_TUNNEL_PROTOCOL") or "http2"}  # QUIC (UDP 7844) is blocked on many networks
        with open(log, "ab") as fh:
            # Same process group as the project server: `agora down` stops it with the server.
            proc = subprocess.Popen([*self.cmd, "tunnels", "run", "--token", token], stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, cwd=cf_cwd())
        return CfProcess(proc, log, start, "")


class CfDns:
    def __init__(self, cf: CfCli) -> None:
        self.cf = cf
        self.zone_name, self.create_cname, self.delete, self.exists = cf.zone_name, cf.create_cname, cf.delete, cf.exists


class CfTunnels:
    def __init__(self, cf: CfCli) -> None:
        self.cf = cf
        self.find, self.create, self.delete, self.start = cf.find, cf.create, cf.delete_tunnel, cf.start


def default_providers() -> tuple[CfDns, CfTunnels]:
    cf = CfCli()
    cf.check_login()
    return CfDns(cf), CfTunnels(cf)
