"""Which models each agent offers and which effort levels each model really takes.

Nothing here is a hand-written vocabulary: every list comes from the CLI itself or from the
model catalog it keeps (docs: web/docs/agent-sessions.md §2「模型与强度」).

- **Claude Code** — the CLI's own model list with ``supportedEffortLevels`` per model, from the
  SDK ``initialize`` control request (``claude -p --input-format stream-json``; answered before
  any prompt, so no model call is made). Default model: ``~/.claude/settings.json`` ``model``;
  default effort per model: ``modelSettings[<model>].effortLevel``, else ``effortLevel``.
  Fallback when that fails: the ``--effort`` choices in ``claude --help`` for every model.
- **Pi** — ``pi --mode rpc`` ``get_available_models`` gives each model's ``reasoning`` flag and
  ``thinkingLevelMap``; the levels are derived with Pi's own rule (``getSupportedThinkingLevels``
  in pi-ai: no reasoning → ``off`` only; a level mapped to ``null`` is unsupported; ``xhigh`` and
  ``max`` need an explicit mapping), in the order of ``pi --help`` ``--thinking``. Default effort:
  ``defaultThinkingLevel`` clamped the way Pi clamps it. Fallback: ``pi --list-models`` (thinking
  yes/no) with the ``--help`` levels.
- **Codex** — ``~/.codex/models_cache.json``: ``supported_reasoning_levels`` and
  ``default_reasoning_level`` per model; ``config.toml`` ``model_reasoning_effort`` is the default
  where the model supports it. No cache → no effort choices (the CLI default is used).

The parsers are pure functions over the recorded outputs (tests/fixtures/efforts/).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Pi's EXTENDED_THINKING_LEVELS; used only to order and clamp, never to offer a level on its own.
PI_ORDER = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


# ——— parsers (pure) ———
def help_choices(help_text: str, flag: str) -> list[str]:
    """The value list a ``--help`` line gives for ``flag``: ``(low, medium, …)`` or ``…: off, minimal, …``."""
    lines = help_text.splitlines()
    for i, line in enumerate(lines):
        if re.search(rf"(^|\s){re.escape(flag)}\s", line):
            chunk = " ".join(lines[i : i + 3])
            m = re.search(r"\(([a-z]+(?:,\s*[a-z]+)+)\)", chunk) or re.search(r":\s*([a-z]+(?:,\s*[a-z]+)+)", chunk)
            if m:
                return [x.strip() for x in m.group(1).split(",")]
    return []


def claude_catalog_from(init: dict[str, Any] | None, settings: dict[str, Any], help_levels: list[str]) -> dict[str, Any]:
    """Claude Code models from the ``initialize`` response (or aliases + help levels without it)."""
    default = str(settings.get("model") or "")
    per_model = settings.get("modelSettings") or {}
    global_effort = str(settings.get("effortLevel") or "")
    entries: list[dict[str, Any]] = []
    if init:
        resp = init.get("response", {}).get("response", init.get("response", init))
        entries = [m for m in resp.get("models") or [] if isinstance(m, dict) and m.get("value")]
    efforts: dict[str, list[str]] = {}
    resolved: dict[str, str] = {}
    models: list[str] = []
    for m in entries:
        levels = [str(x) for x in m.get("supportedEffortLevels") or []] if m.get("supportsEffort") else []
        value = str(m["value"])
        if m.get("resolvedModel"):
            resolved[value] = str(m["resolvedModel"])
            efforts.setdefault(str(m["resolvedModel"]), levels)
        efforts[value] = levels
        if value != "default":
            models.append(value)
    if not entries:
        models = ["opus", "sonnet", "haiku"]
        efforts = {m: list(help_levels) for m in models}
    if default:
        models = [default, *[m for m in models if m != default]]
        efforts.setdefault(default, efforts.get("default", list(help_levels)))
    # "" = no --model: the CLI's own default model.
    efforts[""] = efforts.get(default) or efforts.get("default") or list(help_levels)

    def default_effort(model: str) -> str:
        for key in (model, resolved.get(model, "")):
            e = (per_model.get(key) or {}).get("effortLevel") if key else None
            if e:
                return str(e) if str(e) in efforts.get(model, []) else ""
        return global_effort if global_effort in efforts.get(model, []) else ""

    all_levels = list(dict.fromkeys(x for m in models for x in efforts.get(m, [])))
    return {
        "default": default,
        "models": list(dict.fromkeys(models)),
        "featured": list(dict.fromkeys(models)),
        "efforts": all_levels or list(help_levels),
        "modelEfforts": efforts,
        "modelDefaultEffort": {m: default_effort(m) for m in [*models, ""]},
        "defaultEffort": default_effort(default or ""),
        "effortSource": "claude initialize" if entries else "claude --help",
    }


def pi_levels(model: dict[str, Any], order: list[str] | tuple[str, ...] = PI_ORDER) -> list[str]:
    """Pi's getSupportedThinkingLevels for one model."""
    if not model.get("reasoning"):
        return ["off"]
    tmap = model.get("thinkingLevelMap") or {}
    out = []
    for level in order:
        if level in tmap and tmap[level] is None:
            continue
        if level in ("xhigh", "max") and tmap.get(level) is None:
            continue
        out.append(level)
    return out


def pi_clamp(level: str, available: list[str], order: list[str] | tuple[str, ...] = PI_ORDER) -> str:
    """Pi's clampThinkingLevel: the level itself, else the next higher supported, else the next lower."""
    if level in available:
        return level
    if level not in order:
        return available[0] if available else "off"
    i = list(order).index(level)
    for x in [*order[i:], *reversed(order[:i])]:
        if x in available:
            return x
    return available[0] if available else "off"


def pi_catalog_from(models: list[dict[str, Any]] | None, settings: dict[str, Any], help_levels: list[str], listed: list[tuple[str, bool]] | None = None) -> dict[str, Any]:
    """Pi models from RPC ``get_available_models`` (or ``--list-models`` rows as a fallback)."""
    order = [x for x in help_levels if x in PI_ORDER] or list(PI_ORDER)
    enabled = [str(m) for m in settings.get("enabledModels") or []]
    default = f"{settings['defaultProvider']}/{settings['defaultModel']}" if settings.get("defaultProvider") and settings.get("defaultModel") else ""
    efforts: dict[str, list[str]] = {}
    ids: list[str] = []
    if models:
        for m in models:
            key = f"{m.get('provider')}/{m.get('id')}"
            efforts[key] = pi_levels(m, order)
            ids.append(key)
    else:
        for key, thinking in listed or []:
            efforts[key] = pi_levels({"reasoning": thinking}, order)  # no level map: xhigh / max are not offered
            ids.append(key)
    all_models = list(dict.fromkeys([*enabled, *([default] if default else []), *ids]))
    efforts[""] = efforts.get(default, order)
    want = str(settings.get("defaultThinkingLevel") or "")

    def default_effort(model: str) -> str:
        avail = efforts.get(model)
        if not want or not avail:
            return ""
        return pi_clamp(want, avail, order)

    return {
        "default": default,
        "models": all_models,
        "featured": enabled or all_models[:6],
        "efforts": order,
        "modelEfforts": {k: v for k, v in efforts.items() if k in all_models or k == ""},
        "modelDefaultEffort": {m: default_effort(m) for m in [*all_models, ""]},
        "defaultEffort": default_effort(default or ""),
        "effortSource": "pi rpc get_available_models" if models else "pi --list-models",
    }


def codex_catalog_from(cache: dict[str, Any] | list[Any] | None, config: dict[str, Any]) -> dict[str, Any]:
    """Codex models from ``models_cache.json``; hidden models are left out unless configured."""
    default = str(config.get("model") or "")
    configured = str(config.get("model_reasoning_effort") or "")
    rows = cache.get("models", []) if isinstance(cache, dict) else cache or []
    # The picker order: Codex's own priority (lower first), stable for rows without one.
    rows = sorted((m for m in rows if isinstance(m, dict)), key=lambda m: m.get("priority") if isinstance(m.get("priority"), (int, float)) else 1e9)
    efforts: dict[str, list[str]] = {}
    model_default: dict[str, str] = {}
    models: list[str] = []
    for m in rows:
        slug = m.get("slug") if isinstance(m, dict) else None
        if not slug:
            continue
        levels = [str(x.get("effort") if isinstance(x, dict) else x) for x in m.get("supported_reasoning_levels") or []]
        efforts[slug] = levels
        model_default[slug] = str(m.get("default_reasoning_level") or "")
        if m.get("visibility") != "hide" or slug == default:
            models.append(str(slug))
    models = list(dict.fromkeys([*([default] if default else []), *models]))
    # "" = no -m: the first listed model is what the CLI picks (the cache is in priority order).
    efforts[""] = efforts.get(default) or (efforts.get(models[0]) if models else [])
    model_default[""] = model_default.get(default) or (model_default.get(models[0], "") if models else "")

    def default_effort(model: str) -> str:
        levels = efforts.get(model, [])
        if configured and configured in levels:
            return configured
        return model_default.get(model, "") if model_default.get(model, "") in levels else ""

    return {
        "default": default,
        "models": models,
        "featured": models[:6],
        "efforts": list(dict.fromkeys(x for m in models for x in efforts.get(m, []))),
        "modelEfforts": {k: v for k, v in efforts.items() if k in models or k == ""},
        "modelDefaultEffort": {m: default_effort(m) for m in [*models, ""]},
        "defaultEffort": default_effort(default),
        "effortSource": "codex models_cache.json" if rows else "none",
    }


def efforts_for(entry: dict[str, Any], model: str) -> list[str] | None:
    """The levels a catalog entry allows for ``model``; None when the model is not in the catalog."""
    per = entry.get("modelEfforts") or {}
    return per.get(model) if model in per else None


# ——— running the CLIs ———
def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _run(argv: list[str], env: dict[str, str], stdin: str | None = None, timeout: float = 20) -> str:
    if not shutil.which(argv[0]):
        return ""
    try:
        return subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout, env=env).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def claude_initialize(env: dict[str, str], timeout: float = 20) -> dict[str, Any] | None:
    """Ask Claude Code for its models the way the Agent SDK does; stop as soon as it answers."""
    if not shutil.which("claude"):
        return None
    argv = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]
    try:
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env, cwd=os.path.expanduser("~"))
    except OSError:
        return None
    try:
        assert p.stdin and p.stdout
        p.stdin.write(json.dumps({"type": "control_request", "request_id": "agora-init", "request": {"subtype": "initialize"}}) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            line = p.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "control_response":
                return msg
        return None
    except (OSError, ValueError):
        return None
    finally:
        p.kill()
        p.wait()


def pi_rpc_models(env: dict[str, str]) -> list[dict[str, Any]] | None:
    out = _run(["pi", "--mode", "rpc", "--no-session"], env, stdin=json.dumps({"id": "agora-models", "type": "get_available_models"}) + "\n")
    for line in out.splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("command") == "get_available_models" and msg.get("success"):
            return list(msg.get("data", {}).get("models") or [])
    return None


def pi_list_models(env: dict[str, str]) -> list[tuple[str, bool]]:
    rows = []
    for line in _run(["pi", "--list-models"], env).splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 5:
            rows.append((f"{parts[0]}/{parts[1]}", parts[4] == "yes"))
    return rows


def claude_catalog(env: dict[str, str]) -> dict[str, Any]:
    settings = _read_json(Path.home() / ".claude" / "settings.json")
    return claude_catalog_from(claude_initialize(env), settings, help_choices(_run(["claude", "--help"], env), "--effort"))


def pi_catalog(env: dict[str, str]) -> dict[str, Any]:
    settings = _read_json(Path.home() / ".pi" / "agent" / "settings.json")
    help_levels = help_choices(_run(["pi", "--help"], env), "--thinking")
    models = pi_rpc_models(env)
    return pi_catalog_from(models, settings, help_levels, None if models else pi_list_models(env))


def codex_catalog(env: dict[str, str]) -> dict[str, Any]:
    home = Path(env.get("CODEX_HOME") or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        config = tomllib.loads((home / "config.toml").read_text())
    except (OSError, tomllib.TOMLDecodeError):
        config = {}
    cache = _read_json(home / "models_cache.json") or None
    return codex_catalog_from(cache, config)


SOURCES: dict[str, Callable[[dict[str, str]], dict[str, Any]]] = {"pi": pi_catalog, "claude": claude_catalog, "codex": codex_catalog}
