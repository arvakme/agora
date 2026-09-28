"""A page that lost its scene must not be able to save it back: an empty canvas replacing a
non-empty one needs the writer's explicit ``clear``, a stale or missing base is a conflict."""

from pathlib import Path

import httpx
from fastapi import APIRouter

from server.canvas.project_router import create_project_app

EL = {"id": "a", "type": "rectangle", "x": 1, "y": 2, "width": 3, "height": 4, "isDeleted": False}
URL = "/api/project/canvases/c1"


def client(root: Path) -> httpx.AsyncClient:
    app = create_project_app(root, canvas_router=APIRouter(), dist=root / "no-dist")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1")


async def test_unmarked_non_empty_to_empty_is_refused_and_marked_clear_is_taken(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    async with client(root) as c:
        v1 = (await c.put(URL, json={"data": {"elements": [EL]}, "base": None})).json()["version"]
        r = await c.put(URL, json={"data": {"elements": []}, "base": v1})  # right base, no clear flag
        assert r.status_code == 409 and r.json()["code"] == "empty-overwrite"
        r = await c.put(URL, json={"data": {"elements": [{**EL, "isDeleted": True}]}, "base": v1, "force": True})  # force does not lift it
        assert r.status_code == 409 and r.json()["code"] == "empty-overwrite"
        assert len((await c.get("/api/project/snapshot")).json()["canvases"]["c1"]["scene"]["elements"]) == 1
        r = await c.put(URL, json={"data": {"elements": []}, "base": v1, "clear": True})  # the user's own clear
        assert r.status_code == 200
        r = await c.put(URL, json={"data": {"elements": []}, "base": r.json()["version"]})  # empty over empty is nothing to lose
        assert r.status_code == 200


async def test_a_page_loads_the_canvas_and_its_version_before_it_saves(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    async with client(root) as c:
        assert (await c.get(URL)).status_code == 404
        v1 = (await c.put(URL, json={"data": {"elements": [EL]}, "base": None})).json()["version"]
        got = (await c.get(URL)).json()
        assert got["version"] == v1 and got["scene"]["elements"][0]["id"] == "a"


async def test_stale_or_missing_base_on_an_existing_canvas_is_a_conflict(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    async with client(root) as c:
        v1 = (await c.put(URL, json={"data": {"elements": [EL]}, "base": None})).json()["version"]
        await c.put(URL, json={"data": {"elements": [{**EL, "x": 9}]}, "base": v1})
        for body in ({"base": v1}, {}):  # an old version; no version at all
            r = await c.put(URL, json={"data": {"elements": [{**EL, "x": 5}]}, **body})
            assert r.status_code == 409 and r.json()["conflict"] is True
        assert (await c.get("/api/project/snapshot")).json()["canvases"]["c1"]["scene"]["elements"][0]["x"] == 9
