"""The dispatch record format (server/canvas/dispatch_store.py): one sample file, a read/write round trip,
atomic files, and the state a record stands for."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from native_protocol import DeliveryRequest, NativeEvent, NativeSession, RequestOrigin, apply, hand_off, mark_uncertain, start, withdraw
from server.canvas.dispatch_store import FORMAT, Dispatch, DispatchStore, derive_state, from_json, is_final, to_json

SAMPLE = Path(__file__).parent / "fixtures" / "dispatch" / "sample.json"
RID = "0d5f6a1e-7b3c-4c1f-9a52-3e8d2b6c4f10"


def make(**kw) -> Dispatch:
    ns = UUID("6f0b1e52-3a7c-4d1e-9b8a-2c5d7e9f0a13")
    req = DeliveryRequest(
        request_id=UUID(RID),
        origin=RequestOrigin(room_id=ns, request_seq=1, requested_by=ns),
        session=NativeSession(deployment="/work/p", participant_id=ns, computer_id=ns, adapter="codex", tmux_target="agora-s-b", native_locator="s-b"),
        body="[Agora 派发 0d5f6a1e] 来自 Claude Code 会话 s-a：先读任务文件 /work/p/.agora/dispatch/x/task.md。",
    )
    return Dispatch(
        id=RID,
        delivery=start(req),
        task={"summary": "在 notes.md 末尾加一行", "scope": ["notes.md"], "file": "task.md", "inline": False},
        source={"kind": "session", "sessionId": "s-a"},
        target={"sessionId": "s-b", "agent": "codex", "new": True},
        permission={"mode": "user-config", "detail": "codex exec / codex: the user's own Codex configuration"},
        created_at=1790000000000,
        updated_at=1790000000000,
        **kw,
    )


def ev(kind: str, turn: str | None = "u1", summary: str = "", id: UUID | None = None) -> NativeEvent:
    return NativeEvent(event_id=id or uuid4(), kind=kind, evidence="native_record", session="s-b", turn_id=turn, summary=summary)


def test_the_sample_file_is_what_the_code_writes_and_reads(tmp_path):
    d = make()
    d.delivery = hand_off(d.delivery)
    d.delivery = apply(d.delivery, ev("input_accepted", id=UUID("a1111111-0000-4000-8000-000000000001"))).record
    d.delivery = apply(d.delivery, ev("execution_completed", summary="已加一行", id=UUID("a1111111-0000-4000-8000-000000000002"))).record
    d.reply = {"status": "done", "at": 1790000030000, "summary": "已在 notes.md 末尾加了一行", "file": "reply.md"}
    d.history = [{"at": 1790000000000, "state": "dispatched"}, {"at": 1790000010000, "state": "running"}, {"at": 1790000030000, "state": "done"}]
    d.notified = "done"
    obj = to_json(d)
    assert obj["format"] == FORMAT and obj["state"] == "done"
    sample = json.loads(SAMPLE.read_text())
    assert obj == sample
    back = from_json(json.loads(SAMPLE.read_text()))
    assert derive_state(back) == "done" and back.delivery.turn_state == "completed" and back.delivery.result.summary == "已加一行"


def test_round_trip_through_files_is_atomic_and_complete(tmp_path):
    store = DispatchStore(tmp_path)
    d = make()
    d.delivery = withdraw(mark_uncertain(hand_off(d.delivery), "restarted"), "interrupted by the source")
    d.stopped = {"at": 1, "how": "headless run cancelled"}
    store.write(d)
    store.write_text(RID, "task.md", "加一行\n")
    assert store.read_text(RID, "task.md") == "加一行\n" and store.read_text(RID, "reply.md") is None
    back = store.read(RID)
    assert back == d
    assert [p.name for p in (tmp_path / "dispatch").iterdir() if p.is_file()] == [f"{RID}.json"]  # no temp files left
    assert [x.id for x in store.all()] == [RID]
    (tmp_path / "dispatch" / f"{RID}.json").write_text("{not json")
    assert store.read(RID) is None
    with pytest.raises(ValueError):
        store.folder("../escape")
    with pytest.raises(ValueError):
        from_json({**to_json(d), "format": 99})


@pytest.mark.parametrize(
    "steps,reply,expects,want",
    [
        ([], None, True, "dispatched"),  # pending: queued
        (["hand_off"], None, True, "dispatched"),  # in flight: handed over, not seen yet
        (["hand_off", "accept"], None, True, "running"),
        (["hand_off", "accept", "permission"], None, True, "waiting"),
        (["hand_off", "accept", "complete"], None, True, "idle_no_reply"),  # the turn ended, nothing was handed back
        (["hand_off", "accept", "complete"], "done", True, "done"),
        (["hand_off", "accept", "complete"], "failed", True, "failed"),
        (["hand_off", "accept", "complete"], "blocked", True, "blocked"),
        (["hand_off", "accept"], "done", True, "running"),  # a receipt alone is a claim: wait for the turn's end
        (["hand_off", "accept", "fail"], None, True, "failed"),
        (["hand_off", "accept", "complete"], None, False, "done"),  # a comment: the turn's answer is the reply
        (["hand_off", "uncertain"], None, True, "unknown"),
        (["hand_off", "accept", "withdraw"], None, True, "unknown"),  # withdrawn but the turn still runs: not claimed stopped
        (["hand_off", "accept", "withdraw", "complete"], "done", True, "interrupted"),  # the late result is evidence, not a result
        (["withdraw"], None, True, "interrupted"),  # never handed over
    ],
)
def test_the_state_is_a_pure_function_of_the_record(steps, reply, expects, want):
    d = make(expects_reply=expects)
    r = d.delivery
    for s in steps:
        r = {
            "hand_off": hand_off,
            "accept": lambda r: apply(r, ev("input_accepted")).record,
            "permission": lambda r: apply(r, ev("permission_wait", turn=None)).record,
            "complete": lambda r: apply(r, ev("execution_completed", summary="ok")).record,
            "fail": lambda r: apply(r, ev("execution_failed", summary="boom")).record,
            "uncertain": lambda r: mark_uncertain(r, "lost"),
            "withdraw": withdraw,
        }[s](r)
    d = replace(d, delivery=r, reply={"status": reply, "at": 1, "summary": "", "file": "reply.md"} if reply else None)
    assert derive_state(d) == want
    assert is_final(want) == (want in ("done", "failed", "blocked", "idle_no_reply", "interrupted"))


def test_a_delivery_error_or_a_stopped_headless_run_decide_the_state():
    assert derive_state(make(error="log gone")) == "failed"
    assert derive_state(make(stopped={"at": 1, "how": "headless run cancelled"})) == "interrupted"


# ——— RVF-C: robustness of the store ———
def test_an_id_with_a_trailing_newline_is_not_an_id(tmp_path):
    files = DispatchStore(tmp_path)
    with pytest.raises(ValueError):
        files.folder(RID + "\n")
    files.folder(RID)  # the real one still is


def test_a_record_with_a_wrong_field_type_is_skipped_not_fatal(tmp_path):
    files = DispatchStore(tmp_path)
    files.write(make())
    other = "1e2f3a4b-0000-4000-8000-000000000001"
    bad = to_json(make())
    bad.update(id=other, delivery=5)  # a hand-edited or damaged record: `.get` on an int
    (tmp_path / "dispatch" / f"{other}.json").write_text(json.dumps(bad))
    assert [d.id for d in files.all()] == [RID]  # the good one is listed, the broken one is not fatal
    assert files.read(other) is None
