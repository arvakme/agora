"""Sharing (web/docs/sharing.md): guest whitelist, expiry and revoke, hashed tokens, and the
DNS / tunnel cleanup, with Cloudflare and cloudflared replaced by fakes."""

from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter

from server.canvas import share as share_mod
from server.canvas.events import Events
from server.canvas.project import ProjectStore, merge_thread_files
from server.canvas.project_router import create_project_app
from server.canvas.share import RateLimiter, ShareManager, guest_threads, parse_duration, token_hash


# ——— fakes ———
class FakeDNS:
    def __init__(self) -> None:
        self.records: dict[str, dict] = {}
        self.deleted: list[str] = []
        self.fail_delete = False
        self.n = 0

    def zone_name(self) -> str:
        return "example.test"

    def create_cname(self, name, target, comment):
        self.n += 1
        rid = f"rec{self.n}"
        self.records[rid] = {"name": name, "target": target, "comment": comment}
        return rid

    def delete(self, rid):
        if self.fail_delete:
            raise RuntimeError("api down")
        self.records.pop(rid, None)
        self.deleted.append(rid)

    def exists(self, rid):
        return rid in self.records


class FakeProc:
    def __init__(self, pid):
        self.pid = pid
        self.running = True

    def alive(self):
        return self.running

    def wait_ready(self, timeout):
        return True

    def stop(self):
        self.running = False


class FakeTunnels:
    def __init__(self) -> None:
        self.tunnels: dict[str, str] = {}  # id -> name
        self.procs: list[FakeProc] = []
        self.deleted: list[str] = []
        self.n = 0

    def find(self, name):
        return next((i for i, n in self.tunnels.items() if n == name), None)

    def create(self, name, credentials: Path):
        self.n += 1
        tid = f"tun-{self.n}"
        credentials.write_text('{"TunnelSecret": "s"}')
        self.tunnels[tid] = name
        return tid

    def delete(self, tid):
        self.tunnels.pop(tid)
        self.deleted.append(tid)

    def start(self, tid, credentials, config, log):
        assert credentials.exists() and "service: http://127.0.0.1:" in config.read_text()
        p = FakeProc(1000 + len(self.procs))
        self.procs.append(p)
        return p


class Clock:
    def __init__(self, t: float = 1_800_000_000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


EL = [
    {"id": "api", "type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 60, "isDeleted": False, "customData": {"codePaths": ["server/**"]}},
    {"id": "db", "type": "ellipse", "x": 200, "y": 0, "width": 80, "height": 60, "isDeleted": False},
]
OWNER = {"id": "mailto:owner@example.com", "name": "Owner"}


@pytest.fixture
def env(tmp_path):
    store = ProjectStore(tmp_path / "proj")
    store.root.mkdir()
    store.init()
    store.write("canvas", "c1", {"elements": EL}, base=None)
    store.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    store.write(
        "threads",
        "c1",
        {"seq": 1, "threads": [{"id": "t1", "n": 1, "resolved": False, "createdAt": 1, "createdBy": OWNER, "anchor": {"ids": ["api"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 50, "y": 30}},
                                "messages": [{"id": "m1", "author": "human", "by": OWNER, "text": "看这里", "at": 1},
                                             {"id": "m2", "author": "agent", "text": "改好了", "at": 2, "sessionId": "s-secret", "turnId": "t-9"}]}]},
        base=None,
    )
    dns, tunnels, clock = FakeDNS(), FakeTunnels(), Clock()
    shares = ShareManager(store, providers=lambda: (dns, tunnels), config_dir=tmp_path / "cfg", clock=clock)
    shares.gateway_port = 45678
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><html><head><title>Agora</title></head><body><div id=root></div></body></html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    app = create_project_app(store.root, canvas_router=APIRouter(), dist=dist, shares=shares)
    return store, shares, dns, tunnels, clock, app


def owner(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000")


def guest(app, host: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app.state.gateway), base_url=f"https://{host}")


async def make_share(app, ttl=600) -> tuple[dict, str, str, str]:
    async with owner(app) as c:
        r = await c.post("/api/share", json={"canvasId": "c1", "ttl": ttl})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    host = url.split("/")[2]
    token = url.rsplit("/", 1)[1]
    return r.json()["share"], url, host, token


async def joined(app, host, token) -> httpx.AsyncClient:
    g = guest(app, host)
    r = await g.get(f"/s/{token}")
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert "agora_share" in g.cookies and "agora_guest" in g.cookies
    return g


# ——— durations ———
def test_parse_duration():
    assert parse_duration("10m") == 600 and parse_duration("2h") == 7200 and parse_duration("1d") == 86400 and parse_duration("7d") == 7 * 86400
    assert parse_duration("forever") is None and parse_duration("never") is None
    for bad in ("", "10", "5s", "100d", "abc"):
        with pytest.raises(ValueError):
            parse_duration(bad)


# ——— tokens ———
async def test_token_is_stored_only_as_hash_and_records_are_ignored_by_git(env):
    store, shares, dns, tunnels, clock, app = env
    share, url, host, token = await make_share(app)
    assert host.endswith(".example.test") and host.startswith("proj-") and host.count(".") == 2  # one level under the zone
    rec = json.loads((store.dir / "shares" / "shares.json").read_text())["shares"][0]
    assert rec["tokenHash"] == hashlib.sha256(token.encode()).hexdigest()
    everything = "".join(p.read_text(errors="ignore") for p in store.dir.rglob("*") if p.is_file())
    assert token not in everything
    assert "tokenHash" not in share and "tokenHash" not in json.dumps(shares.list())
    # the records never reach git, even with a .gitignore that predates sharing
    (store.dir / ".gitignore").write_text("sessions/\nrun/\n")
    subprocess.run(["git", "init", "-q"], cwd=store.root, check=True)
    r = subprocess.run(["git", "check-ignore", "-q", ".agora/shares/shares.json"], cwd=store.root)
    assert r.returncode == 0


async def test_token_compare_is_constant_time(env, monkeypatch):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    seen = []
    real = share_mod.hmac.compare_digest
    monkeypatch.setattr(share_mod.hmac, "compare_digest", lambda a, b: seen.append((a, b)) or real(a, b))
    assert shares.verify(host, token) is not None
    assert shares.verify(host, token[:-1] + ("A" if token[-1] != "A" else "B")) is None
    assert len(seen) == 2 and all(a == token_hash(token) or b == token_hash(token) for a, b in seen)


# ——— guest whitelist ———
async def test_guest_can_view_and_comment(env):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    g = await joined(app, host, token)
    page = await g.get("/")
    assert page.status_code == 200 and 'name="robots" content="noindex' in page.text and 'name="agora-guest"' in page.text
    assert page.headers["x-robots-tag"].startswith("noindex") and page.headers["referrer-policy"] == "no-referrer"
    assert (await g.get("/assets/app.js")).status_code == 200

    st = (await g.get("/api/guest/state")).json()
    assert st["canvas"]["title"] == "架构图" and [e["id"] for e in st["canvas"]["elements"]] == ["api", "db"]
    dump = json.dumps(st, ensure_ascii=False)
    for secret in ("codePaths", "customData", "owner@example.com", "s-secret", "t-9", str(store.root)):
        assert secret not in dump, secret
    assert st["threads"]["threads"][0]["messages"][0]["by"]["name"] == "Owner"

    r = await g.post("/api/guest/comments", json={"op": "create", "threadId": "g1", "id": "gm1", "name": "访客甲", "text": "数据库为什么是椭圆？",
                                                  "anchor": {"ids": ["db"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 240, "y": 30}}})
    assert r.status_code == 200, r.text
    assert r.json()["thread"]["n"] == 2  # numbered by the server
    r = await g.post("/api/guest/comments", json={"op": "reply", "threadId": "t1", "id": "gm2", "name": "访客甲", "text": "同意"})
    assert r.status_code == 200
    data = store.read("threads", "c1")[0]
    gid = "guest:" + g.cookies["agora_guest"]
    new = next(t for t in data["threads"] if t["id"] == "g1")
    assert new["createdBy"] == {"id": gid, "name": "访客甲"} and new["messages"][0]["author"] == "human"
    assert data["threads"][0]["messages"][-1]["by"]["id"] == gid
    assert {p["id"] for p in data["threads"][0]["participants"]} == {OWNER["id"], gid}
    assert shares.get(shares.list()[0]["id"]).comments == 2
    # a guest cannot pin a comment on an element that isn't there, or post junk
    bad = await g.post("/api/guest/comments", json={"op": "create", "threadId": "g2", "id": "gm3", "name": "x", "text": "y", "anchor": {"ids": ["nope"], "rel": {"x": 0, "y": 0}, "last": {"x": 0, "y": 0}}})
    assert bad.status_code == 400
    assert (await g.post("/api/guest/comments", json={"op": "resolve", "threadId": "t1", "id": "x1", "name": "x", "text": "y"})).status_code == 400
    assert (await g.post("/api/guest/comments", json={"op": "reply", "threadId": "t1", "id": "x2", "name": "x", "text": "y" * 5000})).status_code == 400


FORBIDDEN = [
    ("GET", "/api/project"),
    ("GET", "/api/project/snapshot"),
    ("PUT", "/api/project/canvases/c1"),
    ("PUT", "/api/project/threads/c1"),
    ("POST", "/api/project/threads/c1/merge"),
    ("PUT", "/api/project/workspace"),
    ("DELETE", "/api/project/canvases/c1"),
    ("POST", "/api/project/sessions/s1/append"),
    ("POST", "/api/project/import"),
    ("GET", "/api/project/events"),
    ("GET", "/api/agent/catalog"),
    ("GET", "/api/agent/events"),
    ("POST", "/api/agent/sessions/s1/send"),
    ("POST", "/api/agent/sessions/s1/terminal"),
    ("POST", "/api/agent/canvas/apply"),
    ("POST", "/api/agent/canvas/read"),
    ("POST", "/api/canvas/turns"),
    ("GET", "/api/share"),
    ("POST", "/api/share"),
    ("DELETE", "/api/share/x"),
    ("GET", "/libraries/index.json"),
    ("PUT", "/api/guest/state"),
    ("GET", "/api/guest/../project/snapshot"),
]


async def test_everything_off_the_whitelist_is_403(env):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    g = await joined(app, host, token)
    for method, path in FORBIDDEN:
        r = await g.request(method, path, json={} if method != "GET" else None)
        assert r.status_code in (403, 404), (method, path, r.status_code)
        assert r.status_code == 403 or path.startswith("/assets/"), (method, path)
    # without the cookie, with a wrong token, or for another hostname: nothing
    anon = guest(app, host)
    assert (await anon.get("/api/guest/state")).status_code == 403
    assert (await anon.get("/")).status_code == 403
    assert (await anon.get(f"/s/{token[:-2]}xx")).status_code == 403
    other = guest(app, "other.example.test")
    other.cookies.set("agora_share", token)
    assert (await other.get("/api/guest/state")).status_code == 403
    assert (await other.get("/assets/app.js")).status_code == 403
    assert "noindex" in (await anon.get("/")).text


async def test_owner_app_refuses_tunnelled_requests(env):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    async with owner(app) as c:
        assert (await c.get("/api/project/snapshot")).status_code == 200
        assert (await c.get("/api/project/snapshot", headers={"cf-connecting-ip": "1.2.3.4"})).status_code == 403
        assert (await c.get("/api/project/snapshot", headers={"host": host})).status_code == 403


# ——— expiry and revoke ———
async def test_expiry_kills_the_token_and_cleans_dns_and_tunnel(env):
    store, shares, dns, tunnels, clock, app = env
    share, _, host, token = await make_share(app, ttl=120)
    g = await joined(app, host, token)
    assert len(dns.records) == 1 and len(tunnels.tunnels) == 1 and tunnels.procs[0].running
    (rid,) = dns.records
    assert dns.records[rid]["target"] == f"{share['tunnelId']}.cfargotunnel.com"
    clock.t += 121
    assert (await g.get("/api/guest/state")).status_code == 403  # before any sweep: the check itself expires
    assert (await g.get(f"/s/{token}")).status_code == 403
    assert shares.sweep() == [share["id"]]
    assert dns.records == {} and dns.deleted == [rid]
    assert tunnels.tunnels == {} and not tunnels.procs[0].running
    assert not list((shares.config_dir / "tunnels").glob("*"))
    assert shares.list()[0]["status"] == "expired" and shares.list()[0]["cleanup"] == []
    assert not (store.run_dir / "share-tunnel.json").exists()


async def test_revoke_is_immediate_and_tunnel_stays_for_other_shares(env):
    store, shares, dns, tunnels, clock, app = env
    a, _, host_a, token_a = await make_share(app)
    b, _, host_b, token_b = await make_share(app, ttl=None)
    assert a["tunnelId"] == b["tunnelId"] and len(tunnels.procs) == 1  # one connector per project
    g = await joined(app, host_a, token_a)
    async with owner(app) as c:
        r = await c.delete(f"/api/share/{a['id']}")
    assert r.json()["share"]["status"] == "revoked"
    assert (await g.get("/api/guest/state")).status_code == 403
    assert set(dns.records) == {b["dnsRecordId"]} and tunnels.procs[0].running and tunnels.tunnels
    gb = await joined(app, host_b, token_b)
    assert (await gb.get("/api/guest/state")).status_code == 200
    async with owner(app) as c:
        await c.delete(f"/api/share/{b['id']}")
    assert dns.records == {} and tunnels.tunnels == {} and not tunnels.procs[0].running
    assert (await gb.get("/api/guest/state")).status_code == 403


async def test_dns_failure_leaves_token_dead_and_cleanup_retried(env):
    store, shares, dns, tunnels, clock, app = env
    a, _, host, token = await make_share(app)
    dns.fail_delete = True
    shares.revoke(a["id"])
    assert shares.verify(host, token) is None
    assert shares.list()[0]["cleanup"] == ["dns"] and len(dns.records) == 1
    dns.fail_delete = False
    shares.sweep()
    assert shares.list()[0]["cleanup"] == [] and dns.records == {}
    assert tunnels.tunnels == {}


async def test_restart_resumes_active_shares_and_ends_expired(env, tmp_path):
    store, shares, dns, tunnels, clock, app = env
    a, _, host_a, _ = await make_share(app, ttl=120)
    b, _, host_b, token_b = await make_share(app, ttl=3600)
    shares.shutdown()
    assert not tunnels.procs[0].running
    clock.t += 300
    again = ShareManager(store, providers=lambda: (dns, tunnels), config_dir=shares.config_dir, clock=clock)
    again.gateway_port = 45679
    again.resume()
    assert {s["id"]: s["status"] for s in again.list()} == {a["id"]: "expired", b["id"]: "active"}
    assert set(dns.records) == {b["dnsRecordId"]} and tunnels.procs[-1].running and len(tunnels.procs) == 2
    assert again.verify(host_b, token_b) is not None


async def test_create_without_gateway_or_with_bad_input(env):
    store, shares, dns, tunnels, clock, app = env
    async with owner(app) as c:
        assert (await c.post("/api/share", json={"canvasId": "nope", "ttl": 600})).status_code == 400
        assert (await c.post("/api/share", json={"canvasId": "c1", "ttl": 5})).status_code == 400
        shares.gateway_port = None
        r = await c.post("/api/share", json={"canvasId": "c1", "ttl": 600})
        assert r.status_code == 502 and "gateway" in r.json()["detail"]
    assert dns.records == {} and tunnels.tunnels == {}


# ——— rate limits ———
async def test_guest_writes_are_rate_limited(env):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    g = await joined(app, host, token)
    codes = []
    for i in range(25):
        r = await g.post("/api/guest/comments", json={"op": "reply", "threadId": "t1", "id": f"r{i}", "name": "甲", "text": "+1"}, headers={"cf-connecting-ip": "9.9.9.9"})
        codes.append(r.status_code)
    assert codes[:20] == [200] * 20 and set(codes[20:]) == {429}
    # another address is not affected
    r = await g.post("/api/guest/comments", json={"op": "reply", "threadId": "t1", "id": "r-other", "name": "乙", "text": "+1"}, headers={"cf-connecting-ip": "8.8.8.8"})
    assert r.status_code == 200


def test_rate_limiter_refills():
    t = [0.0]
    rl = RateLimiter({"w": (2, 60.0)}, clock=lambda: t[0])
    assert rl.allow("w", "a") and rl.allow("w", "a") and not rl.allow("w", "a")
    t[0] += 30
    assert rl.allow("w", "a") and not rl.allow("w", "a")


# ——— threads written by two parties ———
def test_merge_keeps_both_sides():
    disk = {"seq": 2, "threads": [
        {"id": "t1", "n": 1, "messages": [{"id": "a", "at": 1}, {"id": "g", "at": 3, "by": {"id": "guest:x", "name": "G"}}]},
        {"id": "g1", "n": 2, "messages": [{"id": "gm", "at": 4}]},
    ]}
    page = {"seq": 2, "threads": [
        {"id": "t1", "n": 1, "resolved": True, "messages": [{"id": "a", "at": 1}, {"id": "b", "at": 2}]},
        {"id": "p2", "n": 2, "messages": [{"id": "pm", "at": 5}]},  # created on the page with a clashing number
    ]}
    out = merge_thread_files(disk, page)
    t1 = out["threads"][0]
    assert [m["id"] for m in t1["messages"]] == ["a", "b", "g"] and t1["resolved"] is True
    assert {t["id"]: t["n"] for t in out["threads"]} == {"t1": 1, "p2": 3, "g1": 2}
    assert out["seq"] == 3


async def test_owner_page_sees_guest_comments_live(env):
    store, shares, dns, tunnels, clock, app = env
    _, _, host, token = await make_share(app)
    g = await joined(app, host, token)
    events: Events = app.state.events
    sub = events.subscribe(lambda ev: ev.get("t") == "threads")
    await g.post("/api/guest/comments", json={"op": "reply", "threadId": "t1", "id": "live1", "name": "甲", "text": "实时"})
    ev = await asyncio.wait_for(sub.q.get(), 2)
    assert ev["canvasId"] == "c1" and ev["data"]["threads"][0]["messages"][-1]["text"] == "实时"
    # the owner saving an older snapshot keeps the guest's message (merge, not overwrite)
    stale = {"seq": 1, "threads": [{"id": "t1", "n": 1, "resolved": False, "anchor": {}, "messages": [{"id": "m1", "author": "human", "text": "看这里", "at": 1}, {"id": "o2", "author": "human", "text": "我来答", "at": 9e12}]}]}
    async with owner(app) as c:
        r = await c.post("/api/project/threads/c1/merge", json={"data": stale})
    ids = [m["id"] for m in r.json()["data"]["threads"][0]["messages"]]
    assert "live1" in ids and "o2" in ids
    guest_view = guest_threads(store.read("threads", "c1")[0])
    assert "o2" in json.dumps(guest_view)


# ——— CLI ———
def test_cli_share_without_server(env, capsys):
    from agora_cli.main import main

    store = env[0]
    root = str(store.root)
    assert main(["share", "create", "--project", root, "--for", "10m"]) == 3
    assert main(["share", "create", "--project", root, "--for", "soon"]) == 2
    assert main(["share", "list", "--project", root]) == 0
    assert "没有分享" in capsys.readouterr().out
    assert main(["share", "revoke", "--project", root]) == 2
