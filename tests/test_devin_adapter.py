"""Devin (``devin`` CLI) as an observed agent (T2): its sessions live in one SQLite database, read-only.
The CLI saves every message as a node of a forest (an assistant message twice, recent messages again
after a compaction), so a session's log is its distinct messages in time order; sub-agent chains are
left out. Seedmux workers are linked to their ticket when the session was given it
(web/docs/cli-adapters.md)."""

import hashlib
import time

import pytest

from server.canvas import adapters
from server.canvas.adapters import drift, runs
from server.canvas.adapters.common import State
from server.canvas.transcript import project
from tests.native_logs import DevinSession, devin_db

CWD = "/work/p"
T0 = 1790500000000  # ms


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    return h


def devin():
    return adapters.need("devin")


def worker_session(home, sid="brisk-otter", cwd=CWD, ticket="T-aaa111", t0=T0) -> DevinSession:
    s = DevinSession(home, sid, cwd, t0)
    s.system(0, "sys-1")
    s.system(0.1, "sys-2")
    s.user(0.2, "u-1", f"你是 Seedmux agent team 的 worker,任务 {ticket}。先读 /h/.seedmux/team/tasks/{ticket}/prompt.md")
    s.call(3, "a-1", [("call_r", "read", {"file_path": f"{cwd}/alpha.txt"})])
    s.result(3.1, "t-1", "call_r", "alpha")
    s.call(6, "a-2", [("call_x", "exec", {"command": "cat beta.txt", "workdir": cwd})])
    s.result(6.2, "t-2", "call_x", "beta", took_s=0.5)
    s.call(9, "a-3", [("call_w", "write", {"file_path": f"{cwd}/gamma.txt", "content": "alpha beta"}), ("call_s", "exec", {"command": f"smx-team reply {ticket} --status done"})])
    s.result(9.1, "t-3", "call_w", "wrote gamma.txt")
    s.result(9.2, "t-4", "call_s", "ok")
    s.reply(12, "a-4", "done")
    return s


def test_devin_is_observed_only():
    a = devin()
    assert adapters.implemented_tier(a) == "T2" and a.max_tier == "T2" and "devin" not in adapters.session_kinds()
    assert adapters.by_seedmux_name("devin") is a


def test_a_session_is_its_distinct_messages_in_time_order(home):
    s = worker_session(home)
    # A compaction: a summary, then the last messages again under a new root (same message ids).
    s.head = None
    s.system(12.5, "sys-summary")
    s.reply(12, "a-4", "done")
    path = s.save()
    recs = devin().read_records(path)
    assert [r["message_id"] for r in recs] == ["sys-1", "sys-2", "u-1", "a-1", "t-1", "a-2", "t-2", "a-3", "t-3", "t-4", "a-4", "sys-summary"]


def test_projection(home):
    path = worker_session(home).save()
    tl = runs.timeline("devin", path, CWD)
    items = {i["id"]: i for i in tl["items"]}
    tools = {i["id"]: i for i in items.values() if i["kind"] == "tool"}
    assert (tools["call_r"]["tool"]["activity"], tools["call_r"]["tool"]["reads"]) == ("read", ["alpha.txt"])
    assert (tools["call_x"]["tool"]["activity"], tools["call_x"]["tool"]["reads"]) == ("read", ["beta.txt"])
    assert tools["call_w"]["tool"]["files"] == [{"path": "gamma.txt", "op": "write"}] and tools["call_w"]["tool"]["activity"] == "write"
    assert tools["call_x"]["endAt"] - tools["call_x"]["at"] >= 500 and tools["call_r"]["tool"]["output"] == "alpha"
    users = [i for i in items.values() if i["kind"] == "user"]
    assert len(users) == 1 and users[0]["at"] == T0 + 200
    assert any(i["kind"] == "end" for i in items.values()) and not tl["busy"]
    usage = [i for i in items.values() if i["kind"] == "usage"]
    assert usage and usage[0]["usage"]["model"] == "swe-2-medium" and usage[0]["usage"]["inputTokens"] == 900 and usage[0]["usage"]["cacheReadTokens"] == 8000
    assert "timesInferred" not in tl
    assert [(x["kind"], x.get("path")) for x in tl["segments"]] == [("read", "alpha.txt"), ("read", "beta.txt"), ("write", "gamma.txt"), ("exec", None)]


def test_context_messages_do_not_start_turns(home):
    s = worker_session(home)
    s.user(13, "u-footer", "<system-reminder>cache footer</system-reminder>", typed=False)
    s.reply(14, "a-5", "still done")
    st = State(root=CWD)
    turns = []
    for rec in devin().read_records(s.save()):
        turns += project("devin", rec, st)[1]
    assert [t["turn"] for t in turns].count("start") == 1


def test_sub_agent_chains_are_not_the_main_log(home):
    s = worker_session(home)
    main_head = s.head
    s.head = 1  # a sub-agent's own chain, branching off the system prefix
    s.user(4, "sub-u", "subagent task", typed=False)
    s.call(5, "sub-a", [("call_sub", "write", {"file_path": f"{CWD}/sub.txt", "content": "x"})])
    s.agent_heads["explore-1"] = s.head
    s.head = main_head
    ids = [r["message_id"] for r in devin().read_records(s.save())]
    assert "sub-a" not in ids and "sub-u" not in ids and "a-4" in ids


def test_locate_and_sessions_are_read_only(home):
    a = devin()
    path = worker_session(home).save()
    worker_session(home, sid="other-dir", cwd="/work/q").save()
    db = devin_db(home)
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    assert a.locate("brisk-otter", CWD, home).path == path
    assert a.locate("nope-nope", CWD, home).state == "missing"
    for bad in ("../x", "*", "a/b", "", None):
        assert a.locate(bad, CWD, home).state == "missing"
    assert [(r["nativeId"], r["cwd"]) for r in a.sessions_for([CWD], home)] == [("brisk-otter", CWD)]
    assert a.log_cwd(path) == CWD
    assert a.log_format(path) == "17"
    runs.timeline("devin", path, CWD)
    assert hashlib.sha256(db.read_bytes()).hexdigest() == before


def test_seedmux_worker_is_found_by_its_ticket(home):
    a = devin()
    created = time.time() - 600
    t0 = int(created * 1000) + 5000
    worker_session(home, t0=t0).save(last_s=60)
    # Same directory, same time, but it only printed the ticket (a dispatcher): not the worker.
    d = DevinSession(home, "loud-dispatcher", CWD, t0)
    d.user(0, "du", "派一个 devin worker")
    d.call(1, "da", [("call_d", "exec", {"command": "smx-team spawn --agent devin"})])
    d.result(1.5, "dt", "call_d", "task=T-aaa111 pane=FDC89E5E-61FD-454D-A822-C01693AE47F2")
    d.save(last_s=60)
    rc = {"taskId": "T-aaa111", "cwd": CWD, "createdAt": int(created * 1000), "agent": "devin"}
    nid, path, why = a.worker_for_ticket(rc)
    assert nid == "brisk-otter" and path == devin_db(home) / "brisk-otter" and "T-aaa111" in why
    assert a.worker_for_ticket({**rc, "taskId": "T-bbb222"}) is None
    assert a.worker_for_ticket({**rc, "cwd": "/work/other"}) is None
    # A session that ended before the ticket was created cannot be its worker.
    assert a.worker_for_ticket({**rc, "createdAt": int((created + 3600) * 1000)}) is None


def test_drift_scans_the_database_log(home):
    a = devin()
    s = worker_session(home)
    s.node({"message_id": "x-1", "role": "developer", "content": "new role", "metadata": {"created_at": "2026-09-28T01:00:00Z"}})
    path = s.save()
    assert drift.scan(a, path)["unknown"] == {"developer": 1}
    got = drift.probe(a, home=home, with_version=False)
    assert got["sampled"]["logs"] == 1 and got["sampled"]["records"] >= 10 and got["logFormats"] == {"17": 1} and got["unknown"] == {"developer": 1}


def test_timeline_follows_the_database(home):
    """The log is rows, not a file: the run timeline's cache and "running" come from the session row."""
    s = worker_session(home, t0=int(time.time() * 1000) - 20_000)
    path = s.save(last_s=15)
    first = runs.timeline("devin", path, CWD)
    assert runs.timeline("devin", path, CWD) is first  # unchanged: served from the cache
    s.call(16, "a-9", [("call_9", "read", {"file_path": f"{CWD}/delta.txt"})])
    s.save(last_s=17)
    again = runs.timeline("devin", path, CWD)
    assert again is not first and again["segments"][-1]["path"] == "delta.txt"
    run = runs.run_of(runs.NativeRef("devin", "brisk-otter", path, CWD), CWD, depth=0)
    assert run["state"] == "running"  # the session was written to seconds ago
