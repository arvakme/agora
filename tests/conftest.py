from __future__ import annotations

import os
import socket
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import pytest

os.environ.setdefault("AGORA_DATABASE_URL", "postgresql://agora:agora@127.0.0.1:5433/agora")
os.environ.setdefault("AGORA_REDIS_URL", "redis://127.0.0.1:6379/0")

DSN = os.environ["AGORA_DATABASE_URL"]
REDIS_URL = os.environ["AGORA_REDIS_URL"]


def _host_port(url: str, default_port: int) -> tuple[str, int]:
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or default_port
    return host, port


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@pytest.fixture(scope="session")
def require_services() -> None:
    """Fail every integration test at once when Postgres or Redis is missing.

    Starting the services belongs to docker compose, not to the test run: a
    suite that quietly skips here reports success while proving nothing.
    """
    services = {"Postgres": _host_port(DSN, 5432), "Redis": _host_port(REDIS_URL, 6379)}
    unreachable = [
        f"{name} {host}:{port}"
        for name, (host, port) in services.items()
        if not _port_open(host, port)
    ]
    if unreachable:
        pytest.fail(
            f"services unreachable: {', '.join(unreachable)}; start them with "
            "`docker compose up -d`",
            pytrace=False,
        )


@pytest.fixture
async def app_client(require_services: None) -> AsyncIterator[tuple]:
    import httpx

    from server import db
    from server.main import create_app

    app = create_app(stub_turns=True)
    async with app.router.lifespan_context(app):
        await db.truncate_all(app.state.pool)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield app, client
