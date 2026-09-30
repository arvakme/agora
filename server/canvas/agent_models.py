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
  yes/no) with the ``--help`` levels. Which models are offered is Pi's own scope: the
  ``enabledModels`` patterns (agent-dir ``settings.json``, replaced by a trusted project
  ``.pi/settings.json``) resolved against the available models; without them, every available
  (credentialed) model except non-interactive variants such as OpenRouter ``:batch``.
- **Codex** — ``~/.codex/models_cache.json``: ``supported_reasoning_levels`` and
  ``default_reasoning_level`` per model; ``config.toml`` ``model_reasoning_effort`` is the default
  where the model supports it. No cache → no effort choices (the CLI default is used).

Every catalog also carries ``names`` (friendly names), ``providers`` (Pi), ``allowed`` (what a
binding may use; None = unknown, not checked) and ``scope`` (where the list came from).

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
    names: dict[str, str] = {}
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
            if m.get("displayName"):
                names[value] = str(m["displayName"])
                if m.get("resolvedModel"):  # a configured full id (claude-opus-5-5) gets its alias's name
                    names.setdefault(str(m["resolvedModel"]), str(m["displayName"]))
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
    models = list(dict.fromkeys(models))
    # Featured: the configured model and the CLI's aliases (opus / sonnet / haiku …); pinned
    # versions (claude-opus-4-6 …) and custom names come after.
    featured = [m for m in models if m == default or not m.startswith("claude-")]
    return {
        "default": default,
        "models": models,
        "featured": featured,
        "names": names,
        "providers": {},
        # --model also takes the full ids the aliases resolve to; without initialize nothing is known.
        "allowed": list(dict.fromkeys([*models, *resolved.values()])) if entries else None,
        "scope": {"kind": "cli", "source": "claude initialize" if entries else "claude --help"},
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


# ——— Pi's model scope (``enabledModels``) ———
# A port of Pi 0.87.1's own rules (dist/core/model-resolver.js ``resolveModelScopeFromModels`` /
# ``parseModelPattern``, main.js ``buildSessionOptions``, settings-manager.js ``deepMergeSettings``,
# trust-manager.js). Patterns resolve against the models Pi reports as available — the ones whose
# provider has usable credentials — so a pattern can never bring in a model Pi could not run.

# Variants that make no sense in an interactive session (OpenRouter's asynchronous batch tier).
# They are left out of wide lists and globs; a pattern naming one exactly still keeps it.
NON_INTERACTIVE_SUFFIXES = (":batch",)


def interactive(model_id: str) -> bool:
    return not model_id.lower().endswith(NON_INTERACTIVE_SUFFIXES)


def _expand_braces(pattern: str) -> list[str]:
    m = re.search(r"\{([^{}]*,[^{}]*)\}", pattern)
    if not m:
        return [pattern]
    return [x for part in m.group(1).split(",") for x in _expand_braces(pattern[: m.start()] + part + pattern[m.end() :])]


def _glob_regex(pattern: str) -> re.Pattern[str]:
    """minimatch semantics Pi relies on: ``*`` / ``?`` stay inside one path segment, ``**``
    crosses segments, ``[...]`` is a class (``!`` negates), ``{a,b}`` expands; case-insensitive."""
    alts = []
    for pat in _expand_braces(pattern):
        out, i = "", 0
        while i < len(pat):
            c = pat[i]
            if pat.startswith("**", i):
                out += ".*"
                i += 2
                if pat.startswith("/", i):  # "**/" also matches no directory at all
                    out = out[:-2] + "(?:.*/)?"
                    i += 1
                continue
            if c == "*":
                out += "[^/]*"
            elif c == "?":
                out += "[^/]"
            elif c == "[" and "]" in pat[i + 2 :]:
                j = pat.index("]", i + 2)
                body = pat[i + 1 : j]
                if body.startswith("!"):
                    body = "^" + body[1:]
                out += "[" + body.replace("\\", "\\\\") + "]"
                i = j
            else:
                out += re.escape(c)
            i += 1
        alts.append(out)
    return re.compile("^(?:" + "|".join(alts) + ")$", re.IGNORECASE)


def _key(m: dict[str, Any]) -> str:
    return f"{m.get('provider')}/{m.get('id')}"


def pi_exact(ref: str, models: list[dict[str, Any]]) -> dict[str, Any] | None:
    """``findExactModelReferenceMatch``: ``provider/id`` or a bare id that is unambiguous."""
    ref = ref.strip()
    if not ref:
        return None
    low = ref.lower()
    canon = [m for m in models if _key(m).lower() == low]
    if len(canon) == 1:
        return canon[0]
    if len(canon) > 1:
        return None
    if "/" in ref:
        prov, mid = (x.strip() for x in ref.split("/", 1))
        if prov and mid:
            hits = [m for m in models if str(m.get("provider", "")).lower() == prov.lower() and str(m.get("id", "")).lower() == mid.lower()]
            if len(hits) == 1:
                return hits[0]
            if len(hits) > 1:
                return None
    ids = [m for m in models if str(m.get("id", "")).lower() == low]
    return ids[0] if len(ids) == 1 else None


def _is_alias(model_id: str) -> bool:
    return model_id.endswith("-latest") or not re.search(r"-\d{8}$", model_id)


def _try_match(pattern: str, models: list[dict[str, Any]]) -> dict[str, Any] | None:
    """``tryMatchModel``: exact, else id/name substring preferring aliases over dated ids."""
    hit = pi_exact(pattern, models)
    if hit:
        return hit
    low = pattern.lower()
    matches = [m for m in models if low in str(m.get("id", "")).lower() or low in str(m.get("name") or "").lower()]
    if not matches:
        return None
    aliases = [m for m in matches if _is_alias(str(m.get("id", "")))]
    pool = aliases or matches
    return sorted(pool, key=lambda m: str(m.get("id", "")), reverse=True)[0]


def _parse_pattern(pattern: str, models: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str | None]:
    """``parseModelPattern`` (scope mode): a trailing ``:<thinking>`` is a level, other suffixes are dropped."""
    hit = _try_match(pattern, models)
    if hit:
        return hit, None
    if ":" not in pattern:
        return None, None
    prefix, suffix = pattern.rsplit(":", 1)
    model, level = _parse_pattern(prefix, models)
    if model and suffix in PI_ORDER:
        return model, level or suffix
    return model, level


def pi_scope(patterns: list[str], models: list[dict[str, Any]]) -> list[tuple[dict[str, Any], str | None]]:
    """``resolveModelScopeFromModels``: the scoped models in pattern order, each with the thinking
    level its pattern pins (``provider/*:high``), duplicates dropped, unmatched patterns ignored."""
    out: list[tuple[dict[str, Any], str | None]] = []
    seen: set[str] = set()

    def add(m: dict[str, Any], level: str | None) -> None:
        if _key(m) not in seen:
            seen.add(_key(m))
            out.append((m, level))

    for pattern in patterns:
        if any(c in pattern for c in "*?["):
            glob, level = pattern, None
            if ":" in pattern and pattern.rsplit(":", 1)[1] in PI_ORDER:
                glob, level = pattern.rsplit(":", 1)
            exact = pi_exact(glob, models)
            if exact:
                add(exact, level)
                continue
            rx = _glob_regex(glob)
            for m in models:
                if (rx.match(_key(m)) or rx.match(str(m.get("id", "")))) and interactive(str(m.get("id", ""))):
                    add(m, level)
            continue
        model, level = _parse_pattern(pattern, models)
        if model:
            add(model, level)
    return out


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    """``deepMergeSettings``: objects merge key by key, anything else (arrays too) is replaced."""
    out = dict(base)
    for k, v in over.items():
        if v is None:
            continue
        out[k] = _deep_merge(out[k], v) if isinstance(out.get(k), dict) and isinstance(v, dict) else v
    return out


def pi_project_trusted(agent_dir: Path, project: Path, global_settings: dict[str, Any]) -> bool:
    """Pi's non-interactive trust decision (docs/security.md): the nearest saved decision in
    ``<agent-dir>/trust.json`` for the project or a parent, else ``defaultProjectTrust: "always"``."""
    saved = _read_json(agent_dir / "trust.json")
    d = Path(os.path.realpath(project))
    while True:
        v = saved.get(str(d))
        if v is True or v is False:
            return v
        if d.parent == d:
            break
        d = d.parent
    return global_settings.get("defaultProjectTrust") == "always"


def pi_settings(agent_dir: Path, project: Path | None) -> tuple[dict[str, Any], str]:
    """Pi's effective settings for ``project`` and the file ``enabledModels`` came from."""
    glob_path = agent_dir / "settings.json"
    settings = _read_json(glob_path)
    source = str(glob_path) if settings.get("enabledModels") else ""
    if project is not None:
        proj_path = project / ".pi" / "settings.json"
        if proj_path.is_file() and pi_project_trusted(agent_dir, project, settings):
            proj = _read_json(proj_path)
            if proj.get("enabledModels") is not None:
                source = str(proj_path) if proj.get("enabledModels") else ""
            settings = _deep_merge(settings, proj)
    return settings, source


def pi_catalog_from(
    models: list[dict[str, Any]] | None,
    settings: dict[str, Any],
    help_levels: list[str],
    listed: list[tuple[str, bool]] | None = None,
    source: str = "",
) -> dict[str, Any]:
    """Pi models from RPC ``get_available_models`` (or ``--list-models`` rows as a fallback).

    With ``enabledModels`` the list is exactly Pi's scope (the models its own model cycling goes
    through); without it, every available model except non-interactive variants."""
    order = [x for x in help_levels if x in PI_ORDER] or list(PI_ORDER)
    if models:
        available = [m for m in models if m.get("provider") and m.get("id")]
    else:
        available = [{"provider": k.split("/", 1)[0], "id": k.split("/", 1)[1], "name": "", "reasoning": t} for k, t in listed or [] if "/" in k]
    patterns = [str(p) for p in settings.get("enabledModels") or [] if str(p).strip()]
    saved = f"{settings['defaultProvider']}/{settings['defaultModel']}" if settings.get("defaultProvider") and settings.get("defaultModel") else ""
    per_model = settings.get("modelThinkingLevels") or {}
    want = str(settings.get("defaultThinkingLevel") or "")
    pinned: dict[str, str | None] = {}
    if patterns:
        scoped = pi_scope(patterns, available)
        chosen = [m for m, _ in scoped]
        pinned = {_key(m): lvl for m, lvl in scoped}
        keys = [_key(m) for m in chosen]
        # buildSessionOptions: the saved default when it is in scope, else the first scoped model.
        default = saved if saved in keys else (keys[0] if keys else "")
        featured = keys
    else:
        chosen = [m for m in available if interactive(str(m["id"]))]
        keys = [_key(m) for m in chosen]
        default = saved if saved in keys else ""
        featured = [default] if default else []
    efforts: dict[str, list[str]] = {_key(m): pi_levels(m, order) for m in chosen}
    efforts[""] = efforts.get(default, order)

    def default_effort(model: str) -> str:
        avail = efforts.get(model)
        level = pinned.get(model) or str(per_model.get(model) or "") or want
        if not level or not avail:
            return ""
        return pi_clamp(level, avail, order)

    return {
        "default": default,
        "models": keys,
        "featured": featured,
        "names": {_key(m): str(m.get("name") or "") for m in chosen if m.get("name")},
        "providers": {_key(m): str(m["provider"]) for m in chosen},
        "allowed": keys,
        "scope": {"kind": "enabledModels", "source": source, "patterns": patterns} if patterns else {"kind": "available", "source": "pi rpc get_available_models" if models else "pi --list-models"},
        "efforts": order,
        "modelEfforts": efforts,
        "modelDefaultEffort": {m: default_effort(m) for m in [*keys, ""]},
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
    names: dict[str, str] = {}
    slugs: list[str] = []
    models: list[str] = []
    for m in rows:
        slug = m.get("slug") if isinstance(m, dict) else None
        if not slug:
            continue
        levels = [str(x.get("effort") if isinstance(x, dict) else x) for x in m.get("supported_reasoning_levels") or []]
        efforts[slug] = levels
        slugs.append(str(slug))
        if m.get("display_name"):
            names[str(slug)] = str(m["display_name"])
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
        "names": {k: v for k, v in names.items() if k in models},
        "providers": {},
        # -m takes hidden slugs too; they are just not offered. No cache → nothing to check against.
        "allowed": list(dict.fromkeys([*models, *slugs])) if rows else None,
        "scope": {"kind": "cli", "source": "codex models_cache.json" if rows else "none"},
        "efforts": list(dict.fromkeys(x for m in models for x in efforts.get(m, []))),
        "modelEfforts": {k: v for k, v in efforts.items() if k in models or k == ""},
        "modelDefaultEffort": {m: default_effort(m) for m in [*models, ""]},
        "defaultEffort": default_effort(default),
        "effortSource": "codex models_cache.json" if rows else "none",
    }


def model_refusal(entry: dict[str, Any], model: str) -> str | None:
    """Why ``model`` is outside what this agent may run (None = fine). "" (the CLI default) always is."""
    allowed = entry.get("allowed")
    if not model or allowed is None or model in allowed:
        return None
    name = entry.get("name") or entry.get("kind") or "Agent"
    shown = entry.get("models") or []
    choices = "、".join(shown[:8]) + (f" 等 {len(shown)} 个" if len(shown) > 8 else "") if shown else "（没有可选模型）"
    scope = entry.get("scope") or {}
    if scope.get("kind") == "enabledModels":
        where = scope.get("source") or "Pi 设置"
        return f"{model} 不在 Pi 的 enabledModels 范围里（{where}）；可选：{choices}"
    if entry.get("kind") == "pi":
        return f"Pi 没有可用的模型 {model}（未配置凭据、不存在或不适合交互会话）；可选：{choices}"
    return f"{name} 的模型列表里没有 {model}；可选：{choices}"


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


def claude_catalog(env: dict[str, str], project: Path | None = None) -> dict[str, Any]:
    settings = _read_json(Path.home() / ".claude" / "settings.json")
    return claude_catalog_from(claude_initialize(env), settings, help_choices(_run(["claude", "--help"], env), "--effort"))


def pi_agent_dir(env: dict[str, str]) -> Path:
    """``getAgentDir``: ``PI_CODING_AGENT_DIR`` or ``~/.pi/agent``."""
    d = env.get("PI_CODING_AGENT_DIR")
    return Path(os.path.expanduser(d)) if d else Path.home() / ".pi" / "agent"


def pi_catalog(env: dict[str, str], project: Path | None = None) -> dict[str, Any]:
    settings, source = pi_settings(pi_agent_dir(env), project)
    help_levels = help_choices(_run(["pi", "--help"], env), "--thinking")
    models = pi_rpc_models(env)
    return pi_catalog_from(models, settings, help_levels, None if models else pi_list_models(env), source)


def codex_catalog(env: dict[str, str], project: Path | None = None) -> dict[str, Any]:
    home = Path(env.get("CODEX_HOME") or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        config = tomllib.loads((home / "config.toml").read_text())
    except (OSError, tomllib.TOMLDecodeError):
        config = {}
    cache = _read_json(home / "models_cache.json") or None
    return codex_catalog_from(cache, config)


SOURCES: dict[str, Callable[[dict[str, str], Path | None], dict[str, Any]]] = {"pi": pi_catalog, "claude": claude_catalog, "codex": codex_catalog}
