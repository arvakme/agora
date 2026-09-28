"""Transcript items behind the session trajectory and the progress pointer: files a tool call
writes (per CLI log format), per-request usage, turn ends with durations, model / effort
context; the hub's previews + full items, runner usage for headless turns; and
`agora canvas link` through the bridge. Record shapes are taken from real 2026-09 logs of
Claude Code 2.1, Pi and Codex (trimmed)."""

import asyncio
import json

import pytest

from server.canvas.model_view import model_view
from server.canvas.sessions import PREVIEW, AgentHub, NoPage, public_item
from server.canvas.transcript import State, project, rel_path
from tests.test_agent_sessions import FakeBackend, agora, drain, store  # noqa: F401 (fixture)

ROOT = "/work/proj"


def run(kind, recs, root=ROOT):
    st = State(root=root)
    items: dict[str, dict] = {}
    for r in recs:
        its, _ = project(kind, r, st)
        for it in its:
            prev = items.get(it["id"], {})
            if it["kind"] == "tool" and prev:
                items[it["id"]] = {**prev, **{k: v for k, v in it.items() if k != "tool"}, "tool": {**prev.get("tool", {}), **it.get("tool", {})}, "at": prev["at"]}
            else:
                items[it["id"]] = {**prev, **it}
    return list(items.values()), st


def by_kind(items, kind):
    return [i for i in items if i["kind"] == kind]


def test_rel_path():
    assert rel_path("/work/proj/server/app.py", ROOT) == "server/app.py"
    assert rel_path("server/app.py", ROOT) == "server/app.py"
    assert rel_path("./web/x.ts", ROOT) == "web/x.ts"
    assert rel_path("/elsewhere/x.py", ROOT) == "/elsewhere/x.py"


CLAUDE = [
    {"type": "user", "uuid": "u1", "timestamp": "2026-09-28T10:00:00Z", "message": {"role": "user", "content": "改一下 server"}},
    # One API message, written as one record per content block, each with the same usage.
    {"type": "assistant", "uuid": "a1", "timestamp": "2026-09-28T10:00:02Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "text", "text": "我先改 app.py。"}], "usage": {"input_tokens": 5, "output_tokens": 40, "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 300}, "stop_reason": None}},
    {"type": "assistant", "uuid": "a2", "timestamp": "2026-09-28T10:00:03Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/work/proj/server/app.py", "old_string": "a", "new_string": "b"}}], "usage": {"input_tokens": 5, "output_tokens": 40, "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 300}, "stop_reason": "tool_use"}},
    {"type": "user", "uuid": "r1", "timestamp": "2026-09-28T10:00:04Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "The file has been updated." + "x" * (PREVIEW + 50)}]}},
    {"type": "assistant", "uuid": "a3", "timestamp": "2026-09-28T10:00:05Z", "message": {"id": "msg_2", "model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "tool_use", "id": "t2", "name": "Write", "input": {"file_path": "/work/proj/README.md", "content": "hi"}}], "usage": {"input_tokens": 2, "output_tokens": 10}, "stop_reason": "tool_use"}},
    {"type": "user", "uuid": "r2", "timestamp": "2026-09-28T10:00:06Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": "denied", "is_error": True}]}},
    {"type": "assistant", "uuid": "a4", "timestamp": "2026-09-28T10:00:08Z", "message": {"id": "msg_3", "model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "text", "text": "改好了。"}], "usage": {"input_tokens": 1, "output_tokens": 5}, "stop_reason": "end_turn"}},
    {"type": "system", "subtype": "turn_duration", "durationMs": 8123, "uuid": "d1", "timestamp": "2026-09-28T10:00:08.2Z", "isMeta": False},
]


def test_claude_files_usage_and_turn_end():
    items, st = run("claude", CLAUDE)
    tools = by_kind(items, "tool")
    edit = next(t for t in tools if t["id"] == "t1")
    assert edit["tool"]["files"] == [{"path": "server/app.py", "op": "edit"}]
    assert edit["msg"] == "msg_1" and edit["endAt"] > edit["at"]
    assert json.loads(edit["tool"]["args"])["new_string"] == "b"  # full input, not only the one-line summary
    assert edit["tool"]["input"] == "/work/proj/server/app.py"
    write = next(t for t in tools if t["id"] == "t2")
    assert write["tool"]["files"] == [{"path": "README.md", "op": "write"}] and write["tool"]["isError"] is True
    usage = by_kind(items, "usage")
    assert [u["id"] for u in usage] == ["u-msg_1", "u-msg_2", "u-msg_3"]  # repeated blocks collapse
    assert usage[0]["usage"] == {"model": "claude-opus-5-5", "inputTokens": 5, "outputTokens": 40, "cacheReadTokens": 9000, "cacheWriteTokens": 300, "costUsd": None}
    [end] = by_kind(items, "end")
    assert end["turn"] == "u1" and end["durationMs"] == 8123 and not st.busy
    said = by_kind(items, "assistant")
    assert said[0]["msg"] == "msg_1"


def test_public_item_cuts_previews_and_keeps_full_length():
    items, _ = run("claude", CLAUDE)
    edit = next(t for t in items if t["id"] == "t1")
    pub = public_item(edit)
    assert len(pub["tool"]["output"]) == PREVIEW and pub["tool"]["outputLen"] == len(edit["tool"]["output"])
    assert "argsLen" not in pub["tool"]
    assert edit["tool"]["output"].endswith("x")  # the hub keeps the whole thing


PI = [
    {"type": "model_change", "id": "m1", "timestamp": "2026-09-28T10:00:00Z", "provider": "magpie", "modelId": "group/opus-5-5"},
    {"type": "thinking_level_change", "id": "k1", "timestamp": "2026-09-28T10:00:00Z", "thinkingLevel": "high"},
    {"type": "message", "id": "p1", "timestamp": "2026-09-28T10:00:01Z", "message": {"role": "user", "timestamp": 1790560801000, "content": [{"type": "text", "text": "改 web"}]}},
    {"type": "message", "id": "p2", "timestamp": "2026-09-28T10:00:05Z", "message": {"role": "assistant", "provider": "magpie", "model": "group/opus-5-5", "timestamp": 1790560802000, "stopReason": "toolUse", "usage": {"input": 100, "output": 20, "cacheRead": 50, "cacheWrite": 0, "cost": {"total": 0.0123}}, "content": [
        {"type": "toolCall", "id": "c1", "name": "edit", "arguments": {"path": "/work/proj/web/src/App.tsx", "edits": [{"oldText": "a", "newText": "b"}]}},
        {"type": "toolCall", "id": "c2", "name": "write", "arguments": {"path": "notes/todo.md", "content": "x"}},
    ]}},
    {"type": "message", "id": "p3", "timestamp": "2026-09-28T10:00:06Z", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "edit", "isError": False, "content": [{"type": "text", "text": "ok"}]}},
    {"type": "message", "id": "p4", "timestamp": "2026-09-28T10:00:06Z", "message": {"role": "toolResult", "toolCallId": "c2", "toolName": "write", "isError": False, "content": [{"type": "text", "text": "ok"}]}},
    {"type": "message", "id": "p5", "timestamp": "2026-09-28T10:00:09Z", "message": {"role": "assistant", "provider": "magpie", "model": "group/opus-5-5", "timestamp": 1790560807000, "stopReason": "stop", "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.001}}, "content": [{"type": "text", "text": "好了"}]}},
]


def test_pi_files_context_usage():
    items, _ = run("pi", PI)
    ctx = by_kind(items, "context")
    assert {c.get("model") for c in ctx} >= {"magpie/group/opus-5-5"} and any(c.get("effort") == "high" for c in ctx)
    files = [f for t in by_kind(items, "tool") for f in t["tool"].get("files", [])]
    assert files == [{"path": "web/src/App.tsx", "op": "edit"}, {"path": "notes/todo.md", "op": "write"}]
    usage = by_kind(items, "usage")
    assert usage[0]["usage"]["costUsd"] == 0.0123 and usage[0]["usage"]["model"] == "magpie/group/opus-5-5"
    assert len(by_kind(items, "end")) == 1


CODEX = [
    {"timestamp": "2026-09-28T10:00:00Z", "type": "event_msg", "payload": {"type": "task_started", "turn_id": "T1"}},
    {"timestamp": "2026-09-28T10:00:00Z", "type": "turn_context", "payload": {"turn_id": "T1", "model": "gpt-6-sol", "effort": "xhigh", "cwd": "/work/proj"}},
    {"timestamp": "2026-09-28T10:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "T1", "item": {"type": "UserMessage", "id": "um1", "content": [{"type": "text", "text": "改 db"}]}}},
    {"timestamp": "2026-09-28T10:00:03Z", "type": "token_usage_record", "payload": {"turn_id": "T1", "response_id": "resp_1", "usage": {"input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 50}}},
    {"timestamp": "2026-09-28T10:00:03Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 50}}}},
    {"timestamp": "2026-09-28T10:00:04Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "T1", "started_at_ms": 1790560803500, "completed_at_ms": 1790560804000, "item": {"type": "CommandExecution", "id": "ex1", "command": ["/bin/zsh", "-lc", "ls db"], "status": "completed", "exit_code": 0, "stdout": "schema.sql\n"}}},
    {"timestamp": "2026-09-28T10:00:05Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "T1", "item": {"type": "FileChange", "id": "fc1", "status": "completed", "changes": {"/work/proj/db/schema.sql": {"type": "update", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n"}, "/work/proj/db/new.sql": {"type": "add", "content": "x"}}}}},
    {"timestamp": "2026-09-28T10:00:07Z", "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "T1", "last_agent_message": "好了", "duration_ms": 7000}},
]


def test_codex_file_change_usage_and_context():
    items, _ = run("codex", CODEX)
    ctx = by_kind(items, "context")[0]
    assert ctx["model"] == "gpt-6-sol" and ctx["effort"] == "xhigh"
    [u] = by_kind(items, "usage")  # token_count is skipped once per-response records exist
    assert u["usage"]["inputTokens"] == 200 and u["usage"]["cacheReadTokens"] == 800
    fc = next(t for t in by_kind(items, "tool") if t["id"] == "fc1")
    assert fc["tool"]["name"] == "apply_patch" and fc["tool"]["files"] == [{"path": "db/schema.sql", "op": "edit"}, {"path": "db/new.sql", "op": "add"}]
    assert "+b" in fc["tool"]["args"]
    ex = next(t for t in by_kind(items, "tool") if t["id"] == "ex1")
    assert ex["tool"]["output"] == "schema.sql\n" and ex["endAt"] - ex["at"] == 500
    [end] = by_kind(items, "end")
    assert end["durationMs"] == 7000 and end["turn"] == "T1"


def test_model_view_carries_code_paths():
    els = [
        {"id": "srv", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "customData": {"codePaths": ["server/**"]}},
        {"id": "f", "type": "frame", "name": "Web", "x": 0, "y": 0, "width": 10, "height": 10, "customData": {"codePaths": ["web/**"]}},
        {"id": "plain", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10},
    ]
    v = model_view(els)
    assert v["nodes"][0]["codePaths"] == ["server/**"] and "codePaths" not in v["nodes"][1]
    assert v["frames"][0]["codePaths"] == ["web/**"]


# ——— hub ———
async def test_hub_items_in_full_and_runner_usage(store, tmp_path, monkeypatch):  # noqa: F811
    log = tmp_path / "claude-log.jsonl"
    log.write_text("\n".join(json.dumps(r) for r in CLAUDE) + "\n")
    from server.canvas.agents import LogLookup

    monkeypatch.setattr("server.canvas.agents.locate_log", lambda kind, nid, root=None, home=None: LogLookup("found", log, (log,)) if nid else LogLookup("missing"))

    class Costly(FakeBackend):
        async def run(self, req):
            yield {"t": "result", "at": 3, "raw": "ok", "usage": {"model": "claude-opus-5-5", "inputTokens": 8, "outputTokens": 55, "cacheReadTokens": 9000, "cacheWriteTokens": 300, "durationMs": 8000, "costUsd": 0.42}, "session": "n-1"}

    hub = AgentHub(store, backend_factory=lambda kind: Costly([]))
    store.bind("s-1", agent="claude", model="opus", effort="high", native_id="n-1")
    sub = hub.subscribe(executor=False)
    try:
        first = [e for e in [sub.q.get_nowait() for _ in range(sub.q.qsize())] if e["t"] == "transcript" and e.get("reset")][0]
        t1 = next(i for i in first["items"] if i["id"] == "t1")
        assert t1["tool"]["outputLen"] > PREVIEW and len(t1["tool"]["output"]) == PREVIEW
        full = hub.item("s-1", "t1")
        assert len(full["tool"]["output"]) == t1["tool"]["outputLen"]
        with pytest.raises(LookupError):
            hub.item("s-1", "nope")
        hub.send("s-1", "再来")
        evs = await drain(sub.q, lambda e: e.get("t") == "done")
        runs = [i for e in evs if e["t"] == "transcript" for i in e["items"] if i["kind"] == "run"]
        assert runs and runs[0]["usage"]["costUsd"] == 0.42
        saved = (store.run_dir / "usage" / "s-1.jsonl").read_text()
        assert '"costUsd": 0.42' in saved
        # A restarted server still has it.
        again = AgentHub(store)
        s2 = again.subscribe(executor=False)
        reset = [e for e in [s2.q.get_nowait() for _ in range(s2.q.qsize())] if e["t"] == "transcript" and e.get("reset")][0]
        assert any(i["kind"] == "run" for i in reset["items"])
        await again.close()
    finally:
        await hub.close()


async def test_canvas_link_goes_through_the_page(store):  # noqa: F811
    hub = AgentHub(store)
    with pytest.raises(NoPage):
        await hub.canvas_link(None, None, {"redis": ["server/**"]})
    page = hub.subscribe(executor=True)

    async def act():
        req = (await drain(page.q, lambda e: e.get("t") == "bridge"))[-1]
        assert req["kind"] == "link" and req["canvasId"] == "c1" and req["links"] == {"Redis": ["server/**", "db/*.sql"]} and req["clear"] is False
        hub.bridge_result(req["rid"], {"status": "linked", "linked": [{"id": "redis", "label": "Redis", "codePaths": ["server/**", "db/*.sql"]}]})

    task = asyncio.create_task(act())
    res = await hub.canvas_link(None, "s-1", {"Redis": ["server/**", " db/*.sql ", ""]})
    await task
    assert res["status"] == "linked"
    with pytest.raises(ValueError, match="no globs"):
        await hub.canvas_link(None, None, {"Redis": []})


def test_link_cli_needs_the_server(store):  # noqa: F811
    r = agora("canvas", "link", "Redis", "server/**", cwd=store.root)
    assert r.returncode == 3 and "agora open" in json.loads(r.stdout)["error"]
