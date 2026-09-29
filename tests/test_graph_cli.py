"""``agora canvas lint`` / ``layout`` / ``schema ops`` without a server: they read the project's files."""

import json

import pytest

from server.canvas.project import ProjectStore


def box(i, x, y):
    return [
        {"id": i, "type": "rectangle", "x": x, "y": y, "width": 160, "height": 64, "version": 1, "isDeleted": False, "groupIds": [], "boundElements": [{"id": f"{i}-t", "type": "text"}]},
        {"id": f"{i}-t", "type": "text", "x": x + 10, "y": y + 20, "width": 100, "height": 20, "version": 1, "isDeleted": False, "text": i.upper(), "originalText": i.upper(), "containerId": i},
    ]


def line(i, a, b, x, y, pts):
    return {"id": i, "type": "arrow", "x": x, "y": y, "width": 1, "height": 1, "points": pts, "version": 1, "isDeleted": False, "groupIds": [], "startBinding": {"elementId": a, "focus": 0, "gap": 6}, "endBinding": {"elementId": b, "focus": 0, "gap": 6}, "startArrowhead": None, "endArrowhead": "arrow", "boundElements": []}


@pytest.fixture()
def project(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    # a1→b2 and a2→b1 cross once
    els = [*box("a1", 0, 0), *box("a2", 300, 0), *box("b1", 0, 300), *box("b2", 300, 300), line("e1", "a1", "b2", 80, 70, [[0, 0], [300, 224]]), line("e2", "a2", "b1", 380, 70, [[0, 0], [-300, 224]])]
    s.write("canvas", "c1", {"elements": els}, base=None)
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构"}], "root": {}, "focused": "c1"}, base=None)
    return s


def run(project, capsys, *args):
    from agora_cli.main import main

    code = main(["canvas", "--project", str(project.root), *args])
    return code, json.loads(capsys.readouterr().out)


def test_lint_reads_the_file_and_names_the_crossing(project, capsys):
    code, out = run(project, capsys, "lint")
    assert code == 0 and out["counts"]["crossings"] == 1 and "交叉 1 处" in out["summary"]
    assert {out["crossings"][0]["a"], out["crossings"][0]["b"]} == {"e1", "e2"}


def test_layout_needs_to_be_told_which_nodes_and_only_previews_without_apply(project, capsys):
    code, out = run(project, capsys, "layout")
    assert code == 2 and "--nodes" in out["error"]
    before = (project.root / ".agora" / "canvases" / "c1.excalidraw").read_bytes()
    code, out = run(project, capsys, "layout", "--all")
    assert code == 0 and out["status"] == "preview" and out["before"]["counts"]["crossings"] == 1 and out["after"]["counts"]["crossings"] == 0
    assert (project.root / ".agora" / "canvases" / "c1.excalidraw").read_bytes() == before
    code, out = run(project, capsys, "layout", "--all", "--apply")
    assert code == 3  # the page has to do it


def test_the_ops_schema_lists_the_layout_op_agents_may_end_a_batch_with(project, capsys):
    code, out = run(project, capsys, "schema", "ops")
    kinds = [v["properties"]["op"]["const"] for v in out["properties"]["ops"]["items"]["anyOf"]]
    assert code == 0 and "layout" in kinds and "add_shape" in kinds
