"""What an agent reads about how the lines run: a line drawn as anything but the plain straight one shows
its ``path``, and a junction dot is listed apart from the nodes (it is not one)."""

from server.canvas.model_view import model_view


def box(i, x, y, w=160, h=64):
    return {"id": i, "type": "rectangle", "x": x, "y": y, "width": w, "height": h, "boundElements": []}


def arrow(i, a, b, x, y, points, **kw):
    return {"id": i, "type": "arrow", "x": x, "y": y, "width": 0, "height": 0, "points": points, "startBinding": {"elementId": a}, "endBinding": {"elementId": b}, "startArrowhead": None, "endArrowhead": "arrow", **kw}


A, B = box("a", 0, 0), box("b", 0, 300)


def test_a_plain_straight_arrow_has_no_path():
    # 80,70 → 80,294: what the page draws between two boxes stacked in a column
    v = model_view([A, B, arrow("e", "a", "b", 80, 70, [[0, 0], [0, 224]])])
    assert "path" not in v["arrows"][0]


def test_an_arrow_that_bends_shows_its_absolute_points():
    v = model_view([A, B, arrow("e", "a", "b", 40, 70, [[0, 0], [0, 100], [80, 100], [80, 224]])])
    assert v["arrows"][0]["path"] == [[40, 70], [40, 170], [120, 170], [120, 294]]


def test_a_straight_arrow_attached_off_centre_shows_its_path_too():
    v = model_view([A, B, arrow("e", "a", "b", 30, 70, [[0, 0], [10, 224]])])
    assert v["arrows"][0]["path"] == [[30, 70], [40, 294]]


def test_a_junction_dot_is_listed_apart_and_lines_may_end_on_it():
    dot = {"id": "j", "type": "ellipse", "x": 75, "y": 145, "width": 10, "height": 10, "customData": {"junction": True}}
    v = model_view([A, B, dot, arrow("e", "a", "j", 80, 70, [[0, 0], [0, 80]])])
    assert [n["id"] for n in v["nodes"]] == ["a", "b"]
    assert v["junctions"] == [{"id": "j", "x": 75, "y": 145, "width": 10, "height": 10}]
    assert v["arrows"][0]["end"] == {"id": "j"}


def test_a_scene_without_junctions_reads_as_before():
    assert "junctions" not in model_view([A, B])
