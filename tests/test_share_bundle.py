"""Share bundles (web/docs/sharing.md §7): what leaves a project, what a project accepts, and the
quick (account-less) share's rules. Cloudflare and cf are replaced by fakes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.canvas.project import ProjectStore
from server.canvas.share import BundleError, ShareError, ShareManager, export_bundle, import_bundle
from tests.test_share import EL, OWNER, Clock, FakeDNS, FakeTunnels, guest, joined, make_share, owner  # noqa: F401
from tests.test_share import env as share_env  # noqa: F401

CHILD = [{"id": "n1", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "isDeleted": False, "customData": {"codePaths": ["src/**"]}}]
ANCHOR = {"ids": ["api"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 50, "y": 30}}


def project(tmp_path: Path, name: str = "proj") -> ProjectStore:
    store = ProjectStore(tmp_path / name)
    store.root.mkdir()
    store.init()
    return store


def seed(store: ProjectStore) -> None:
    root_els = [dict(EL[0], customData={"codePaths": ["server/**"], "childCanvas": "c2", "cwd": str(store.root)}), EL[1], dict(EL[1], id="ghost", isDeleted=True)]
    store.write("canvas", "c1", {"elements": root_els}, base=None)
    store.write("canvas", "c2", {"elements": CHILD}, base=None)
    store.write("canvas", "c3", {"elements": CHILD}, base=None)  # not below c1: never leaves
    store.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}, {"id": "c2", "kind": "canvas", "title": "用户模块"}, {"id": "c3", "kind": "canvas", "title": "私有"}], "root": {}, "focused": "c1"}, base=None)
    msgs = [{"id": "m1", "author": "human", "by": OWNER, "text": "看这里", "at": 1}, {"id": "m2", "author": "agent", "text": "改好了", "at": 2, "sessionId": "s-secret", "turnId": "t-9"}]
    store.write("threads", "c1", {"seq": 1, "threads": [{"id": "t1", "n": 1, "resolved": False, "createdAt": 1, "createdBy": OWNER, "anchor": ANCHOR, "messages": msgs}]}, base=None)


def good_bundle(**over) -> dict:
    b = {
        "format": "agora-share-bundle", "version": 1,
        "manifest": {"project": "他人的项目", "root": "a", "title": "架构图", "createdAt": 1},
        "canvases": {
            "a": {"title": "架构图", "elements": [dict(EL[0], customData={"childCanvas": "b"}), EL[1]],
                  "threads": {"seq": 1, "threads": [{"id": "t1", "n": 1, "anchor": ANCHOR, "resolved": False, "createdAt": 1, "messages": [{"id": "m1", "author": "human", "text": "hi", "at": 1, "by": {"id": "guest:x", "name": "甲"}}]}]}},
            "b": {"title": "用户模块", "elements": CHILD, "threads": {"seq": 0, "threads": []}},
        },
    }
    b.update(over)
    return b


# ——— export ———
def test_export_carries_no_code_paths_local_paths_or_emails(tmp_path):
    store = project(tmp_path)
    seed(store)
    b = export_bundle(store, "c1", "架构图")
    text = json.dumps(b, ensure_ascii=False)
    for secret in ("codePaths", "server/**", str(store.root), "owner@example.com", "s-secret", "t-9", "cwd"):
        assert secret not in text
    assert b["format"] == "agora-share-bundle" and b["version"] == 1
    assert set(b["canvases"]) == {"c1", "c2"} and "c3" not in b["canvases"]  # only what the share reaches
    assert b["manifest"]["root"] == "c1" and b["manifest"]["title"] == "架构图"
    els = {e["id"]: e for e in b["canvases"]["c1"]["elements"]}
    assert "ghost" not in els and els["api"]["customData"] == {"childCanvas": "c2"}
    assert b["canvases"]["c1"]["threads"]["threads"][0]["messages"][0]["by"]["id"].startswith("member:")


# ——— import ———
def test_import_creates_new_canvases_with_readonly_history(tmp_path):
    store = project(tmp_path, "mine")
    res = import_bundle(store, good_bundle())
    root = res["canvasId"]
    assert root != "a" and res["canvases"] == 2 and res["threads"] == 1
    ws = store.read("workspace")[0]
    titles = {d["id"]: d["title"] for d in ws["docs"]}
    assert titles[root].startswith("来自 他人的项目") and "架构图" in titles[root]
    assert ws["focused"] == root and ws["root"]["kind"] == "group" and ws["root"]["tabs"] == [root]  # opens on it
    scene = store.read("canvas", root)[0]
    child = next(e for e in scene["elements"] if e["id"] == "api")["customData"]["childCanvas"]
    assert child != "b" and store.read("canvas", child) is not None  # link follows the new id
    t = store.read("threads", root)[0]["threads"][0]
    assert t["imported"] and t["messages"][0]["by"]["id"].startswith("imported:") and t["messages"][0]["text"] == "hi"
    assert "guest:" not in json.dumps(t)  # a returning guest id must not match an imported author


def test_import_twice_gives_two_canvases_and_never_overwrites(tmp_path):
    store = project(tmp_path, "mine")
    a, b = import_bundle(store, good_bundle()), import_bundle(store, good_bundle())
    assert a["canvasId"] != b["canvasId"]
    assert len(store.read("workspace")[0]["docs"]) == 4


def test_import_keeps_existing_workspace(tmp_path):
    store = project(tmp_path, "mine")
    seed(store)
    before = store.read("workspace")[0]
    import_bundle(store, good_bundle())
    after = store.read("workspace")[0]
    assert after["focused"] == before["focused"] and after["docs"][:3] == before["docs"] and len(after["docs"]) == 5


def test_import_drops_customdata_and_dangerous_elements(tmp_path):
    store = project(tmp_path, "mine")
    b = good_bundle()
    b["canvases"]["a"]["elements"] += [
        {"id": "e1", "type": "embeddable", "x": 0, "y": 0, "width": 10, "height": 10, "link": "https://evil.example"},
        {"id": "e2", "type": "image", "x": 0, "y": 0, "width": 10, "height": 10, "fileId": "f"},
        {"id": "e3", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "link": "javascript:alert(1)", "customData": {"codePaths": ["/etc/**"], "childCanvas": "../../x"}},
    ]
    res = import_bundle(store, b)
    els = {e["id"]: e for e in store.read("canvas", res["canvasId"])[0]["elements"]}
    assert "e1" not in els and "e2" not in els
    assert "link" not in els["e3"] and "customData" not in els["e3"]
    assert "codePaths" not in json.dumps(els)


@pytest.mark.parametrize("mutate,why", [
    (lambda b: b.update(format="other"), "format"),
    (lambda b: b.update(version=2), "version"),
    (lambda b: b.update(canvases={}), "empty"),
    (lambda b: b["manifest"].update(root="zzz"), "root"),
    (lambda b: b["canvases"].update({"../evil": b["canvases"]["a"]}), "id"),
    (lambda b: b["canvases"]["a"].update(elements="nope"), "elements"),
    (lambda b: b["canvases"]["a"]["elements"].append({"id": "x", "type": "rectangle", "x": float("inf"), "y": 0, "width": 1, "height": 1}), "finite"),
    (lambda b: b["canvases"]["a"]["elements"].append({"type": "rectangle"}), "no id"),
])
def test_import_rejects_malformed_bundles(tmp_path, mutate, why):
    store = project(tmp_path, "mine")
    b = good_bundle()
    mutate(b)
    with pytest.raises(BundleError):
        import_bundle(store, b)
    assert store.read("workspace") is None and not list((store.dir / "canvases").glob("*"))  # nothing half-written


def test_import_rejects_oversized_bundles(tmp_path):
    store = project(tmp_path, "mine")
    b = good_bundle()
    b["canvases"]["a"]["elements"] = [{"id": f"e{i}", "type": "rectangle", "x": 0, "y": 0, "width": 1, "height": 1} for i in range(20001)]
    with pytest.raises(BundleError, match="too many elements"):
        import_bundle(store, b)
    b = good_bundle()
    b["canvases"] = {f"c{i}": b["canvases"]["a"] for i in range(201)}
    b["manifest"]["root"] = "c0"
    with pytest.raises(BundleError, match="too many canvases"):
        import_bundle(store, b)
    b = good_bundle()
    b["canvases"]["a"]["threads"]["threads"][0]["messages"][0]["text"] = "x" * 5000
    with pytest.raises(BundleError, match="too long"):
        import_bundle(store, b)


def test_import_writes_only_inside_dot_agora(tmp_path):
    store = project(tmp_path, "mine")
    before = {p for p in tmp_path.rglob("*") if p.is_file()}
    import_bundle(store, good_bundle())
    new = {p for p in tmp_path.rglob("*") if p.is_file()} - before
    assert new and all(store.dir in p.parents for p in new)


# ——— gateway: GET /api/guest/bundle ———
async def test_gateway_bundle_needs_the_token_cookie_and_matches_export(share_env):
    store, shares, dns, tunnels, clock, app = share_env
    _, _, host, token = await make_share(app)
    anon = guest(app, host)
    assert (await anon.get("/api/guest/bundle")).status_code == 403
    g = await joined(app, host, token)
    r = await g.get("/api/guest/bundle")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    assert r.json()["canvases"]["c1"]["elements"] == export_bundle(store, "c1", "架构图")["canvases"]["c1"]["elements"]
    assert "codePaths" not in r.text and "owner@example.com" not in r.text
    assert (await g.post("/api/guest/bundle", json={})).status_code == 403  # read-only route


# ——— quick share ———
class FakeQuick:
    """Stands in for ``cf tunnels quick-start``: a process that has printed its address."""

    def __init__(self, host: str = "fast-fox-demo.trycloudflare.com") -> None:
        self.host, self.pid, self.running = host, 4242, True

    def alive(self):
        return self.running

    def wait_ready(self, timeout):
        return True

    def stop(self):
        self.running = False


@pytest.fixture
def quick(tmp_path):
    store = project(tmp_path, "q")
    seed(store)
    started: list[FakeQuick] = []

    def factory(port: int, log: Path):
        assert port == 45678
        q = FakeQuick(f"fox-{len(started)}.trycloudflare.com")
        started.append(q)
        return q

    m = ShareManager(store, config_dir=tmp_path / "cfg", clock=Clock(), quick=factory)
    m.gateway_port = 45678
    return store, m, started


def test_quick_share_needs_no_cloudflare_account(quick):
    store, m, started = quick
    share, url = m.create("c1", 600, "架构图", quick=True)  # no DNS / tunnel providers exist here
    assert url.startswith("https://fox-0.trycloudflare.com/s/") and share["host"] == "fox-0.trycloudflare.com" and share["quick"]
    assert m.verify("fox-0.trycloudflare.com", url.rsplit("/", 1)[1]) is not None  # path token, same rules as any share


def test_quick_share_allows_one_share_at_a_time(quick):
    store, m, started = quick
    m.create("c1", 600, "架构图", quick=True)
    with pytest.raises(ShareError, match="one share at a time"):
        m.create("c1", 600, "架构图", quick=True)
    assert len(started) == 1


def test_quick_share_ends_with_its_process(quick):
    store, m, started = quick
    share, url = m.create("c1", 600, "架构图", quick=True)
    m.revoke(share["id"])
    assert not started[0].running and m.active() == []
    assert m.verify(share["host"], url.rsplit("/", 1)[1]) is None
    share2, _ = m.create("c1", 600, "架构图", quick=True)  # the slot is free again
    m.shutdown()  # agora down: the address dies with the process, so the share ends too
    assert not started[1].running and m.active() == []


def test_quick_share_that_lost_its_process_is_ended_by_the_sweep(quick):
    store, m, started = quick
    m.create("c1", 600, "架构图", quick=True)
    started[0].running = False
    assert len(m.sweep()) == 1 and m.active() == []


def test_quick_share_keeps_the_opening_limit(quick):
    store, m, started = quick
    share, _ = m.create("c1", 600, "架构图", max_opens=1, quick=True)
    s = m.get(share["id"])
    assert m.admit(s, "a" * 16) and not m.admit(s, "b" * 16)


# ——— CLI: export → import between two projects ———
def test_cli_export_then_import_round_trip(tmp_path, capsys):
    import argparse

    from agora_cli.main import Project
    from agora_cli.share import cmd_export, cmd_import

    src, dst = project(tmp_path, "src"), tmp_path / "dst"
    seed(src)
    out = tmp_path / "x.agora-share.json"
    assert cmd_export(Project(str(src.root)), argparse.Namespace(canvas="c1", output=str(out))) == 0
    assert "收不回来" in capsys.readouterr().out
    dst.mkdir()
    assert cmd_import(Project(str(dst)), argparse.Namespace(source=str(out))) == 0  # a bare directory gets its .agora/
    titles = [d["title"] for d in ProjectStore(dst).read("workspace")[0]["docs"]]
    assert len(titles) == 2 and all(t.startswith("来自 src · ") for t in titles)


def test_cli_import_refuses_junk_and_missing_files(tmp_path, capsys):
    import argparse

    from agora_cli.main import Project
    from agora_cli.share import cmd_import

    store = project(tmp_path, "mine")
    junk = tmp_path / "junk.json"
    junk.write_text("<html>not json</html>")
    for src in (str(junk), str(tmp_path / "missing.json")):
        assert cmd_import(Project(str(store.root)), argparse.Namespace(source=src)) == 1
    assert store.read("workspace") is None
    assert "agora import:" in capsys.readouterr().out
