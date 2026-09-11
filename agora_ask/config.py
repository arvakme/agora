"""Configuration for the agora_ask CLI."""

from __future__ import annotations

import os
import shlex
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class AskSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AGORA_ASK_", extra="ignore")

    host_root: Path = Path.home() / ".agora" / "host"
    deployment: str = "local"
    session_name: str = "codex"
    codex_command: str = "codex"
    cwd: Path = Path.cwd()
    database_url: str = "postgresql://agora:agora@127.0.0.1:5433/agora"
    timeout_s: float = 600.0
    discovery_timeout_s: float = 60.0
    native_log: Path | None = None
    native_locator: str | None = None

    def codex_argv(self) -> list[str]:
        return shlex.split(self.codex_command)

    def effective_database_url(self) -> str:
        return os.environ.get("AGORA_DATABASE_URL", self.database_url)


@lru_cache
def get_settings() -> AskSettings:
    return AskSettings()
