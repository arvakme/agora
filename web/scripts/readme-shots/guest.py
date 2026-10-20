"""The guest page of a share, served locally for the README screenshot (scripts/readme-shots.ts).

    uv run python web/scripts/readme-shots/guest.py <project dir> <canvas id> <port>

The project's real share gateway (server/canvas/share_gateway.py) over the project's own .agora/, with
Cloudflare's DNS and tunnel replaced by stand-ins (as in tests/test_share.py): one share of the canvas, for a
day, on a ``*.localhost`` host. Browsers send ``Host: <name>.localhost:<port>`` and keep only cookies a plain
http page may set, so a thin wrapper drops the port from Host and the ``Secure`` flag from Set-Cookie;
everything else is the gateway as guests meet it. Prints one JSON line ``{"url": …}`` once it listens.
Writes the share record into the project's .agora/ (a throwaway demo project).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import uvicorn

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from server.canvas.events import Events  # noqa: E402
from server.canvas.project import ProjectStore  # noqa: E402
from server.canvas.share import ShareManager  # noqa: E402
from server.canvas.share_gateway import create_gateway_app  # noqa: E402


class LocalDNS:
    def zone_name(self) -> str:
        return "localhost"

    def create_cname(self, name, target, comment):
        return "rec-local"

    def delete(self, rid):
        pass

    def exists(self, rid):
        return True


class LocalProc:
    pid = 0

    def alive(self):
        return True

    def wait_ready(self, timeout):
        return True

    def stop(self):
        pass


class LocalTunnels:
    def find(self, name):
        return "tun-local"

    def create(self, name):
        return "tun-local"

    def delete(self, tid):
        pass

    def start(self, tid, port, log):
        return LocalProc()


def plain_http(app, port: int):
    suffix = f":{port}".encode()

    async def wrapped(scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope, headers=[(k, v[: -len(suffix)] if k == b"host" and v.endswith(suffix) else v) for k, v in scope["headers"]])

            async def send_plain(msg):
                if msg["type"] == "http.response.start":
                    msg = dict(msg, headers=[(k, v.replace(b"; Secure", b"").replace(b"; secure", b"")) if k.lower() == b"set-cookie" else (k, v) for k, v in msg["headers"]])
                await send(msg)

            return await app(scope, receive, send_plain)
        return await app(scope, receive, send)

    return wrapped


def main() -> None:
    root, canvas, port = Path(sys.argv[1]).resolve(), sys.argv[2], int(sys.argv[3])
    store = ProjectStore(root)
    dns, tunnels = LocalDNS(), LocalTunnels()
    shares = ShareManager(store, providers=lambda: (dns, tunnels), domain="localhost")
    shares.gateway_port = port
    app = create_gateway_app(store, shares, Events(), dist=REPO / "web" / "dist")
    _, url = shares.create(canvas, 86400, "")
    print(json.dumps({"url": url.replace("https://", "http://").replace(".localhost/", f".localhost:{port}/")}), flush=True)
    uvicorn.run(plain_http(app, port), host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
