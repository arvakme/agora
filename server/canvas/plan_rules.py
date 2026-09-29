"""The referential rules of an edit plan, on the server: what the fallback executor (fallback.py) checks before it touches a file.

The rules are ONE file, ``web/generated/plan.rules.json``: the page's ``validatePlan`` (web/src/ops/ops.ts) reads it, this module reads it,
and ``web/generated/plan.cases.json`` is the list of cases both sides must answer identically (web/src/ops/planRules.test.ts,
tests/test_plan_rules.py). The structural JSON Schema is the other generated file (schemas.py). Freshness (``stale_ids``) is the
server-side twin of ``staleIds`` in web/src/canvas/context.ts; ``model_view.version_of`` is the token both compute.

Small on purpose, so other server-side tools (layout, lint) can reuse ``load`` and ``scene_kinds`` instead of reading the file again.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

from server.canvas.model_view import library_meta, version_of

RULES_FILE = Path(__file__).resolve().parents[2] / "web" / "generated" / "plan.rules.json"


@lru_cache
def load() -> dict[str, Any]:
    """The rule table, as the page reads it."""
    return json.loads(RULES_FILE.read_text())


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def validate_plan(raw: Any, kind: Callable[[str], str | None], library_item: Callable[[str], bool] | None = None) -> list[str]:
    """Schema-level and referential problems of a plan (empty = valid). Same messages, same order as the page's ``validatePlan``.

    ``kind(id)``: "shape" | "arrow" | "frame" | "library" for a live element, else None; ``library_item(id)``: the library has it."""
    rules = load()
    ops_rules: dict[str, Any] = rules["ops"]
    ref_re = re.compile(rules["ref"])
    ref_text = f"/{rules['ref']}/"
    if not isinstance(raw, dict) or not isinstance(raw.get("ops"), list):
        return ["缺少 ops 数组"]
    ops = raw["ops"]
    errors: list[str] = []
    if not ops:
        errors.append("ops 为空")
    created: dict[str, str] = {}
    deleted: set[str] = set()

    def kind_of(i: str) -> str | None:
        return None if i in deleted else created.get(i) or kind(i)

    def targets(op: str, field: str) -> list[str]:
        return (ops_rules[op].get("targets") or {}).get(field, [])

    for i, op in enumerate(ops):
        at = f"ops[{i}]"
        if not isinstance(op, dict):
            errors.append(f"{at} 不是对象")
            continue
        name = op.get("op")
        spec = ops_rules.get(name) if isinstance(name, str) else None
        if spec is None:
            errors.append(f"{at}.op 未知：{_js_string(name)}")
            continue
        for k in op:
            if k != "op" and k not in spec["req"] and k not in spec["opt"]:
                errors.append(f"{at} 多余字段 {k}")
        for k in spec["req"]:
            if k not in op:
                errors.append(f"{at} 缺少 {k}")
        for k, v in op.items():
            if k in ("op", "near", "at"):
                continue
            if k in rules["numeric"]:
                if not _is_number(v):
                    errors.append(f"{at}.{k} 不是有限数字")
                elif k in ("width", "height") and (v < rules["size"]["min"] or v > rules["size"]["max"]):
                    errors.append(f"{at}.{k} 超出 {rules['size']['min']}–{rules['size']['max']}")
                elif abs(v) > rules["coordinateMax"]:
                    errors.append(f"{at}.{k} 超出画布范围")
            elif k in rules["booleans"]:
                if not isinstance(v, bool):
                    errors.append(f"{at}.{k} 不是布尔值")
            elif k == "path":
                if v is None and name == "route":
                    continue  # back to the plain straight arrow
                lo, hi = rules["path"]["min"], rules["path"]["max"]
                if not isinstance(v, list) or not lo <= len(v) <= hi or not all(isinstance(p, list) and len(p) == 2 for p in v):
                    errors.append(f"{at}.path 需要 {lo}–{hi} 个 [x, y] 点")
                elif not all(_is_number(n) and abs(n) <= rules["coordinateMax"] for p in v for n in p):
                    errors.append(f"{at}.path 的坐标要是有限数字，绝对值不超过 {rules['coordinateMax']}")
            elif not isinstance(v, str) or not v.strip() or len(v) > rules["stringMax"]:
                errors.append(f"{at}.{k} 不是非空字符串")

        def need(id_: Any, allowed: list[str], field: str = "id") -> None:
            k = kind_of(id_) if isinstance(id_, str) else None
            if not k:
                errors.append(f"{at}.{field} 指向不存在的元素 {_js_string(id_)}")
            elif k not in allowed:
                errors.append(f"{at}.{field} 类型 {k} 不支持 {name}")

        def add_ref(ref: Any, k: str) -> None:
            if not isinstance(ref, str) or not ref_re.search(ref):
                errors.append(f"{at}.ref 需匹配 {ref_text}")
                return
            if kind_of(ref) or ref in created:
                errors.append(f"{at}.ref {ref} 与已有元素重名")
                return
            created[ref] = k

        if name in ("update_text", "move", "resize"):
            need(op.get("id"), targets(name, "id"))
        elif name == "delete":
            need(op.get("id"), targets("delete", "id"))
            if isinstance(op.get("id"), str):
                deleted.add(op["id"])
        elif name == "add_shape":
            if op.get("shape") not in rules["shapes"]:
                errors.append(f"{at}.shape 非法")
            if op.get("frameId") is not None:
                need(op["frameId"], targets("add_shape", "frameId"), "frameId")
            add_ref(op.get("ref"), spec["creates"])
        elif name == "add_arrow":
            need(op.get("from"), targets("add_arrow", "from"), "from")
            need(op.get("to"), targets("add_arrow", "to"), "to")
            if op.get("from") == op.get("to"):
                errors.append(f"{at} 起止相同")
            if op.get("ref") is not None:
                add_ref(op["ref"], spec["creates"])
        elif name == "add_junction":
            add_ref(op.get("ref"), spec["creates"])
        elif name == "route":
            need(op.get("id"), targets("route", "id"))
        elif name == "insert_library_item":
            item = op.get("item")
            if not isinstance(item, str) or not (library_item and library_item(item)):
                errors.append(f"{at}.item 不是素材库里的组件 id：{_js_string(item)}（先用 search_library 查）")
            near, pos = op.get("near"), op.get("at")
            if (near is None) == (pos is None):
                errors.append(f"{at} 需要 near 或 at 其中之一")
            if near is not None and isinstance(near, dict):
                need(near.get("id"), targets("insert_library_item", "near.id"), "near.id")
                if near.get("side") not in rules["sides"]:
                    errors.append(f"{at}.near.side 非法")
                gap = near.get("gap")
                if gap is not None and (not isinstance(gap, int | float) or isinstance(gap, bool) or gap < 0 or gap > rules["gapMax"]):
                    errors.append(f"{at}.near.gap 超出 0–{rules['gapMax']}")
            if pos is not None and (not isinstance(pos, dict) or not _is_number(pos.get("x")) or not _is_number(pos.get("y"))):
                errors.append(f"{at}.at 需要有限的 x/y")
            if op.get("frameId") is not None:
                need(op["frameId"], targets("insert_library_item", "frameId"), "frameId")
            add_ref(op.get("ref"), spec["creates"])
    return errors


def _js_string(v: Any) -> str:
    """How JavaScript's ``String(v)`` prints what the messages name (ids, ops, items)."""
    if v is None:
        return "undefined"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def referenced_ids(plan: dict[str, Any]) -> list[str]:
    """Every existing element id the plan reads or writes (for the freshness check)."""
    ids: dict[str, None] = {}
    for o in plan["ops"]:
        if "id" in o:
            ids[o["id"]] = None
        if o["op"] == "add_arrow":
            ids[o["from"]] = None
            ids[o["to"]] = None
        if o["op"] in ("add_shape", "insert_library_item") and o.get("frameId"):
            ids[o["frameId"]] = None
        if o["op"] == "insert_library_item" and o.get("near"):
            ids[o["near"]["id"]] = None
    return list(ids)


def stale_ids(versions: dict[str, str], ids: Sequence[str], elements: list[dict[str, Any]]) -> list[str]:
    """Elements (by id) whose freshness token no longer matches the one the agent's read saw."""
    by_id = {e["id"]: e for e in elements if "id" in e}
    out = []
    for i in ids:
        frozen = versions.get(i)
        if frozen is None:
            continue  # created by this plan
        e = by_id.get(i)
        if not e or e.get("isDeleted") or version_of(e, by_id) != frozen:
            out.append(i)
    return out


def scene_kinds(elements: list[dict[str, Any]]) -> Callable[[str], str | None]:
    """``kind(id)`` for ``validate_plan`` from a canvas file's elements (the twin of ``sceneIndex`` in web/src/session/runTurn.ts)."""
    by_id = {e["id"]: e for e in elements if "id" in e}

    def kind(i: str) -> str | None:
        e = by_id.get(i)
        if not e or e.get("isDeleted"):
            return None
        if library_meta(e):
            return "library"
        t = e.get("type")
        return "shape" if t in ("rectangle", "ellipse", "diamond") else "arrow" if t == "arrow" else "frame" if t == "frame" else None

    return kind
