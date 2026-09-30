"""The plan's referential rules on the server side (server/canvas/plan_rules.py): the same rule file and the same cases as the
page's validatePlan (web/src/ops/planRules.test.ts), so the fallback executor validates exactly like the page."""

import json
from pathlib import Path

import pytest

from server.canvas import plan_rules

GEN = Path(__file__).resolve().parents[1] / "web" / "generated"
CASES = json.loads((GEN / "plan.cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_same_cases_as_the_page_give_the_same_errors(case):
    got = plan_rules.validate_plan(case["plan"], kind=lambda i: case["scene"].get(i), library_item=lambda i: i in case["library"])
    assert got == case["errors"]


def test_the_rules_are_the_page_s_file_not_a_copy():
    assert plan_rules.load() == json.loads((GEN / "plan.rules.json").read_text())
    assert set(plan_rules.load()["ops"]) == {"update_text", "move", "resize", "add_shape", "add_arrow", "add_junction", "route", "delete", "insert_library_item"}


def test_referenced_ids_are_the_existing_elements_a_plan_reads_or_writes():
    plan = {"ops": [{"op": "move", "id": "a", "x": 1, "y": 2}, {"op": "add_arrow", "from": "a", "to": "b"}, {"op": "add_shape", "ref": "n", "shape": "rectangle", "text": "t", "x": 0, "y": 0, "frameId": "f"}, {"op": "insert_library_item", "ref": "l", "item": "i", "near": {"id": "b", "side": "left"}}]}
    assert sorted(plan_rules.referenced_ids(plan)) == ["a", "b", "f"]


def test_freshness_names_the_elements_changed_since_the_read():
    els = [{"id": "a", "type": "rectangle", "version": 3, "isDeleted": False}, {"id": "b", "type": "rectangle", "version": 5, "isDeleted": False, "boundElements": [{"id": "bt", "type": "text"}]}, {"id": "bt", "type": "text", "version": 2, "isDeleted": False}, {"id": "c", "type": "rectangle", "version": 1, "isDeleted": True}]
    versions = {"a": "3", "b": "5.2", "c": "1"}
    assert plan_rules.stale_ids(versions, ["a", "b"], els) == []
    assert plan_rules.stale_ids({**versions, "a": "2"}, ["a", "b"], els) == ["a"]  # its version moved on
    assert plan_rules.stale_ids({**versions, "b": "5.1"}, ["b"], els) == ["b"]  # its label changed
    assert plan_rules.stale_ids(versions, ["c"], els) == ["c"]  # deleted since
    assert plan_rules.stale_ids(versions, ["new"], els) == []  # created by this plan: nothing to compare


def test_the_scene_index_tells_shapes_arrows_frames_and_library_components_apart():
    els = [
        {"id": "s", "type": "rectangle", "isDeleted": False},
        {"id": "ar", "type": "arrow", "isDeleted": False},
        {"id": "f", "type": "frame", "isDeleted": False},
        {"id": "lib", "type": "rectangle", "isDeleted": False, "customData": {"agora": {"library": True, "group": "g1", "name": "DB"}}},
        {"id": "member", "type": "rectangle", "isDeleted": False, "groupIds": ["g1"]},
        {"id": "gone", "type": "rectangle", "isDeleted": True},
        {"id": "t", "type": "text", "isDeleted": False},
    ]
    kind = plan_rules.scene_kinds(els)
    assert [kind(i) for i in ("s", "ar", "f", "lib", "member", "gone", "t", "nope")] == ["shape", "arrow", "frame", "library", "shape", None, None, None]
