"""What Agora writes into a session as a "user" message, read back for display (server/canvas/agora_msg.py):
a dispatch receipt, a dispatch's task envelope, and the selection / reference notes that ride on a chat message.
The page draws the first two as cards, not as something the person said, and the selection as a picture."""

from __future__ import annotations

from server.canvas.adapters.common import user_item
from server.canvas.agora_msg import envelope, receipt_text
from pathlib import Path

RID = "7bb181c9-0d5f-4c1f-9a52-3e8d2b6c4f10"
FOOT = "[[agora]] 来自 Agora · 这个项目的画布(session=s-a)。读图、改图、做动画用 agora skill（`agora canvas …`）。"

# The receipt as the user's screenshot shows it (written before this module existed): it must keep reading as a card.
OLD_RECEIPT = (
    f"[Agora 派发回执 {RID[:8]}] 你派给 Codex 会话 s-d605a5a6 的任务：完成了。答复：改好了 server/users.py，测试过了（共 3 处）。"
    f"（记录 /Users/x/proj/.agora/dispatch/{RID}；`agora dispatch status {RID}` 查看）（这是通知，不需要回复；有下一步再做。）"
)


def test_a_receipt_from_before_the_marker_existed_is_a_card_without_the_agents_words():
    it = user_item("u1", f"{OLD_RECEIPT}\n\n{FOOT}", 1)
    assert it["card"] == {"kind": "receipt", "id": RID[:8], "state": "done", "agent": "Codex", "session": "s-d605a5a6", "answer": "改好了 server/users.py，测试过了（共 3 处）。"}
    assert "/Users/x" not in str(it["card"]) and "agora dispatch" not in str(it["card"]) and "不需要回复" not in str(it["card"])


def test_a_session_the_page_made_has_a_base36_id_and_still_reads():
    text = receipt_text(RID, "Codex 会话 s-fy9cznz", "done", "好了", Path("/p"))
    assert user_item("u1", f"{text}\n\n{FOOT}", 1)["card"]["session"] == "s-fy9cznz"


def test_the_receipt_the_server_writes_reads_back_for_every_state():
    for state, want in [("done", "done"), ("failed", "failed"), ("blocked", "blocked"), ("idle_no_reply", "idle_no_reply")]:
        text = receipt_text(RID, "Claude 会话 s-9", state, "", Path("/p/.agora/dispatch") / RID)
        card = user_item("u1", f"{text}\n\n{FOOT} agora-receipt-{RID}:{state}", 1)["card"]
        assert (card["state"], card["agent"], card["session"], card["answer"]) == (want, "Claude", "s-9", "")


def test_a_task_envelope_is_a_card_naming_who_sent_it_and_the_scope_not_the_file():
    text = envelope(RID, "Claude 会话 s-a", Path(f"/p/.agora/dispatch/{RID}/task.md"), ["server/**", "tests/**"])
    it = user_item("u1", f"{text}\n\n{FOOT} dispatch={RID} agora-req-{RID}", 1)
    assert it["card"] == {"kind": "task", "id": RID[:8], "from": "Claude 会话 s-a", "session": "s-a", "scope": ["server/**", "tests/**"]}
    assert it["dispatch"] == RID  # the full id is what the page asks the server for the task's summary


def test_words_that_only_look_like_a_receipt_are_the_persons_when_agora_did_not_send_them():
    assert "card" not in user_item("u1", OLD_RECEIPT, 1)  # typed into the terminal: no footer


def test_the_selection_tail_of_an_old_message_becomes_the_selection_not_the_text():
    it = user_item("u1", f"知道这些是干什么的吗\n\n（当前选区：o-user, o-nginx, e-o-cp-o-sbx）\n\n{FOOT}", 1)
    assert it["text"] == "知道这些是干什么的吗"
    assert it["selection"] == {"ids": ["o-user", "o-nginx", "e-o-cp-o-sbx"]}


def test_a_note_with_references_and_a_selection_keeps_neither_in_the_text():
    it = user_item("u1", f"看看 #API 服务\n\n（引用的画布元素：API 服务（o-api）；当前选区：o-a, o-b）\n\n{FOOT}", 1)
    assert it["text"] == "看看 #API 服务"
    assert it["selection"] == {"ids": ["o-a", "o-b"]}


def test_a_selection_picture_is_named_by_its_token_in_the_footer():
    it = user_item("u1", f"看这几个\n\n{FOOT} agora-sel-sel-0a1b2c3d4e", 1)
    assert it["text"] == "看这几个" and it["selection"] == {"id": "sel-0a1b2c3d4e"}


def test_a_plain_message_has_no_card_and_no_selection():
    it = user_item("u1", f"你好\n\n{FOOT}", 1)
    assert "card" not in it and "selection" not in it and it["text"] == "你好"


# ——— a prompt the page wrote for the person (「画出这个项目的架构」, 「让 AI 画子图」, the figure's 「关于你派的 X」) ———
from server.canvas.agora_msg import page_mark  # noqa: E402

ARCH = "看一下这个项目，把它的整体架构画到这张图上。"


def test_the_footer_names_who_wrote_it_and_the_message_becomes_a_source_card_not_the_persons_bubble():
    it = user_item("u1", f"{ARCH}\n\n{FOOT} {page_mark('画布', '画出这个项目的架构')}", 1)
    assert it["card"] == {"kind": "page", "from": "画布", "title": "画出这个项目的架构", "text": ARCH}
    assert it["text"] == ARCH and it["source"] == "agora"


def test_the_mark_is_one_short_token_at_the_end_of_the_footer_and_survives_a_selection_or_dispatch_token():
    assert page_mark("画布", "画出这个项目的架构") == "agora-page[画布|画出这个项目的架构]"
    it = user_item("u1", f"{ARCH}\n\n{FOOT} agora-sel-sel-0123456789 {page_mark('小人', '关于你派的 T-1')}", 1)
    assert it["card"]["from"] == "小人" and it["card"]["title"] == "关于你派的 T-1" and it["selection"] == {"id": "sel-0123456789"}


def test_the_same_words_the_person_typed_are_not_a_card_from_the_page_the_terminal_or_the_composer():
    assert "card" not in user_item("u1", ARCH, 1)  # typed in the terminal
    assert "card" not in user_item("u2", f"{ARCH}\n\n{FOOT}", 2)  # sent from the composer: Agora's footer, no page mark
    typed = f"{ARCH} agora-page[画布|画出这个项目的架构]"  # the person typing the mark itself: it is in the body, not the footer
    assert "card" not in user_item("u3", f"{typed}\n\n{FOOT}", 3)


def test_a_mark_cannot_be_forged_into_more_than_one_line_or_a_bracket():
    m = page_mark("画布\n", "画] 出|这个\n项目")
    assert "\n" not in m and m.count("]") == 1 and m.count("|") == 1
    assert user_item("u1", f"{ARCH}\n\n{FOOT} {m}", 1)["card"]["kind"] == "page"
