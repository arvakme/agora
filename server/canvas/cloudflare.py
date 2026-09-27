"""The real share providers: Cloudflare DNS over its v4 API, tunnels through ``cloudflared``.

Credentials (never written into the project or ``.agora/``):

- DNS: ``AGORA_CF_API_TOKEN`` + ``AGORA_CF_ZONE_ID``; otherwise the zone-scoped token inside
  ``cloudflared``'s origin certificate (``TUNNEL_ORIGIN_CERT`` or ``~/.cloudflared/cert.pem``,
  created by ``cloudflared tunnel login``) — the same token ``cloudflared tunnel route dns``
  uses. The share domain defaults to that zone's name.
- Tunnels: ``cloudflared`` with its default origin certificate; each tunnel's credentials file is
  written to ``~/.config/agora/tunnels/<id>.json`` (mode 600).
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4"


class CloudflareError(RuntimeError):
    pass


def origin_cert() -> Path:
    return Path(os.environ.get("TUNNEL_ORIGIN_CERT") or Path.home() / ".cloudflared" / "cert.pem")


def _cert_token(path: Path) -> dict[str, str]:
    raw = path.read_text()
    m = re.search(r"-----BEGIN ARGO TUNNEL TOKEN-----(.*?)-----END ARGO TUNNEL TOKEN-----", raw, re.S)
    if not m:
        raise CloudflareError(f"{path} has no tunnel token; run `cloudflared tunnel login`")
    return json.loads(base64.b64decode("".join(m.group(1).split())))


class CloudflareDNS:
    def __init__(self, token: str, zone_id: str) -> None:
        self._token = token
        self.zone_id = zone_id
        self._zone_name: str | None = None

    @classmethod
    def from_env(cls) -> CloudflareDNS:
        if os.environ.get("AGORA_CF_API_TOKEN") and os.environ.get("AGORA_CF_ZONE_ID"):
            return cls(os.environ["AGORA_CF_API_TOKEN"], os.environ["AGORA_CF_ZONE_ID"])
        cert = origin_cert()
        if not cert.exists():
            raise CloudflareError("no Cloudflare credentials: set AGORA_CF_API_TOKEN and AGORA_CF_ZONE_ID, or run `cloudflared tunnel login`")
        tok = _cert_token(cert)
        return cls(tok["apiToken"], tok["zoneID"])

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        req = urllib.request.Request(
            API + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                data = json.loads(e.read() or b"{}")
            except json.JSONDecodeError:
                data = {}
            errs = "; ".join(str(x.get("message")) for x in data.get("errors") or []) or str(e)
            raise CloudflareError(f"{method} {path.split('?')[0]}: {e.code} {errs}") from None
        if not data.get("success", True):
            raise CloudflareError(f"{method} {path}: {data.get('errors')}")
        return data.get("result")

    def zone_name(self) -> str:
        if self._zone_name is None:
            self._zone_name = str(self._call("GET", f"/zones/{self.zone_id}")["name"])
        return self._zone_name

    def create_cname(self, name: str, target: str, comment: str) -> str:
        r = self._call("POST", f"/zones/{self.zone_id}/dns_records", {"type": "CNAME", "name": name, "content": target, "proxied": True, "ttl": 1, "comment": comment[:100]})
        return str(r["id"])

    def delete(self, record_id: str) -> None:
        try:
            self._call("DELETE", f"/zones/{self.zone_id}/dns_records/{record_id}")
        except CloudflareError as e:
            if " 404 " not in str(e) and "not found" not in str(e).lower():
                raise

    def exists(self, record_id: str) -> bool:
        try:
            self._call("GET", f"/zones/{self.zone_id}/dns_records/{record_id}")
            return True
        except CloudflareError as e:
            if " 404 " in str(e) or "not found" in str(e).lower():
                return False
            raise

    def find(self, name: str) -> list[dict[str, Any]]:
        """Records with exactly this name (for verification after cleanup)."""
        return list(self._call("GET", f"/zones/{self.zone_id}/dns_records?name={name}") or [])


class CloudflaredProcess:
    def __init__(self, proc: subprocess.Popen, log: Path, start_size: int) -> None:
        self.proc = proc
        self.pid = proc.pid
        self.log = log
        self.start_size = start_size

    def alive(self) -> bool:
        return self.proc.poll() is None

    def wait_ready(self, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.alive():
                return False
            try:
                with open(self.log, "rb") as fh:
                    fh.seek(self.start_size)
                    if b"Registered tunnel connection" in fh.read():
                        return True
            except FileNotFoundError:
                pass
            time.sleep(0.25)
        return False

    def stop(self) -> None:
        if not self.alive():
            return
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(3)


class CloudflaredTunnels:
    def __init__(self, binary: str | None = None) -> None:
        self.bin = binary or shutil.which("cloudflared") or "cloudflared"

    def _run(self, *args: str, timeout: float = 60) -> str:
        r = subprocess.run([self.bin, "--no-autoupdate", "tunnel", *args], capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise CloudflareError(f"cloudflared tunnel {args[0]}: {r.stderr.strip()[-400:]}")
        return r.stdout

    def find(self, name: str) -> str | None:
        rows = json.loads(self._run("list", "--output", "json", "--name", name) or "[]") or []
        live = [r for r in rows if r.get("name") == name and not r.get("deleted_at", "").startswith(("1", "2"))]
        return str(live[0]["id"]) if live else None

    def create(self, name: str, credentials: Path) -> str:
        out = self._run("create", "--output", "json", "--credentials-file", str(credentials), name)
        return str(json.loads(out)["id"])

    def delete(self, tunnel_id: str) -> None:
        self._run("delete", "-f", tunnel_id)

    def start(self, tunnel_id: str, credentials: Path, config: Path, log: Path) -> CloudflaredProcess:
        log.parent.mkdir(parents=True, exist_ok=True)
        start = log.stat().st_size if log.exists() else 0
        fh = open(log, "ab")
        # Same process group as the project server: `agora down` stops it with the server.
        proc = subprocess.Popen(
            [self.bin, "tunnel", "--no-autoupdate", "--config", str(config), "--metrics", "127.0.0.1:0", "run", tunnel_id],
            stdout=fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        return CloudflaredProcess(proc, log, start)


def default_providers() -> tuple[CloudflareDNS, CloudflaredTunnels]:
    if not shutil.which("cloudflared"):
        raise CloudflareError("cloudflared is not installed (brew install cloudflared)")
    return CloudflareDNS.from_env(), CloudflaredTunnels()
