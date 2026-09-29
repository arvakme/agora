"""The ``layout`` op of ``agora canvas apply`` (and ``agora canvas layout``): it becomes plain ops before
the page or the server's fallback executor sees them, so neither has to know about layout."""

import pytest

from server.canvas.graph_lint import lint
from server.canvas.graph_ops import expand_layout, plan_reflow


def node(i, x=0, y=0, w=160, h=64):
    return {"id": i, "type": "rectangle", "label": i, "x": x, "y": y, "width": w, "height": h}


def arrow(i, a, b, **kw):
    return {"id": i, "type": "arrow", "start": {"id": a}, "end": {"id": b}, **kw}


def scene(nodes, arrows=(), junctions=()):
    return {"nodes": list(nodes), "arrows": list(arrows), "frames": [], "junctions": list(junctions)}


def shape(ref, x=0, y=0, text=None):
    return {"op": "add_shape", "ref": ref, "shape": "rectangle", "text": text or ref, "x": x, "y": y}


def line(frm, to, **kw):
    return {"op": "add_arrow", "from": frm, "to": to, **kw}


def test_ops_without_a_layout_op_come_back_untouched():
    ops = [shape("a", 10, 20), line("a", "b")]
    assert expand_layout(scene([node("b", 500, 0)]), ops) == (ops, None)


def test_a_layout_op_places_the_new_shapes_below_their_source_and_leaves_the_old_node_alone():
    s = scene([node("src", 400, 0)])
    ops = [shape("api"), shape("db"), line("src", "api"), line("api", "db"), {"op": "layout"}]
    out, info = expand_layout(s, ops)
    assert all(o["op"] != "layout" for o in out)
    placed = {o["ref"]: o for o in out if o["op"] == "add_shape"}
    assert placed["api"]["y"] > 0 and placed["db"]["y"] > placed["api"]["y"]
    assert info["placed"] == ["api", "db"] and info["moved"] == []
    assert not any(o["op"] == "move" for o in out)


def test_the_expanded_batch_measures_clean():
    s = scene([node("src", 400, 0), node("other", 900, 0)])
    ops = [shape(f"n{i}") for i in range(4)] + [line("src", "n0"), line("src", "n1"), line("n0", "n2"), line("n1", "n2"), line("n2", "n3"), line("other", "n3"), {"op": "layout"}]
    out, _ = expand_layout(s, ops)
    after = scene([*s["nodes"], *[node(o["ref"], o["x"], o["y"]) for o in out if o["op"] == "add_shape"]], [arrow(f"a{i}", o["from"], o["to"], **({"path": o["path"]} if "path" in o else {})) for i, o in enumerate(x for x in out if x["op"] == "add_arrow")])
    r = lint(after)
    assert r["counts"]["crossings"] == 0 and r["counts"]["overlaps"] == 0 and r["counts"]["throughNodes"] == 0


def test_a_fan_of_four_with_bus_becomes_a_junction_a_trunk_and_branches():
    s = scene([])
    ops = [shape("s")] + [shape(f"t{i}") for i in range(4)] + [line("s", f"t{i}", ref=f"e{i}") for i in range(4)] + [{"op": "layout", "bus": True}]
    out, info = expand_layout(s, ops)
    kinds = [o["op"] for o in out]
    assert kinds.count("add_junction") == 1
    j = next(o for o in out if o["op"] == "add_junction")
    assert kinds.index("add_junction") < min(i for i, o in enumerate(out) if o["op"] == "add_arrow")
    arrows = [o for o in out if o["op"] == "add_arrow"]
    assert len(arrows) == 5
    assert sum(1 for a in arrows if a["to"] == j["ref"]) == 1 and sum(1 for a in arrows if a["from"] == j["ref"]) == 4
    assert all(a.get("plain") for a in arrows if a["to"] == j["ref"])
    assert info["junctions"] == [j["ref"]]


def test_layout_has_to_be_the_last_op_and_says_so():
    with pytest.raises(ValueError, match="最后"):
        expand_layout(scene([]), [{"op": "layout"}, shape("a")])


def test_reflow_of_named_nodes_moves_only_those_and_says_what_moves():
    s = scene(
        [node("a", 0, 0), node("b", 600, 0), node("c", 0, 100), node("keep", 1200, 900)],
        [arrow("e1", "a", "b"), arrow("e2", "b", "c")],
    )
    ops, info = expand_layout(s, [{"op": "layout", "reflow": ["a", "b", "c"]}])
    moved = {o["id"] for o in ops if o["op"] == "move"}
    assert moved <= {"a", "b", "c"} and "keep" not in moved
    assert set(info["moved"]) == moved and moved
    assert not any(o["op"] == "layout" for o in ops)


def test_reflow_of_a_node_that_is_not_there_is_refused():
    with pytest.raises(ValueError, match="ghost"):
        expand_layout(scene([node("a")]), [{"op": "layout", "reflow": ["ghost"]}])


def test_plan_reflow_previews_what_moves_and_the_crossings_before_and_after():
    s = scene(
        [node("a1", 0, 0), node("a2", 300, 0), node("a3", 600, 0), node("b1", 0, 300), node("b2", 300, 300), node("b3", 600, 300)],
        [arrow("e1", "a1", "b3"), arrow("e2", "a2", "b2"), arrow("e3", "a3", "b1")],
    )
    plan = plan_reflow(s, ["a1", "a2", "a3", "b1", "b2", "b3"])
    assert plan["before"]["counts"]["crossings"] == 3 and plan["after"]["counts"]["crossings"] == 0
    assert plan["moves"] and all({"id", "label", "from", "to"} <= set(m) for m in plan["moves"])
    assert plan["ops"] and all(o["op"] in ("move", "route") for o in plan["ops"])


def test_a_new_line_between_two_existing_nodes_is_routed_too_and_hops_the_old_line_it_must_cross():
    s = scene([node("a", 0, 0), node("b", 500, 0), node("c", 0, 400), node("d", 500, 400)], [arrow("old", "a", "d")])
    ops, info = expand_layout(s, [{"op": "add_arrow", "from": "b", "to": "c"}, {"op": "layout"}])
    line = ops[0]
    assert line["path"] and len(line["path"]) > 2  # bent around the crossing with a hop, not the plain straight default
    assert info["placed"] == [] and info["moved"] == []


def test_a_new_shape_with_a_long_label_is_made_wide_enough_for_it():
    s = scene([])
    ops, _ = expand_layout(s, [shape("a", text="controlplane\nGo 控制面 (Connect API)"), shape("b", text="db"), line("a", "b"), {"op": "layout"}])
    a, b = (o for o in ops if o["op"] == "add_shape")
    assert a["width"] > 200 and a["height"] >= 64  # wider than the default 160
    assert "width" not in b or b["width"] == 160  # a short one stays as it is
    after = scene([node("a", a["x"], a["y"], a["width"], a["height"]), node("b", b["x"], b["y"])])
    assert lint(after)["counts"]["overlaps"] == 0


def test_a_shape_the_agent_sized_itself_keeps_its_size():
    ops, _ = expand_layout(scene([]), [{**shape("a", text="a very long label that would not fit " * 3), "width": 100, "height": 40}, {"op": "layout"}])
    assert (ops[0]["width"], ops[0]["height"]) == (100, 40)
