"""The layered layout: upstream on top, few crossings, the fixed (the user's own) nodes untouched,
anchors spread, lines that must cross hop, fans that meet in a junction dot."""

from server.canvas.graph_layout import apply_layout, layout
from server.canvas.graph_lint import lint


def node(i, x=0, y=0, w=160, h=64):
    return {"id": i, "type": "rectangle", "label": i, "x": x, "y": y, "width": w, "height": h}


def arrow(i, a, b, **kw):
    return {"id": i, "type": "arrow", "start": {"id": a}, "end": {"id": b}, **kw}


def scene(nodes, arrows):
    return {"nodes": nodes, "arrows": arrows, "frames": [], "junctions": []}


def by_id(s):
    return {n["id"]: n for n in s["nodes"]}


def test_a_reversed_pairing_is_untangled_from_three_crossings_to_none():
    # every line crosses the others: a1→b3, a2→b2, a3→b1 with the columns in the same order
    s = scene(
        [node("a1", 0, 0), node("a2", 300, 0), node("a3", 600, 0), node("b1", 0, 300), node("b2", 300, 300), node("b3", 600, 300)],
        [arrow("e1", "a1", "b3"), arrow("e2", "a2", "b2"), arrow("e3", "a3", "b1")],
    )
    assert lint(s)["counts"]["crossings"] == 3
    res = layout(s, movable={"a1", "a2", "a3", "b1", "b2", "b3"})
    after = lint(apply_layout(s, res))
    assert after["counts"]["crossings"] == 0 and after["counts"]["overlaps"] == 0 and after["counts"]["tooClose"] == 0


def test_upstream_goes_on_top_of_downstream():
    s = scene([node("client"), node("api"), node("db")], [arrow("e1", "client", "api"), arrow("e2", "api", "db")])
    placed = by_id(apply_layout(s, layout(s, movable={"client", "api", "db"})))
    assert placed["client"]["y"] < placed["api"]["y"] < placed["db"]["y"]


def test_fixed_nodes_never_move_and_new_ones_are_placed_around_them():
    f = node("f", 0, 0)
    g = node("g", 400, 0)
    s = scene([f, g, node("n1"), node("n2"), node("n3")], [arrow("e1", "f", "n1"), arrow("e2", "n1", "n2"), arrow("e3", "f", "n3")])
    res = layout(s, movable={"n1", "n2", "n3"})
    assert set(res["nodes"]) == {"n1", "n2", "n3"}
    after = apply_layout(s, res)
    assert (by_id(after)["f"]["x"], by_id(after)["f"]["y"]) == (0, 0) and (by_id(after)["g"]["x"], by_id(after)["g"]["y"]) == (400, 0)
    r = lint(after)
    assert r["counts"]["overlaps"] == 0 and r["counts"]["tooClose"] == 0
    assert by_id(after)["n1"]["y"] > 0  # downstream of the fixed source


def test_new_nodes_are_placed_around_the_fixed_one_they_hang_from():
    s = scene([node("f", 400, 200), node("n1"), node("n2")], [arrow("e1", "f", "n1"), arrow("e2", "n1", "n2")])
    placed = by_id(apply_layout(s, layout(s, movable={"n1", "n2"})))
    assert placed["n1"]["x"] == 400 and placed["n1"]["y"] > 200  # straight below f, not somewhere else on the canvas
    assert placed["n2"]["y"] > placed["n1"]["y"]


def test_a_new_diagram_next_to_existing_content_is_put_clear_of_it():
    old = [node("o1", 0, 0), node("o2", 0, 200)]
    s = scene(old + [node("n1"), node("n2")], [arrow("e1", "n1", "n2")])
    after = apply_layout(s, layout(s, movable={"n1", "n2"}))
    r = lint(after)
    assert r["counts"]["overlaps"] == 0 and r["counts"]["tooClose"] == 0
    assert (by_id(after)["o1"]["x"], by_id(after)["o2"]["y"]) == (0, 200)


def test_lines_leaving_one_side_of_a_node_start_at_different_points():
    s = scene([node("s")] + [node(f"t{i}") for i in range(4)], [arrow(f"e{i}", "s", f"t{i}") for i in range(4)])
    res = layout(s, movable={"s", *[f"t{i}" for i in range(4)]})
    after = apply_layout(s, res)
    r = lint(after)
    assert r["counts"]["stackedAnchors"] == 0 and r["counts"]["crossings"] == 0
    starts = sorted(p["path"][0][0] for p in res["arrows"].values())
    assert all(b - a >= 12 for a, b in zip(starts, starts[1:]))
    s0 = by_id(after)["s"]
    assert all(s0["x"] < x < s0["x"] + s0["width"] for x in starts)


def test_a_line_that_would_cut_through_a_node_goes_around_it():
    s = scene([node("a", 0, 0), node("m", 0, 200), node("b", 0, 400)], [arrow("e1", "a", "b")])
    res = layout(s, movable=set(), arrows=["e1"])
    assert lint(s)["counts"]["throughNodes"] == 1
    after = lint(apply_layout(s, res))
    assert after["counts"]["throughNodes"] == 0 and after["counts"]["crossings"] == 0


def test_a_crossing_that_cannot_be_avoided_is_drawn_as_a_hop_not_a_crossing():
    # four fixed nodes, lines a→d and b→c: they must cross
    s = scene([node("a", 0, 0), node("b", 500, 0), node("c", 0, 400), node("d", 500, 400)], [arrow("e1", "a", "d"), arrow("e2", "b", "c")])
    res = layout(s, movable=set(), arrows=["e1", "e2"])
    r = lint(apply_layout(s, res))
    assert r["counts"]["crossings"] == 0 and r["counts"]["hops"] == 1 and r["counts"]["throughNodes"] == 0


def test_a_fan_of_four_meets_in_one_junction_dot_when_asked():
    s = scene([node("s")] + [node(f"t{i}") for i in range(4)], [arrow(f"e{i}", "s", f"t{i}") for i in range(4)])
    res = layout(s, movable={"s", *[f"t{i}" for i in range(4)]}, bus=True)
    assert len(res["junctions"]) == 1
    j = res["junctions"][0]
    assert j["width"] <= 14 and j["height"] <= 14
    after = apply_layout(s, res)
    r = lint(after)
    assert r["counts"]["nodes"] == 5
    assert r["counts"]["crossings"] == 0 and r["counts"]["overlaps"] == 0
    ends = [(a["start"]["id"], a["end"]["id"]) for a in after["arrows"]]
    assert ("s", j["id"]) in ends and {e[1] for e in ends if e[0] == j["id"]} == {f"t{i}" for i in range(4)}
    assert not any(e == ("s", f"t{i}") for e in ends for i in range(4))


def test_a_fan_of_three_is_left_alone_even_when_a_junction_is_asked_for():
    s = scene([node("s")] + [node(f"t{i}") for i in range(3)], [arrow(f"e{i}", "s", f"t{i}") for i in range(3)])
    assert layout(s, movable={"s", "t0", "t1", "t2"}, bus=True)["junctions"] == []


def test_a_cycle_is_laid_out_without_getting_stuck():
    s = scene([node("a"), node("b"), node("c")], [arrow("e1", "a", "b"), arrow("e2", "b", "c"), arrow("e3", "c", "a")])
    r = lint(apply_layout(s, layout(s, movable={"a", "b", "c"})))
    assert r["counts"]["overlaps"] == 0 and r["counts"]["throughNodes"] == 0


def test_the_same_input_gives_the_same_layout():
    s = scene([node(f"n{i}") for i in range(7)], [arrow(f"e{i}", f"n{i}", f"n{(i * 3 + 1) % 7}") for i in range(7) if i != (i * 3 + 1) % 7])
    ids = {f"n{i}" for i in range(7)}
    assert layout(s, movable=ids) == layout(s, movable=ids)
