"""When an edit cannot be drawn on a page, find somewhere to draw it (BR2) — without asking the person to do anything.

In order, each step only when the one before did not work, and each one says so in the ``notes`` of the answer the agent gets (the
trajectory shows it): 1. the pages that are already open (``AgentHub.bridge``); 2. a page Agora opens itself (the system's open
command, at most once per two minutes per project, switch-off-able); 3. the server writes the canvas file itself (fallback.py: the
few ops that need no page). All three failing is an error that says what each one tried.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from server.canvas.fallback import NEEDS_PAGE

if TYPE_CHECKING:
    from server.canvas.sessions import AgentHub

OPEN_EVERY_S = 120.0  # a project's tabs are not opened more often than this
OPEN_WAIT_S = 15.0  # how long a page Agora just opened has to connect
OPENED_TIMEOUT_S = 12.0  # ... and to take the request once it has


def settings_file(hub: AgentHub):
    return hub.store.dir / "local" / "settings.json"


def auto_open_enabled(hub: AgentHub) -> bool:
    try:
        return bool(json.loads(settings_file(hub).read_text()).get("autoOpenPage", True))
    except (FileNotFoundError, json.JSONDecodeError, AttributeError):
        return True  # on by default


def set_auto_open(hub: AgentHub, on: bool) -> None:
    p = settings_file(hub)
    p.parent.mkdir(parents=True, exist_ok=True)
    (p.parent / ".gitignore").write_text("*\n") if not (p.parent / ".gitignore").exists() else None
    try:
        cur = json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        cur = {}
    p.write_text(json.dumps({**cur, "autoOpenPage": bool(on)}) + "\n")


def page_url(hub: AgentHub) -> str | None:
    try:
        return str(json.loads((hub.store.run_dir / "server.json").read_text()).get("url") or "") or None
    except (FileNotFoundError, json.JSONDecodeError, AttributeError):
        return None


def default_opener(url: str) -> None:
    """The system's open command (macOS ``open``, elsewhere ``xdg-open``)."""
    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)


def _steps(notes: list[str]) -> str:
    return "；".join(notes)


async def edit(hub: AgentHub, kind: str, payload: dict[str, Any], fallback: Callable[[], Awaitable[dict[str, Any]]] | None = None) -> dict[str, Any]:
    from server.canvas.sessions import NoPage, PageTookIt

    notes: list[str] = []

    def done(result: dict[str, Any]) -> dict[str, Any]:
        return {**result, "notes": notes} if notes else result

    # 1. the pages that are open
    try:
        return await hub.bridge(kind, payload, timeout=hub.bridge_timeout_s, reply_s=hub.page_reply_s)
    except PageTookIt:
        raise  # a page took it: the edit may already be on its canvas — never a second copy from somewhere else
    except NoPage as e:
        n = len(hub.executors())
        notes.append("没有打开的 Agora 页面" if not n else f"开着的页面（{n} 个）都没有认领这次改图（各等了 {hub.page_reply_s:g} 秒）")
        del e

    # 2. a page of our own
    if not auto_open_enabled(hub):
        notes.append("自动打开页面被你在偏好里关掉了")
    elif hub.opener is None or page_url(hub) is None:
        notes.append("这台机器上没法自动打开页面（没有打开命令或项目地址）")
    elif hub._last_open is not None and hub.clock() - hub._last_open < OPEN_EVERY_S:
        notes.append("两分钟内已经自动打开过一次页面，这次不再打开")
    else:
        url = page_url(hub) or ""
        before = {s.id for s in hub.subs}
        try:
            hub.opener(url)
        except Exception as e:  # no open command, no desktop
            notes.append(f"想自己打开页面没有成功：{e}")
        else:
            hub._last_open = hub.clock()
            loop = asyncio.get_running_loop()
            end = loop.time() + hub.open_wait_s
            while loop.time() < end and not any(s.id not in before and s.executor for s in hub.subs):
                await asyncio.sleep(0.05)
            if not any(s.id not in before and s.executor for s in hub.subs):
                notes.append(f"自己打开了页面 {url}，等了 {hub.open_wait_s:g} 秒它没有连上来")
            else:
                notes.append(f"自己打开了页面 {url}，新页面连上来了")
                try:
                    return done(await hub.bridge(kind, payload, timeout=min(OPENED_TIMEOUT_S, hub.bridge_timeout_s), reply_s=hub.page_reply_s))
                except PageTookIt:
                    raise
                except NoPage:
                    notes.append("新页面没有认领这次改图")

    # 3. the server writes the file itself
    if fallback is not None:
        notes.append("改由服务端直接改画布文件")
        result = await fallback()
        if result.get("status") == "needs-page":
            result["errors"] = [f"{result['errors'][0]}（已经试过：{_steps(notes)}）"]
        return done(result)
    notes.append(f"服务端直接改文件也做不了这一种：{NEEDS_PAGE}")
    raise NoPage(f"改图没能落下。已经试过：{_steps(notes)}。请把 Agora 页面切到前台再试一次（或先 `agora open`）。")
