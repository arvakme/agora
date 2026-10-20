"""The language of what the server and the CLI write (server/i18n.py): a request says it (the CLI's header, the page's cookie,
the browser's Accept-Language), the owner's page is remembered for what the server says on its own, the locale is the rest.
The other tests read the Chinese words (conftest sets AGORA_LANG=zh); these check that English comes out where it should and
that what Agora parses back reads in both."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import i18n
from server.canvas import agora_msg, graph_lint
from server.canvas.adapters.common import user_item

RID = "7bb181c9-0d5f-4c1f-9a52-3e8d2b6c4f10"
FOOT = "[[agora]] From Agora · this project's canvas(session=s-a). Use the agora skill (`agora canvas …`) to read, edit or animate the diagram."


@pytest.fixture
def en(monkeypatch):
    monkeypatch.setenv("AGORA_LANG", "en")


@pytest.mark.parametrize(
    "env, want",
    [
        ({}, "en"),
        ({"LANG": "zh_CN.UTF-8"}, "zh"),
        ({"LANG": "zh_CN.UTF-8", "LC_ALL": "C"}, "en"),
        ({"LC_MESSAGES": "zh_TW.UTF-8", "LANG": "en_US.UTF-8"}, "zh"),
        ({"AGORA_LANG": "en", "LC_ALL": "zh_CN.UTF-8"}, "en"),
        ({"AGORA_LANG": "zh"}, "zh"),
    ],
)
def test_the_cli_follows_agora_lang_then_the_locale_and_is_english_without_one(env, want):
    assert i18n.env_lang(env) == want


def _app(remember: bool = True) -> TestClient:
    app = FastAPI()
    app.add_middleware(i18n.LangMiddleware, remember=remember)

    @app.get("/say")
    def say():
        return {"text": i18n.tr("保存失败", "Save failed")}

    return TestClient(app)


def test_a_request_is_answered_in_its_own_language():
    c = _app()
    assert c.get("/say").json()["text"] == "保存失败"  # nothing said: the locale (zh in the tests)
    assert c.get("/say", headers={"cookie": "agora_lang=en"}).json()["text"] == "Save failed"
    assert c.get("/say", headers={"accept-language": "en-US,en;q=0.9"}).json()["text"] == "Save failed"
    # the CLI's header wins over a cookie
    assert c.get("/say", headers={"x-agora-lang": "zh", "cookie": "agora_lang=en"}).json()["text"] == "保存失败"


def test_the_owners_page_is_remembered_for_what_the_server_says_on_its_own_and_a_guests_is_not():
    _app(remember=False).get("/say", headers={"cookie": "agora_lang=en"})
    assert i18n.tr("中", "en") == "中"
    _app().get("/say", headers={"cookie": "agora_lang=en"})
    assert i18n.lang() == "en" and i18n.tr("中", "en") == "en"


def test_an_english_receipt_and_envelope_read_back_as_the_same_cards(en):
    for state in ("done", "failed", "blocked", "idle_no_reply"):
        text = agora_msg.receipt_text(RID, agora_msg.session_name("Claude", "s-9"), state, "Fixed. Tests pass." if state == "done" else "", Path("/p/.agora/dispatch") / RID)
        assert text.startswith(f"[Agora dispatch receipt {RID[:8]}] The task you gave Claude session s-9: ")
        card = user_item("u1", f"{text}\n\n{FOOT} agora-receipt-{RID}:{state}", 1)["card"]
        assert (card["state"], card["agent"], card["session"]) == (state, "Claude", "s-9")
        assert card["answer"] == ("Fixed. Tests pass." if state == "done" else "")
    text = agora_msg.envelope(RID, agora_msg.session_name("Codex", "s-a"), Path(f"/p/.agora/dispatch/{RID}/task.md"), ["server/**", "tests/**"])
    card = user_item("u1", f"{text}\n\n{FOOT}", 1)["card"]
    assert card == {"kind": "task", "id": RID[:8], "from": "Codex session s-a", "session": "s-a", "scope": ["server/**", "tests/**"]}


def test_the_lint_sentence_is_english_when_the_person_reads_english(en):
    scene = {"nodes": [{"id": "a", "label": "A", "x": 0, "y": 0, "width": 120, "height": 60}, {"id": "b", "label": "B", "x": 400, "y": 0, "width": 120, "height": 60}], "arrows": []}
    assert graph_lint.lint(scene)["summary"].startswith("2 nodes, 0 lines: no crossings;")


def test_the_page_a_guest_gets_for_a_dead_link_follows_the_language():
    from server.canvas.share_gateway import gone_page

    assert "<html lang=\"zh-CN\">" in gone_page()
    i18n.remember("en")
    page = gone_page()
    assert "<html lang=\"en\">" in page and "This share link no longer works" in page and "链接" not in page
