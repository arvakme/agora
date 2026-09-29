"""The ``cf``-backed share providers (server/canvas/cloudflare.py) against a stub ``cf`` script:
create, revoke, not logged in, and rollback when creating fails half-way."""

from __future__ import annotations

import json
import stat
import sys
import time
from pathlib import Path

import pytest

from server.canvas import share as share_mod
from server.canvas.cloudflare import LOGIN_HINT, CfCli, CfDns, CfTunnels, CloudflareError
from server.canvas.project import ProjectStore
from server.canvas.share import ShareError, ShareManager

STUB = r'''#!{python}
import json, os, sys
state = json.load(open("{state}"))
argv = sys.argv[1:]
zone = None
if "-z" in argv:
    i = argv.index("-z"); zone = argv[i + 1]; del argv[i:i + 2]
state["calls"].append(argv)
fail = state.get("fail")
def out(v): print(json.dumps(v)); save(); sys.exit(0)
def save(): json.dump(state, open("{state}", "w"))
def die(msg, code=1): save(); print(msg, file=sys.stderr); sys.exit(code)
if fail and " ".join(argv).startswith(fail): die("boom: " + fail)
a = " ".join(argv[:3])
if argv[:2] == ["auth", "whoami"]:
    out({{"authenticated": state["login"]}})
if not state["login"]:
    die("Error: run `cf auth login` first")
if a == "tunnels list --name":
    out([{{"id": t, "name": n, "deleted_at": None}} for t, n in state["tunnels"].items() if n == argv[3]])
if a == "tunnels create --name":
    tid = f"tun-{{len(state['tunnels']) + 1}}"; state["tunnels"][tid] = argv[3]; out({{"id": tid, "name": argv[3]}})
if a.startswith("tunnels config update"):
    out({{"ok": True}})
if a.startswith("tunnels token get"):
    print(json.dumps("SECRET-TOKEN-VALUE")); save(); sys.exit(0)
if a.startswith("tunnels connections cleanup"):
    if "--force" not in argv: die("Aborted (non-interactive; pass --force)")
    out(None)
if a.startswith("tunnels delete"):
    if "--force" not in argv: die("Aborted (non-interactive; pass --force)")
    state["tunnels"].pop(argv[2], None); out(None)
if a.startswith("dns records create"):
    body = json.loads(argv[argv.index("--body") + 1])
    rid = f"rec-{{len(state['records']) + 1}}"; state["records"][rid] = dict(body, zone=zone); out({{"id": rid, **body}})
if a.startswith("dns records delete"):
    state["records"].pop(argv[3], None); out(None)
if a.startswith("dns records get"):
    if argv[3] in state["records"]: out({{"id": argv[3]}})
    die("Record not found (81044)")
if argv[:2] == ["tunnels", "run"]:
    save()
    print("INF Registered tunnel connection", flush=True)
    import time; time.sleep(60); sys.exit(0)
die("stub: unknown " + a)
'''


@pytest.fixture
def cf(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"login": True, "tunnels": {}, "records": {}, "calls": []}))
    script = tmp_path / "cf"
    script.write_text(STUB.format(python=sys.executable, state=state))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    def read() -> dict:
        return json.loads(state.read_text())

    def patch(**kw) -> None:
        d = read()
        d.update(kw)
        state.write_text(json.dumps(d))

    return CfCli(domain="example.test", command=[str(script)]), read, patch


def test_create_makes_tunnel_and_proxied_cname_in_the_zone(cf):
    c, read, _ = cf
    dns, tunnels = CfDns(c), CfTunnels(c)
    tid = tunnels.create("agora-share-x")
    rid = dns.create_cname("a.example.test", f"{tid}.cfargotunnel.com", "agora share")
    st = read()
    assert st["tunnels"] == {tid: "agora-share-x"}
    assert st["records"][rid]["type"] == "CNAME" and st["records"][rid]["proxied"] is True and st["records"][rid]["zone"] == "example.test"
    assert tunnels.find("agora-share-x") == tid and tunnels.find("other") is None
    assert dns.exists(rid) and not dns.exists("nope")


def test_revoke_removes_record_and_tunnel_and_tolerates_missing(cf):
    c, read, _ = cf
    dns, tunnels = CfDns(c), CfTunnels(c)
    tid = tunnels.create("agora-share-x")
    rid = dns.create_cname("a.example.test", f"{tid}.cfargotunnel.com", "c")
    dns.delete(rid)
    tunnels.delete(tid)
    assert read()["records"] == {} and read()["tunnels"] == {}
    assert ["tunnels", "connections", "cleanup", tid, "--force"] in read()["calls"]  # connections dropped before delete
    dns.delete(rid)  # already gone: fine


def test_not_logged_in_says_how_to_log_in(cf):
    c, _, patch = cf
    patch(login=False)
    with pytest.raises(CloudflareError, match="npx cf auth login"):
        c.check_login()
    with pytest.raises(CloudflareError) as e:
        c.find("x")
    assert str(e.value) == LOGIN_HINT


def test_command_failure_is_reported_verbatim_and_names_the_step(cf):
    c, _, patch = cf
    patch(fail="tunnels config update")
    tid = CfTunnels(c).create("agora-share-x")
    with pytest.raises(CloudflareError, match="tunnels config update"):
        CfTunnels(c).start(tid, 1234, Path("/dev/null"))


def test_start_sets_ingress_and_runs_by_id_so_no_token_is_in_any_argument(cf, tmp_path):
    c, read, _ = cf
    tunnels = CfTunnels(c)
    tid = tunnels.create("agora-share-x")
    proc = tunnels.start(tid, 4321, tmp_path / "run" / "cf.log")
    try:
        assert proc.wait_ready(10)
        calls = read()["calls"]
        upd = next(x for x in calls if x[:3] == ["tunnels", "config", "update"])
        assert json.loads(upd[upd.index("--body") + 1])["config"]["ingress"] == [{"service": "http://127.0.0.1:4321"}]
        assert ["tunnels", "run", tid] in calls  # cf fetches the token itself; `ps` shows only the tunnel id
        assert not any("--token" in x or x[:3] == ["tunnels", "token", "get"] for x in calls)
    finally:
        proc.stop()
    time.sleep(0.2)
    assert not proc.alive()


def test_cf_is_pinned_to_the_tested_version_unless_overridden(monkeypatch):
    monkeypatch.setattr(share_mod.shutil, "which", lambda name: None)
    monkeypatch.delenv("AGORA_CF_VERSION", raising=False)
    assert share_mod.cf_command() == ["npx", "--yes", "cf@1.0.0-beta.5"]
    monkeypatch.setenv("AGORA_CF_VERSION", "1.2.3")
    assert share_mod.cf_command() == ["npx", "--yes", "cf@1.2.3"]
    monkeypatch.setattr(share_mod.shutil, "which", lambda name: "/opt/bin/cf")  # an installed cf is used as it is
    assert share_mod.cf_command() == ["/opt/bin/cf"]


def _manager(tmp_path, c, clock=None) -> ShareManager:
    store = ProjectStore(tmp_path / "proj")
    store.root.mkdir()
    store.init()
    store.write("canvas", "c1", {"elements": []}, base=None)
    kw = {"clock": clock} if clock else {}
    m = ShareManager(store, providers=lambda: (CfDns(c), CfTunnels(c)), domain="example.test", **kw)
    m.gateway_port = 45678
    return m


def test_failed_create_rolls_back_what_was_made(cf, tmp_path):
    c, read, patch = cf
    m = _manager(tmp_path, c)
    patch(fail="tunnels config update")  # the tunnel exists by then, the connector cannot start
    with pytest.raises(CloudflareError):
        m.create("c1", 600)
    assert read()["tunnels"] == {} and read()["records"] == {}
    patch(fail="dns records create")  # tunnel and connector are up, the record cannot be made
    with pytest.raises(ShareError):
        m.create("c1", 600)
    assert read()["tunnels"] == {} and read()["records"] == {}
    assert m.list() == []


def test_share_lifecycle_through_cf(cf, tmp_path):
    c, read, _ = cf
    m = _manager(tmp_path, c)
    try:
        share, url = m.create("c1", 600)
        assert share["host"].endswith(".example.test") and len(read()["records"]) == 1 and len(read()["tunnels"]) == 1
        m.revoke(share["id"])
        assert read()["records"] == {} and read()["tunnels"] == {} and m.proc is None
    finally:
        m.shutdown()


def test_cf_runs_in_agoras_state_dir_not_the_project(monkeypatch, tmp_path):
    # cf caches the account in ./.cloudflare/: run it where that cannot land in the user's project.
    import server.canvas.cloudflare as cloudflare

    monkeypatch.setenv("AGORA_STATE_DIR", str(tmp_path / "state"))
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)
    seen: dict = {}

    def fake_run(argv, **kw):
        seen.update(kw)
        return cloudflare.subprocess.CompletedProcess(argv, 0, stdout='{"authenticated": true}', stderr="")

    monkeypatch.setattr(cloudflare.subprocess, "run", fake_run)
    CfCli(domain="example.com", command=["cf"]).check_login()
    assert seen["cwd"] == str(tmp_path / "state" / "cf")
    assert not (project / ".cloudflare").exists()


class Clock:
    def __init__(self) -> None:
        self.t = 1_800_000_000.0

    def __call__(self) -> float:
        return self.t


def _runs(read) -> int:
    return sum(1 for x in read()["calls"] if x[:2] == ["tunnels", "run"])


def test_down_keeps_live_shares_up_restores_the_same_address_and_cleans_the_expired(cf, tmp_path):
    c, read, _ = cf
    clock = Clock()
    m = _manager(tmp_path, c, clock)
    long, long_url = m.create("c1", 3600)
    short, _ = m.create("c1", 120)
    m.shutdown()  # agora down
    st = read()
    assert m.proc is None and len(st["records"]) == 2 and len(st["tunnels"]) == 1  # live shares keep their DNS and tunnel
    clock.t += 300  # the short one runs out while the server is down
    up = ShareManager(m.store, providers=lambda: (CfDns(c), CfTunnels(c)), domain="example.test", clock=clock)
    up.gateway_port = 45679
    try:
        up.resume()  # agora up
        st = read()
        assert {s["id"]: s["status"] for s in up.list()} == {long["id"]: "active", short["id"]: "expired"}
        assert [r["name"] for r in st["records"].values()] == [long["host"]]  # the expired one is cleaned, the other kept
        assert _runs(read) == 2 and up.proc is not None and long_url.split("/s/")[0].endswith(long["host"])  # same address, connector back
        assert up.verify(long["host"], long_url.rsplit("/", 1)[1]) is not None
    finally:
        up.shutdown()


def test_revoke_all_after_down_clears_the_account_without_a_server(cf, tmp_path):
    c, read, _ = cf
    m = _manager(tmp_path, c)
    a, _ = m.create("c1", 3600)
    b, _ = m.create("c1", 3600)
    m.shutdown()
    offline = ShareManager(m.store, providers=lambda: (CfDns(c), CfTunnels(c)), domain="example.test")  # `agora share revoke --all` with the server down
    for s in offline.list():
        offline.revoke(s["id"])
    offline.sweep()
    assert read()["records"] == {} and read()["tunnels"] == {}
    assert {s["status"] for s in offline.list()} == {"revoked"}
