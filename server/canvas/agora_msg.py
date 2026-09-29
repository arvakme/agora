"""What Agora writes into a session as a "user" message, and how it is read back for display.

Three things are not something the person said and are not drawn as a chat bubble:

- a **receipt** (``[Agora 派发回执 …]``): the note that tells a giver its dispatch ended;
- a **task envelope** (``[Agora 派发 …]``): what a dispatch sends the session that takes the task;
- a **selection** that rode on a chat message: a picture of the selected elements saved beside the project
  (``selection.py``), named in the footer by ``agora-sel-<id>``, and, in messages from before pictures, a
  trailing ``（当前选区：…）`` note in the text.

The builders and the parsers live here side by side, so the wording is defined once. ``adapters/common.py``
``user_item`` calls ``read`` for every user message of every CLI's log — old logs included, which is why the
parsers also accept what earlier versions wrote. (The canvas-comment hand-off is parsed by the page, next to its
builder in ``web/src/comments/handoff.ts``.)
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# The word a receipt gives for each state a dispatch ended in (the wording B's giver reads).
RECEIPT_HEAD = {"done": "完成了", "failed": "失败了", "blocked": "受阻", "idle_no_reply": "对方这一轮结束了，但没有交回执"}
_STATE_OF = {v: k for k, v in RECEIPT_HEAD.items()}
NO_ANSWER = "没有答复内容"
RECORD_AT = "（记录 "

# More than this many elements in a note are counted, not listed (the picture and the saved record have them all).
NOTE_MAX = 60


def receipt_text(rid: str, target: str, state: str, answer: str, folder: Path) -> str:
    head = RECEIPT_HEAD.get(state, state)
    more = f"答复：{answer}" if answer else NO_ANSWER
    return f"[Agora 派发回执 {rid[:8]}] 你派给 {target} 的任务：{head}。{more}{RECORD_AT}{folder}；`agora dispatch status {rid}` 查看）（这是通知，不需要回复；有下一步再做。）"


def envelope(rid: str, source_name: str, task_path: Path, scope: list[str]) -> str:
    """The one line B reads first (the task itself is in the file)."""
    where = f"范围：{'、'.join(scope)}。" if scope else ""
    return (
        f"[Agora 派发 {rid[:8]}] 来自 {source_name}：先读任务文件 {task_path}。{where}"
        f"做完后运行 `agora reply --request {rid} --status done|failed|blocked -f <你的答复文件>` 交回执（受阻用 blocked，做不了用 failed，一两句话说明）。"
    )


_RECEIPT = re.compile(r"\[Agora 派发回执 ([0-9a-f]{8})\] 你派给 (.+?) 的任务：([^。]+)。", re.S)
_ENVELOPE = re.compile(r"\[Agora 派发 ([0-9a-f]{8})\] 来自 (.+?)：先读任务文件 .+?。(?:范围：(.*?)。)?做完后运行 ", re.S)
_WHO = re.compile(r"^(.+?) 会话 (s-[0-9a-z]+)$")  # ids are s- and a short token (the page makes base36 ones, dispatch hex ones)


def _who(name: str) -> dict[str, str]:
    m = _WHO.match(name)
    return {"agent": m.group(1), "session": m.group(2)} if m else {}


def card(body: str, receipt_state: str | None = None) -> dict[str, Any] | None:
    """The card a message stands for, or None for the person's own words. ``receipt_state`` is the state in the
    footer's marker (newer receipts), used when the head words are not one this module knows."""
    m = _RECEIPT.match(body)
    if m:
        head = m.group(3)
        rest = body[m.end() :]
        answer = ""
        if rest.startswith("答复："):
            at = rest.rfind(RECORD_AT)
            answer = rest[len("答复：") : at if at >= 0 else None].strip()
        return {"kind": "receipt", "id": m.group(1), "state": _STATE_OF.get(head) or receipt_state or head, **_who(m.group(2)), "answer": answer}
    m = _ENVELOPE.match(body)
    if m:
        who = _who(m.group(2))
        return {"kind": "task", "id": m.group(1), "from": m.group(2), **({"session": who["session"]} if who else {}), "scope": [s for s in (m.group(3) or "").split("、") if s]}
    return None


# ——— selection and references ———

SEL_MARK = re.compile(r"agora-sel-(sel-[0-9a-f]{10})")


def _named(els: list[dict[str, str]]) -> str:
    shown = [f"{e['name']}（{e['id']}）" if e.get("name") and e["name"] != e["id"] else e["id"] for e in els[:NOTE_MAX]]
    return "、".join(shown) + (f" 等共 {len(els)} 个" if len(els) > NOTE_MAX else "")


def selection_note(els: list[dict[str, str]]) -> str:
    """What the agent reads of the selection: name and id of each element (the picture, when its CLI takes one, comes with it)."""
    return f"当前选区（{len(els)} 个元素）：{_named(els)}" if els else ""


def refs_note(refs: list[dict[str, str]]) -> str:
    return f"引用的画布元素：{_named(refs)}" if refs else ""


# Pi writes a file it was given as ``@path`` into the message as ``<file name="…"></file>``: not the person's words.
_FILE_TAGS = re.compile(r'^(?:<file name="[^"]*"></file>\n?)+')


def strip_file_tags(body: str) -> str:
    return _FILE_TAGS.sub("", body, count=1).lstrip("\n")


_TAIL_STARTS = ("（引用的画布元素：", "（当前选区：")


def strip_tail_note(body: str) -> tuple[str, list[str] | None]:
    """A message from before pictures ends with ``（引用的画布元素：…；当前选区：a, b）`` (either half alone as well):
    (the text without it, the selected ids when it named some)."""
    i = max(body.rfind(s) for s in _TAIL_STARTS)
    if i < 0 or (i and body[i - 1] != "\n") or not body.rstrip().endswith("）"):
        return body, None
    inner = body[i + 1 : body.rstrip().rfind("）")]
    sel = inner.split("当前选区：", 1)[1] if "当前选区：" in inner else None
    ids = [x.strip() for x in sel.split(",") if x.strip()] if sel else None
    return body[:i].rstrip(), ids
