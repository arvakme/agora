"""``agora canvas lint``: what a diagram looks like to a reader, measured (crossings, lines through
unrelated nodes, overlaps, label clashes, length, bends). Pure function of the scene an agent reads."""

from server.canvas.graph_lint import lint


def node(i, x, y, w=80, h=40, label=None):
    return {"id": i, "type": "rectangle", "label": label or i, "x": x, "y": y, "width": w, "height": h}


def arrow(i, a, b, **kw):
    return {"id": i, "type": "arrow", "start": {"id": a}, "end": {"id": b}, **kw}


def scene(nodes, arrows, junctions=()):
    return {"nodes": nodes, "arrows": arrows, "frames": [], "junctions": list(junctions)}


def counts(s):
    return lint(s)["counts"]


def test_parallel_lines_do_not_cross():
    s = scene([node("a", 0, 0), node("b", 0, 200), node("c", 200, 0), node("d", 200, 200)], [arrow("e1", "a", "b"), arrow("e2", "c", "d")])
    assert counts(s)["crossings"] == 0


def test_two_lines_that_swap_sides_cross_once_and_the_pair_is_named():
    s = scene([node("a", 0, 0), node("b", 200, 0), node("c", 0, 200), node("d", 200, 200)], [arrow("e1", "a", "d"), arrow("e2", "b", "c")])
    r = lint(s)
    assert r["counts"]["crossings"] == 1
    assert {r["crossings"][0]["a"], r["crossings"][0]["b"]} == {"e1", "e2"}
    assert "交叉 1 处" in r["summary"]


def test_lines_sharing_an_end_node_do_not_cross_there():
    s = scene([node("a", 0, 0), node("b", -100, 200), node("c", 100, 200)], [arrow("e1", "a", "b"), arrow("e2", "a", "c")])
    assert counts(s)["crossings"] == 0


def test_a_line_through_an_unrelated_node_is_reported_with_both_names():
    s = scene([node("a", 0, 100, label="API"), node("m", 200, 100, label="Cache"), node("b", 400, 100)], [arrow("e1", "a", "b")])
    r = lint(s)
    assert r["counts"]["throughNodes"] == 1
    assert r["throughNodes"][0]["arrow"] == "e1" and r["throughNodes"][0]["node"] == "m"
    assert "Cache" in r["throughNodes"][0]["text"]


def test_a_line_does_not_count_as_passing_through_its_own_ends():
    s = scene([node("a", 0, 0), node("b", 300, 0)], [arrow("e1", "a", "b")])
    assert counts(s)["throughNodes"] == 0


def test_overlapping_nodes_and_nodes_closer_than_the_gap_are_two_different_findings():
    s = scene([node("a", 0, 0), node("b", 40, 10), node("c", 300, 0), node("d", 400, 0)], [])
    r = lint(s)
    assert r["counts"]["overlaps"] == 1 and r["overlaps"][0]["a"] == "a"
    assert r["counts"]["tooClose"] == 1 and {r["tooClose"][0]["a"], r["tooClose"][0]["b"]} == {"c", "d"}


def test_an_arrow_label_on_top_of_a_node_is_a_clash():
    # the label sits at the middle of the line, where node m stands beside the line
    s = scene([node("a", 0, 0), node("b", 0, 300), node("m", 20, 130, w=120, h=40)], [arrow("e1", "a", "b", label="写入订单")])
    assert counts(s)["labelClashes"] >= 1


def test_bends_and_length_come_from_the_drawn_path():
    s = scene([node("a", 0, 0), node("b", 200, 200)], [arrow("e1", "a", "b", path=[[40, 46], [40, 120], [240, 120], [240, 194]])])
    c = counts(s)
    assert c["bends"] == 2
    assert c["length"] == 74 + 200 + 74


def test_a_declared_hop_is_not_a_crossing():
    # e2 hops over e1 at (100,100): a small bump in a horizontal line
    nodes = [node("a", 80, 0), node("b", 80, 200), node("c", -60, 80), node("d", 220, 80)]
    plain = scene(nodes, [arrow("e1", "a", "b", path=[[120, 46], [120, 194]]), arrow("e2", "c", "d", path=[[-20, 100], [220, 100]])])
    assert counts(plain)["crossings"] == 1
    hopped = scene(nodes, [arrow("e1", "a", "b", path=[[120, 46], [120, 194]]), arrow("e2", "c", "d", path=[[-20, 100], [110, 100], [110, 92], [130, 92], [130, 100], [220, 100]])])
    c = counts(hopped)
    assert c["crossings"] == 0 and c["hops"] == 1


def test_two_lines_attached_at_the_same_spot_of_one_node_are_stacked():
    s = scene(
        [node("a", 0, 0), node("b", -100, 200), node("c", 100, 200)],
        [arrow("e1", "a", "b", path=[[40, 46], [-60, 194]]), arrow("e2", "a", "c", path=[[42, 46], [140, 194]])],
    )
    r = lint(s)
    assert r["counts"]["stackedAnchors"] == 1
    assert r["stackedAnchors"][0]["node"] == "a"


def test_junction_dots_are_not_nodes_and_lines_meeting_at_one_do_not_cross():
    s = scene(
        [node("s", 100, 0), node("t1", 0, 300), node("t2", 200, 300)],
        [
            arrow("trunk", "s", "j", path=[[140, 46], [140, 150]]),
            arrow("b1", "j", "t1", path=[[140, 150], [40, 150], [40, 294]]),
            arrow("b2", "j", "t2", path=[[140, 150], [240, 150], [240, 294]]),
        ],
        junctions=[{"id": "j", "x": 134, "y": 144, "width": 12, "height": 12}],
    )
    r = lint(s)
    assert r["counts"]["nodes"] == 3
    assert r["counts"]["crossings"] == 0 and r["counts"]["overlaps"] == 0 and r["counts"]["throughNodes"] == 0


def test_summary_is_one_sentence_of_counts_and_a_clean_diagram_says_so():
    s = scene([node("a", 0, 0), node("b", 0, 200)], [arrow("e1", "a", "b")])
    r = lint(s)
    assert r["ok"] is True and "没有交叉" in r["summary"]
    assert "\n" not in r["summary"]


def test_the_branches_of_a_bus_touch_at_its_corners_and_that_is_not_a_crossing():
    # two branches of one junction: the far one runs along the near one's bar and drops beyond its corner
    s = scene(
        [node("t1", 0, 300), node("t2", 200, 300), node("h", 300, 0)],
        [
            arrow("b1", "j", "t1", path=[[300, 150], [80, 150], [80, 294]]),
            arrow("b2", "j", "t2", path=[[300, 150], [280.4, 150.2], [280, 294]]),  # a rounding error away from the corner
        ],
        junctions=[{"id": "j", "x": 295, "y": 145, "width": 10, "height": 10}],
    )
    r = lint(s)
    assert r["counts"]["crossings"] == 0 and r["counts"]["lineOverlaps"] == 0


def test_a_label_wider_than_its_box_is_reported_so_the_box_can_be_widened():
    s = scene([node("a", 0, 0, w=160, label="controlplane\nGo 控制面 (Connect API)"), node("b", 0, 300, label="db")], [arrow("e", "a", "b")])
    r = lint(s)
    assert r["counts"]["textOverflow"] == 1 and r["textOverflow"][0]["node"] == "a"
    assert "文字" in r["summary"] or "标签" in r["summary"]
    assert lint(scene([node("b", 0, 300, label="db")], []))["counts"]["textOverflow"] == 0
