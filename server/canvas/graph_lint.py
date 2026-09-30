"""``agora canvas lint``: how readable a diagram is, measured.

Pure function of a scene (see ``graph_geom``). Reports what makes a diagram hard to read: line
crossings (which pairs, where), lines through nodes they are not attached to, overlapping or too
close nodes, labels covered by something, lines stacked on the same spot of one node, and the
lines' total length and corners. ``summary`` is one sentence an agent can read off; the lists say
what to change.
"""

from __future__ import annotations

from typing import Any

from .graph_geom import (
    MIN_GAP,
    arrow_ends,
    arrow_path,
    bend_count,
    collinear_run,
    cross_point,
    elements_by_id,
    label_rect,
    label_width,
    near,
    path_length,
    rect_gap,
    rect_of,
    rects_overlap,
    seg_hits_rect,
    segments,
)

SHARED_END = 14  # crossings this close to an end the two lines share are the end, not a crossing
STACK = 8  # two lines that end within this many px of each other on one side of a node are stacked
RUN = 12  # lines running on top of each other for at least this long are hiding each other


def _name(el: dict[str, Any] | None, fallback: str) -> str:
    label = str((el or {}).get("label") or "").strip().replace("\n", " ")
    return f"{label}({fallback})" if label and label != fallback else fallback


def _pair_text(a: dict[str, Any], b: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> str:
    def one(x: dict[str, Any]) -> str:
        s, e = arrow_ends(x)
        return f"{_name(by_id.get(s), s or '?')}→{_name(by_id.get(e), e or '?')}"

    return f"{one(a)} 与 {one(b)}"


def _side(n: dict[str, Any], p: tuple[float, float]) -> str:
    x0, y0, x1, y1 = rect_of(n)
    d = {"top": abs(p[1] - y0), "bottom": abs(p[1] - y1), "left": abs(p[0] - x0), "right": abs(p[0] - x1)}
    return min(d, key=d.get)


def lint(scene: dict[str, Any]) -> dict[str, Any]:
    nodes = scene.get("nodes", [])
    by_id = elements_by_id(scene)
    junction_ids = {j["id"] for j in scene.get("junctions", [])}
    arrows = [a for a in scene.get("arrows", [])]
    paths = {a["id"]: arrow_path(a, by_id) for a in arrows}
    segs = {aid: segments(pts) for aid, pts in paths.items()}

    crossings: list[dict[str, Any]] = []
    hops = 0
    runs: list[dict[str, Any]] = []
    for i, a in enumerate(arrows):
        ea = set(arrow_ends(a)) - {None}
        for b in arrows[i + 1 :]:
            shared = ea & (set(arrow_ends(b)) - {None})
            if shared & junction_ids:
                continue  # lines that meet in a junction dot are one bus: they touch and run together by design
            ends = [p for x in (a, b) for p, e in ((paths[x["id"]][0], arrow_ends(x)[0]), (paths[x["id"]][-1], arrow_ends(x)[1])) if paths[x["id"]] and e in shared]
            found: list[tuple[float, float]] = []
            hopped = 0
            run = 0.0
            for p, q, ha in segs[a["id"]]:
                for r, s, hb in segs[b["id"]]:
                    run += collinear_run(p, q, r, s)
                    c = cross_point(p, q, r, s)
                    if c is None or any(near(c, e, SHARED_END) for e in ends):
                        continue
                    if ha != hb:
                        hopped += 1
                    else:
                        found.append(c)
            hops += hopped
            for c in found:
                crossings.append({"a": a["id"], "b": b["id"], "at": [round(c[0]), round(c[1])], "text": _pair_text(a, b, by_id)})
            if run >= RUN:
                runs.append({"a": a["id"], "b": b["id"], "length": round(run), "text": _pair_text(a, b, by_id)})

    through = []
    for a in arrows:
        own = set(arrow_ends(a))
        for n in nodes:
            if n["id"] in own:
                continue
            r = rect_of(n)
            if any(seg_hits_rect(p, q, r) for p, q, _ in segs[a["id"]]):
                s, e = arrow_ends(a)
                through.append({"arrow": a["id"], "node": n["id"], "text": f"线 {_name(by_id.get(s), s or '?')}→{_name(by_id.get(e), e or '?')} 穿过了不相干的 {_name(n, n['id'])}"})

    overlaps, close = [], []
    for i, a in enumerate(nodes):
        for b in nodes[i + 1 :]:
            ra, rb = rect_of(a), rect_of(b)
            item = {"a": a["id"], "b": b["id"], "text": f"{_name(a, a['id'])} 与 {_name(b, b['id'])}"}
            if rects_overlap(ra, rb):
                overlaps.append(item)
            elif rect_gap(ra, rb) < MIN_GAP:
                close.append({**item, "gap": round(rect_gap(ra, rb))})

    overflow = [
        {"node": n["id"], "text": f"{_name(n, n['id'])} 的文字（约 {round(label_width(n['label'], n.get('type', 'rectangle')))} px 宽）比框（{round(float(n['width']))} px）宽，会溢出"}
        for n in nodes
        if n.get("label") and label_width(n["label"], n.get("type", "rectangle")) > float(n["width"]) - 12
    ]
    boxes = {a["id"]: label_rect(a, paths[a["id"]]) for a in arrows}
    clashes = []
    for a in arrows:
        box = boxes[a["id"]]
        if box is None:
            continue
        why = []
        for n in nodes:
            if rects_overlap(box, rect_of(n)):
                why.append(f"盖在 {_name(n, n['id'])} 上")
        for o in arrows:
            if o["id"] == a["id"]:
                continue
            ob = boxes[o["id"]]
            if ob is not None and rects_overlap(box, ob):
                why.append(f"与线 {o['id']} 的标签重叠")
            elif any(seg_hits_rect(p, q, box, 1) for p, q, _ in segs[o["id"]]):
                why.append(f"被线 {o['id']} 穿过")
        if why:
            clashes.append({"arrow": a["id"], "text": f"线 {a['id']} 的标签「{a.get('label')}」" + "、".join(why)})

    ends_at: dict[tuple[str, str], list[tuple[str, tuple[float, float]]]] = {}
    for a in arrows:
        pts = paths[a["id"]]
        for el_id, p in ((arrow_ends(a)[0], pts[0] if pts else None), (arrow_ends(a)[1], pts[-1] if pts else None)):
            if el_id in by_id and el_id not in junction_ids and p is not None:
                ends_at.setdefault((el_id, _side(by_id[el_id], p)), []).append((a["id"], p))
    stacked = []
    for (el_id, side), items in ends_at.items():
        group: set[str] = set()
        for i, (ia, p) in enumerate(items):
            for ib, q in items[i + 1 :]:
                if ia != ib and near(p, q, STACK):
                    group.update((ia, ib))
        if group:
            stacked.append({"node": el_id, "side": side, "arrows": sorted(group), "text": f"{_name(by_id.get(el_id), el_id)} 的{ {'top': '上', 'bottom': '下', 'left': '左', 'right': '右'}[side] }边：线 {'、'.join(sorted(group))} 叠在同一处"})

    length = round(sum(path_length(p) for p in paths.values()))
    bends = sum(bend_count(p) for p in paths.values())
    counts = {
        "nodes": len(nodes),
        "arrows": len(arrows),
        "crossings": len(crossings),
        "hops": hops,
        "throughNodes": len(through),
        "overlaps": len(overlaps),
        "tooClose": len(close),
        "labelClashes": len(clashes),
        "textOverflow": len(overflow),
        "stackedAnchors": len(stacked),
        "lineOverlaps": len(runs),
        "length": length,
        "bends": bends,
    }
    problems = [k for k in ("crossings", "throughNodes", "overlaps", "labelClashes", "textOverflow", "stackedAnchors", "lineOverlaps") if counts[k]]
    parts = [f"交叉 {counts['crossings']} 处" + (f"（另有 {hops} 处跳线）" if hops else "") if counts["crossings"] else "没有交叉" + (f"（{hops} 处跳线）" if hops else "")]
    for key, text in (("throughNodes", "线穿过无关节点 {} 处"), ("overlaps", "节点重叠 {} 对"), ("tooClose", f"节点间距不足 {MIN_GAP} px {{}} 对"), ("labelClashes", "标签被遮挡 {} 处"), ("textOverflow", "标签文字比框宽 {} 个"), ("stackedAnchors", "线叠在同一锚点 {} 处"), ("lineOverlaps", "线重合 {} 处")):
        if counts[key]:
            parts.append(text.format(counts[key]))
    summary = f"{counts['nodes']} 个节点、{counts['arrows']} 条线：{'，'.join(parts)}；线总长 {length} px，拐点 {bends} 个。"
    return {
        "ok": not problems,
        "summary": summary,
        "counts": counts,
        "crossings": crossings,
        "throughNodes": through,
        "overlaps": overlaps,
        "tooClose": close,
        "labelClashes": clashes,
        "textOverflow": overflow,
        "stackedAnchors": stacked,
        "lineOverlaps": runs,
        **({"advice": _advice(counts)} if problems or counts["tooClose"] else {}),
    }


def _advice(c: dict[str, int]) -> list[str]:
    out = []
    if c["overlaps"] or c["tooClose"]:
        out.append("节点挤在一起：用 layout 排新画的节点，或 move 拉开到 ≥ 40 px。")
    if c["crossings"] or c["throughNodes"] or c["stackedAnchors"]:
        out.append("交叉、穿节点、叠锚点：对新画的这批用 `layout` op（或 `agora canvas layout`）重排，它会换层内顺序并给线走折线、分开锚点。")
    if c["crossings"] > 2:
        out.append("重排后交叉数仍降不下去：这一层放得太多了，拆成子图（agora canvas child create）或合并几个节点。")
    if c["labelClashes"]:
        out.append("标签被遮挡：缩短标签，或把线两端的节点拉远。")
    if c["textOverflow"]:
        out.append("文字比框宽：用 resize 加宽这些框（新节点不写 width，layout 会按文字定宽），或缩短文字。")
    return out


def brief(report: dict[str, Any], limit: int = 6) -> dict[str, Any]:
    """The report for an ``apply`` answer: the sentence, the counts, and the first few of each list."""
    out: dict[str, Any] = {"ok": report["ok"], "summary": report["summary"], "counts": report["counts"]}
    for key in ("crossings", "throughNodes", "overlaps", "tooClose", "labelClashes", "textOverflow", "stackedAnchors", "lineOverlaps"):
        items = report[key]
        if items:
            out[key] = items[:limit] + ([f"…还有 {len(items) - limit} 条，`agora canvas lint` 看全部"] if len(items) > limit else [])
    if "advice" in report:
        out["advice"] = report["advice"]
    return out
