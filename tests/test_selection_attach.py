"""The selection sent with a chat message: saved beside the project as a picture (svg for the page, png for the
CLI), written for the agent as 名字（id）, and handed to the CLIs that take an image as an image
(measured per CLI: web/docs/cli-adapters.md §图片)."""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.agents import ClaudeCodeBackend, CodexBackend, GrokBackend, PiBackend
from server.canvas.adapters.common import user_item
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.runner import ExecOptions, RunRequest
from server.canvas.selection import Selections
from server.canvas.sessions import AgentHub
from server.canvas.transcript import split_agora

# 1×1 PNG
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
ELS = [{"id": "o-api", "name": "API 服务"}, {"id": "o-db", "name": "MySQL"}]
NID = "65b04644-6b78-49c7-b0df-b94f9d79a2fc"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def store(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": []}, base=None)
    return s


# ——— saved beside the project ———
def test_a_saved_selection_reads_back_with_its_names_and_its_pictures(store):
    sel = Selections(store.dir)
    saved = sel.save(canvas_id="c1", elements=ELS, svg=SVG, png=PNG)
    assert saved["id"].startswith("sel-") and len(saved["id"]) == len("sel-") + 10
    meta = sel.read(saved["id"])
    assert meta == {"id": saved["id"], "canvasId": "c1", "elements": ELS, "at": meta["at"], "hasThumb": True, "hasImage": True}
    assert sel.svg(saved["id"]) == SVG and sel.png_path(saved["id"]).read_bytes() == PNG


def test_a_selection_without_a_png_says_so_and_a_missing_one_reads_as_none(store):
    sel = Selections(store.dir)
    saved = sel.save(canvas_id="c1", elements=ELS, svg=SVG, png=None)
    assert sel.read(saved["id"])["hasImage"] is False and sel.png_path(saved["id"]) is None
    assert sel.read("sel-0000000000") is None and sel.read("../../etc/passwd") is None


def test_a_selection_the_page_could_not_draw_keeps_the_names_only(store):
    sel = Selections(store.dir)
    saved = sel.save(canvas_id="c1", elements=ELS, svg="", png=None)
    assert sel.read(saved["id"])["hasThumb"] is False and sel.svg(saved["id"]) is None and sel.read(saved["id"])["elements"] == ELS


def test_a_picture_too_big_to_keep_is_refused_not_cut(store):
    with pytest.raises(ValueError):
        Selections(store.dir).save(canvas_id="c1", elements=ELS, svg="<svg>" + "x" * 3_000_000 + "</svg>", png=None)


def test_the_picture_is_served_to_the_page_after_a_restart(store):
    saved = Selections(store.dir).save(canvas_id="c1", elements=ELS, svg=SVG, png=PNG)
    with TestClient(create_project_app(store.root, canvas_router=APIRouter())) as c:  # a new server over the same project
        assert c.get(f"/api/agent/selections/{saved['id']}").json()["elements"] == ELS
        r = c.get(f"/api/agent/selections/{saved['id']}/thumb.svg")
        assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml") and r.text == SVG
        assert c.get("/api/agent/selections/sel-0000000000").status_code == 404


# ——— what the agent is sent ———
class Recording:
    name = "claude"

    def __init__(self):
        self.calls: list[RunRequest] = []

    async def run(self, req):
        self.calls.append(req)
        yield {"t": "result", "at": 1, "raw": "ok", "usage": {"costUsd": None}, "session": req.options.session}


def send(store, kind: str, body: dict) -> tuple[Recording, dict]:
    """Post a message into a session of ``kind`` whose backend records what it is asked to run."""
    rec = Recording()
    store.bind("s-1", agent=kind, model="m", native_id=NID, started=False)
    hub = AgentHub(store, backend_factory=lambda k: rec)
    with TestClient(create_project_app(store.root, canvas_router=APIRouter(), hub=hub)) as c:
        r = c.post("/api/agent/sessions/s-1/send", json=body)
        assert r.status_code == 200, r.text
        for _ in range(100):
            if rec.calls:
                break
            time.sleep(0.05)
    return rec, r.json()


def payload(**over):
    return {"text": "这几个是干什么的", "canvasId": "c1", "selection": {"canvasId": "c1", "elements": ELS, "svg": SVG, "png": base64.b64encode(PNG).decode()}, **over}


def test_the_agent_reads_the_selection_as_names_with_ids_and_the_person_sees_none_of_it(store):
    rec, _ = send(store, "claude", payload())
    prompt = rec.calls[0].prompt
    body, from_agora = split_agora(prompt)
    assert from_agora and body == "这几个是干什么的"
    assert "当前选区（2 个元素）：API 服务（o-api）、MySQL（o-db）" in prompt
    it = user_item("u1", prompt, 1)
    assert it["text"] == "这几个是干什么的" and set(it["selection"]) == {"id"}


def test_references_are_named_the_same_way_and_stay_out_of_the_words(store):
    rec, _ = send(store, "claude", {"text": "看看 #API 服务", "canvasId": "c1", "refs": [{"id": "o-api", "name": "API 服务"}]})
    prompt = rec.calls[0].prompt
    assert "引用的画布元素：API 服务（o-api）" in prompt and user_item("u1", prompt, 1)["text"] == "看看 #API 服务"


def test_a_cli_that_takes_images_is_handed_the_selection_as_a_file(store):
    rec, _ = send(store, "claude", payload())
    (path,) = rec.calls[0].images
    assert Path(path).read_bytes() == PNG and ".agora/local/selections/" in path


@pytest.mark.parametrize("kind", ["cursor", "devin"])
def test_a_cli_that_cannot_take_an_image_gets_the_words_only(store, kind):
    rec, _ = send(store, kind, payload())
    assert rec.calls[0].images == () and "当前选区（2 个元素）" in rec.calls[0].prompt


def test_a_message_without_a_selection_is_as_before(store):
    rec, _ = send(store, "claude", {"text": "你好", "canvasId": "c1"})
    assert rec.calls[0].images == () and "选区" not in rec.calls[0].prompt


# ——— how each CLI takes the picture (the seam: its arguments and its first input) ———
def req(images, prompt="问题", session="s1", new=False):
    return RunRequest(schema=None, system=None, prompt=prompt, options=ExecOptions(backend="claude", session=session, new_session=new), images=tuple(map(str, images)))


def test_claude_gets_an_image_block_before_the_text_in_its_first_line(tmp_path):
    f = tmp_path / "s.png"
    f.write_bytes(PNG)
    line = json.loads(ClaudeCodeBackend().stdin(req([f])))
    assert line["message"]["content"] == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(PNG).decode()}},
        {"type": "text", "text": "问题"},
    ]


def test_claude_without_images_still_sends_the_plain_text_line():
    assert json.loads(ClaudeCodeBackend().stdin(req([])))["message"]["content"] == "问题"


def test_codex_takes_the_file_with_dash_i_new_or_resumed(tmp_path):
    f = tmp_path / "s.png"
    f.write_bytes(PNG)
    for r in (req([f]), req([f], session=None)):
        a = CodexBackend().args(r)
        i = a.index("-i")
        assert a[i + 1] == str(f) and a[-1] == "-" and a[i + 2].startswith("-")  # -i takes many values: a flag must follow so the prompt dash stays the prompt


def test_pi_takes_the_file_as_an_at_argument_before_the_prompt(tmp_path):
    f = tmp_path / "s.png"
    f.write_bytes(PNG)
    assert PiBackend().args(req([f]))[-3:] == ["--", f"@{f}", "问题"]


def test_grok_takes_the_image_as_an_acp_block_in_the_prompt_json(tmp_path):
    f = tmp_path / "s.png"
    f.write_bytes(PNG)
    a = GrokBackend().args(req([f]))
    blocks = json.loads(a[a.index("--prompt-json") + 1])
    assert blocks == [{"type": "image", "data": base64.b64encode(PNG).decode(), "mimeType": "image/png"}, {"type": "text", "text": "问题"}]


# ——— what a CLI writes into its log for the picture is not the person's words ———
def test_pis_file_tag_for_the_picture_is_not_part_of_the_message():
    pi = '<file name="/p/.agora/local/selections/sel-0a1b2c3d4e/selection.png"></file>\n这几个是干什么的\n\n[[agora]] 来自 Agora。 agora-sel-sel-0a1b2c3d4e'
    it = user_item("u1", pi, 1)
    assert it["text"] == "这几个是干什么的" and it["selection"] == {"id": "sel-0a1b2c3d4e"}
