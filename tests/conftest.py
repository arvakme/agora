from __future__ import annotations

import os

import pytest

# Starlette's TestClient sends Host: testserver; the owner app only answers to local names.
os.environ.setdefault("AGORA_ALLOWED_HOSTS", "testserver")


@pytest.fixture(autouse=True)
def _agora_state_dir(tmp_path_factory, monkeypatch):
    """Machine-local Agora state (instance registry, server records, backups) goes to a temporary
    directory in every test, never to ~/.local/state/agora."""
    if "AGORA_STATE_DIR" not in os.environ or not os.environ["AGORA_STATE_DIR"].startswith(str(tmp_path_factory.getbasetemp())):
        monkeypatch.setenv("AGORA_STATE_DIR", str(tmp_path_factory.mktemp("agora-state")))
