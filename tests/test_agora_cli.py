"""`agora up / status / down` with real server processes: reuse, per-project ports, clean stop."""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def agora(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(REPO)}
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=90)


def get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def test_up_reuse_isolation_down(tmp_path):
    a, b = tmp_path / "alpha", tmp_path / "beta"
    a.mkdir(), b.mkdir()
    try:
        r1 = agora("up", cwd=a)
        assert r1.returncode == 0, r1.stderr
        assert "started" in r1.stdout
        sa = json.loads((a / ".agora" / "run" / "server.json").read_text())
        assert (a / ".agora" / "config.toml").exists() and (a / ".agora" / ".gitignore").exists()

        r2 = agora("up", "--project", str(a), cwd=tmp_path)  # same project → same instance
        assert r2.returncode == 0 and "already running" in r2.stdout
        assert json.loads((a / ".agora" / "run" / "server.json").read_text())["pid"] == sa["pid"]

        assert agora("up", cwd=b).returncode == 0
        sb = json.loads((b / ".agora" / "run" / "server.json").read_text())
        assert sb["port"] != sa["port"] and sb["pid"] != sa["pid"]

        ha, hb = get(f"http://127.0.0.1:{sa['port']}/api/project"), get(f"http://127.0.0.1:{sb['port']}/api/project")
        assert (ha["name"], hb["name"]) == ("alpha", "beta") and ha["root"] == str(a.resolve())

        req = urllib.request.Request(
            f"http://127.0.0.1:{sa['port']}/api/project/workspace",
            data=json.dumps({"data": {"from": "alpha"}, "base": None}).encode(),
            headers={"content-type": "application/json"},
            method="PUT",
        )
        urllib.request.urlopen(req, timeout=5).read()
        assert (a / ".agora" / "workspace.json").exists() and not (b / ".agora" / "workspace.json").exists()

        assert agora("status", cwd=a).returncode == 0
    finally:
        da, db = agora("down", cwd=a), agora("down", cwd=b)
    assert da.returncode == 0 and "released" in da.stdout, da.stdout
    assert db.returncode == 0 and "released" in db.stdout, db.stdout
    assert agora("status", cwd=a).returncode == 1
    assert not (a / ".agora" / "run" / "server.json").exists()
