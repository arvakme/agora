"""The ``cf``-backed share providers (server/canvas/cloudflare.py) against a stub ``cf`` script:
create, revoke, not logged in, and rollback when creating fails half-way."""

from __future__ import annotations

import json
import stat
import sys
import time
from pathlib import Path

import pytest

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
if argv[:3] == ["tunnels", "run", "--token"]:
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


def test_command_failure_is_reported_without_secrets(cf):
    c, _, patch = cf
    patch(fail="tunnels token get")
    tid = CfTunnels(c).create("agora-share-x")
    with pytest.raises(CloudflareError) as e:
        CfTunnels(c).start(tid, 1234, Path("/dev/null"))
    assert "SECRET" not in str(e.value)


def test_start_sets_ingress_runs_with_token_and_stops_with_the_tree(cf, tmp_path):
    c, read, _ = cf
    tunnels = CfTunnels(c)
    tid = tunnels.create("agora-share-x")
    proc = tunnels.start(tid, 4321, tmp_path / "run" / "cf.log")
    try:
        assert proc.wait_ready(10)
        upd = next(x for x in read()["calls"] if x[:3] == ["tunnels", "config", "update"])
        assert json.loads(upd[upd.index("--body") + 1])["config"]["ingress"] == [{"service": "http://127.0.0.1:4321"}]
        assert "SECRET-TOKEN-VALUE" not in (tmp_path / "run" / "cf.log").read_text()  # the token never reaches the log
    finally:
        proc.stop()
    time.sleep(0.2)
    assert not proc.alive()


def _manager(tmp_path, c) -> ShareManager:
    store = ProjectStore(tmp_path / "proj")
    store.root.mkdir()
    store.init()
    store.write("canvas", "c1", {"elements": []}, base=None)
    m = ShareManager(store, providers=lambda: (CfDns(c), CfTunnels(c)), domain="example.test")
    m.gateway_port = 45678
    return m


def test_failed_create_rolls_back_what_was_made(cf, tmp_path):
    c, read, patch = cf
    m = _manager(tmp_path, c)
    patch(fail="tunnels token get")  # the tunnel exists by then, the connector cannot start
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
