"""Files a shell command writes or runs on (server/canvas/adapters/shell_files.py): an agent that
edits through the shell (``sed -i``, ``python3 - <<'EOF'``, ``cat > f <<EOF``) has to show up on the
nodes of the files it touches. The commands below are the real ones of a Claude Code sub-agent that
made 51 Bash calls and no Edit / Write call; the counter-examples must give nothing."""

import json

import pytest

from server.canvas.adapters.runs import timeline
from server.canvas.adapters.shell_files import shell_files, shell_tool

WT = "/Users/zhijie/Job/intern/wt-rail-dot"  # the work tree the agent worked in: the project root here
CD = f"cd {WT}/webapp"
SHELL_DIR = "webapp/src/components/shell"

SED_AND_SCRIPT = (
    CD + " && sed -i '' 's/absolute -top-0.5 left-9.5 hidden/absolute -top-1 left-7 hidden/' src/components/shell/sidebar-body.tsx && python3 - <<'EOF'\n"
    "p='src/components/shell/promo-carousel.test.tsx'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF\ngit diff --stat"
)
SCRIPT_WRITES = CD + " && python3 - <<'EOF'\np='src/components/shell/sidebar-body.tsx'\ns=open(p).read()\ns=s.replace('x','y')\nopen(p,'w').write(s)\nEOF\ngit diff --stat"
SCRIPT_READS_ONLY = CD + " && python3 - <<'EOF'\np='src/components/shell/sidebar-body.tsx'\nprint(len(open(p).read()))\nEOF"
HEREDOC_FILES = (
    f"mkdir -p {WT}/webapp/.rail-harness && cd {WT}/webapp/.rail-harness && cat > index.html <<'EOF'\n<!doctype html>\n<title>rail harness</title>\nEOF\n"
    "cat > vite.config.ts <<'EOF'\nimport path from \"node:path\";\nexport default {};\nEOF"
)
VITEST = CD + " && npm ci --no-audit --no-fund 2>&1 | tail -3 && npx vitest run src/components/shell/promo-carousel.test.tsx src/components/shell/app-sidebar.test.tsx 2>&1 | tail -25; echo EXIT=${pipestatus[1]}"
MAKE_VERIFY = f"cd {WT} && make verify files='webapp/src/components/shell/promo-carousel.tsx webapp/src/components/shell/sidebar-body.tsx' 2>&1 | tail -30; echo EXIT=${{pipestatus[1]}}"
SED_KILL = CD + " && S=/private/tmp/claude-501/x/scratchpad; kill $(cat $S/harness.pid); sed -i '' 's|  root: __dirname,|  root: __dirname,\\n  publicDir: 1,|' .rail-harness/vite.config.ts; HARNESS_PORT=18431 nohup npx vite --config .rail-harness/vite.config.ts > $S/harness.log 2>&1 & echo $! > $S/harness.pid"
READS = CD + "/src && sed -n 150,330p components/shell/promo-carousel.tsx; cat lib/announcement-dismissal.ts"


@pytest.mark.parametrize(
    "cmd,writes,on",
    [
        (SED_AND_SCRIPT, [f"{SHELL_DIR}/sidebar-body.tsx", f"{SHELL_DIR}/promo-carousel.test.tsx"], []),
        (SCRIPT_WRITES, [f"{SHELL_DIR}/sidebar-body.tsx"], []),
        (SCRIPT_READS_ONLY, [], [f"{SHELL_DIR}/sidebar-body.tsx"]),  # a script that only reads its file: it runs on it
        (HEREDOC_FILES, ["webapp/.rail-harness/index.html", "webapp/.rail-harness/vite.config.ts"], []),
        (SED_KILL, ["webapp/.rail-harness/vite.config.ts"], []),  # /private/tmp/… ($S/…) is not the project's
        (VITEST, [], [f"{SHELL_DIR}/promo-carousel.test.tsx", f"{SHELL_DIR}/app-sidebar.test.tsx"]),
        (MAKE_VERIFY, [], [f"{SHELL_DIR}/promo-carousel.tsx", f"{SHELL_DIR}/sidebar-body.tsx"]),
        ("cp a.py src/b.py", ["src/b.py"], []),
        ("echo x | tee -a docs/log.md", ["docs/log.md"], []),
        ("perl -pi -e 's/a/b/' server/app.py", ["server/app.py"], []),
        ("python3 scripts/check.py --fast", [], ["scripts/check.py"]),
    ],
)
def test_files_a_shell_command_writes_or_runs_on(cmd, writes, on):
    assert shell_files(cmd, WT, WT) == (writes, on)


@pytest.mark.parametrize(
    "cmd",
    [
        "git status",
        "git add web/src/a.py && git commit -q -m 'x/y.py'",
        "pnpm install",
        "npm ci --no-audit --no-fund",
        "echo hello > /tmp/x",  # outside the project
        "cat > /tmp/x.py <<'EOF'\nprint(1)\nEOF",
        "grep -rn foo .",
        "ls -la src/",
        "curl -s https://example.com/a/b.json -o /tmp/b.json",
        "python3 -c \"print('text/plain')\"",  # a MIME type is not a path
        "python3 - <<'EOF'\nprint('application/json', 'a b/c')\nEOF",
        "mkdir -p out/deep && rm -rf dist/",
        "kill $(cat $S/harness.pid); sleep 1",
        "",
    ],
)
def test_nothing_is_guessed(cmd):
    assert shell_files(cmd, WT, WT) == ([], [])


def test_reads_stay_reads_and_a_write_makes_the_call_an_edit():
    assert shell_tool(READS, WT, WT)[0] == "read"
    assert shell_tool(READS, WT, WT)[2:] == ([], [])
    act, reads, files, on = shell_tool(SED_AND_SCRIPT, WT, WT)
    assert act == "edit" and reads == [] and on == []
    assert files == [{"path": f"{SHELL_DIR}/sidebar-body.tsx", "op": "edit"}, {"path": f"{SHELL_DIR}/promo-carousel.test.tsx", "op": "edit"}]
    act, _, files, on = shell_tool(VITEST, WT, WT)
    assert (act, files) == ("commands", []) and len(on) == 2


def test_the_session_cwd_is_the_directory_without_a_cd():
    assert shell_files("sed -i '' 's/a/b/' components/x.tsx", WT, f"{WT}/webapp/src") == (["webapp/src/components/x.tsx"], [])


def _claude_log(tmp_path, command):
    rec = {
        "type": "assistant",
        "timestamp": "2026-09-28T06:00:00.000Z",
        "cwd": WT,
        "message": {"id": "m1", "model": "claude-x", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": command}}]},
    }
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps(rec) + "\n")
    return p


def test_the_lane_segment_of_a_shell_write_carries_the_file(tmp_path):
    segs = timeline("claude", _claude_log(tmp_path, SED_AND_SCRIPT), WT)["segments"]
    assert [(s["kind"], s.get("path")) for s in segs] == [("write", f"{SHELL_DIR}/sidebar-body.tsx")]


def test_the_lane_segment_of_a_test_run_stays_an_exec_on_its_file(tmp_path):
    segs = timeline("claude", _claude_log(tmp_path, VITEST), WT)["segments"]
    assert [(s["kind"], s.get("path")) for s in segs] == [("exec", f"{SHELL_DIR}/promo-carousel.test.tsx")]


def test_a_call_that_touches_nothing_of_the_project_has_no_file(tmp_path):
    segs = timeline("claude", _claude_log(tmp_path, "git status && pnpm install"), WT)["segments"]
    assert [(s["kind"], s.get("path")) for s in segs] == [("exec", None)]


# ——— unexpanded shell variables never become project files (a `cd $WT/x` leaves the directory unknown) ———
@pytest.mark.parametrize(
    "cmd",
    [
        "sed -i '' 's/a/b/' $WT/controlplane/x.go",
        "cd $WT/controlplane && sed -i '' 's/a/b/' internal/x.go && npx vitest run internal/x.test.go",
        "cd ${ROOT} && cp a.py src/a.ts",
        "sed -i '' 's/a/b/' ${ROOT}/a.ts",
        "python3 - <<'EOF'\np='$(git rev-parse --show-toplevel)/b.py'\nopen(p,'w').write('x')\nEOF",
        "cd $(git rev-parse --show-toplevel) && sed -i '' 's/a/b/' b.py",
        "cat > `pwd`/c.md <<'EOF'\nx\nEOF",
        "cd `pwd`/sub && touch d.md",
        "pytest $WT/tests/test_x.py",
    ],
)
def test_unexpanded_variables_are_dropped(cmd):
    assert shell_files(cmd, WT, WT) == ([], [])


def test_a_later_absolute_path_still_counts_after_an_unknown_cd():
    assert shell_files(f"cd $WT/x && sed -i '' 's/a/b/' {WT}/web/a.ts", WT, WT) == (["web/a.ts"], [])


def test_home_directory_paths_are_expanded_and_then_fall_outside_the_project(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert shell_files("sed -i '' 's/a/b/' ~/notes.md && cd ~ && touch todo.md", WT, WT) == ([], [])
    assert shell_files("sed -i '' 's/a/b/' ~nobody-here/notes.md", WT, WT) == ([], [])
    monkeypatch.setenv("HOME", WT)  # a home that is the project itself
    assert shell_files("sed -i '' 's/a/b/' ~/notes.md", WT, WT) == (["notes.md"], [])
