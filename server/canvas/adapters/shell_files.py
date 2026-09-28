"""Which files a shell command writes or runs on — so an agent that edits through the shell
(``sed -i``, ``python3 - <<'EOF'``, ``cat > f <<EOF``, ``cp``) walks the diagram like one that uses an
edit tool. Every CLI's shell-type tool goes through ``shell_tool``.

Conservative on purpose: a miss only leaves the worker where it stands; a wrong file sends it to
the wrong node. So nothing is guessed from prose — a candidate is a command operand or a quoted
string in a heredoc script that is *path-shaped* (a directory segment, or an extension from
``EXTENSIONS``), never a URL, glob, flag or ``NAME=value`` word.

- **effective directory**: a leading ``cd <dir> &&`` (or ``;``) moves where relative paths point;
  else the session's cwd. The path then goes through ``rel_path``; whatever is still absolute
  afterwards (outside the repository: scratchpad, /tmp, ~/.claude) is dropped.
- **writes**: redirect targets (``>``, ``>>``, ``tee``), ``sed -i`` / ``perl -pi`` files, the target
  of ``cp`` / ``mv``, ``touch``, and — in a ``python`` / ``node`` script (heredoc or ``-c``) — its
  path-shaped string literals when the script writes (``open(…, 'w')``, ``write_text``, ``writeFile``…).
- **on**: the other path-shaped operands of a command (``pytest tests/x.py``, ``npx vitest run
  src/a.test.ts``, ``make verify files='a.tsx b.tsx'``, ``python3 scripts/x.py``) and the literals
  of a script that only reads. Not touched: ``git``, package-manager install / add / remove…,
  network and process tools, ``echo`` / ``printf``.
"""

from __future__ import annotations

import os
import re
from typing import Any

from server.canvas.adapters.common import rel_path
from server.canvas.adapters.tools import _WRAPPERS, _commands, shell_reads

EXTENSIONS = {
    "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "md", "mdx", "yaml", "yml", "toml", "css", "scss", "html", "sh", "sql",
    "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift", "txt", "cfg", "ini", "env", "vue", "svelte", "proto", "csv",
}
# Programs whose operands are never files of the project (or which are not "operating on files").
_SKIP = {
    "git", "gh", "curl", "wget", "ssh", "scp", "rsync", "docker", "kubectl", "helm", "brew", "apt", "apt-get", "sudo", "kill", "pkill", "sleep",
    "echo", "printf", "true", "false", "pwd", "export", "unset", "set", "open", "which", "man", "date", "lsof", "ps", "mkdir", "rmdir", "rm",
    "chmod", "chown", "ln", "cd", "test", "[", "wait", "nohup", "smx-team", "ego-browser", "mise", "rtk",
}
_PKG = {"npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "poetry", "gem", "composer", "npx", "corepack"}
_PKG_SKIP = {"install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "ci", "link", "unlink", "init", "create", "publish", "login", "config", "cache", "store", "outdated", "audit", "sync", "lock", "self", "global"}
_SCRIPTERS = {"python", "python3", "node", "bun", "deno", "ruby", "tsx", "ts-node"}
_SHELLS = {"bash", "sh", "zsh"}
# What makes a script a writer.
_WRITES = re.compile(
    r"open\([^)]*,\s*['\"][wax+][bt+]?['\"]|\bmode\s*=\s*['\"][wax]|\.write_text\(|\.write_bytes\(|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(|fs\.(?:write|append)|shutil\.(?:copy\w*|move)\(|os\.(?:rename|replace)\("
)
_LITERAL = re.compile(r"""(['"])([^'"\n\\]{1,200})\1""")
_IN_PLACE = re.compile(r"^-[A-Za-z]*i")  # -i, -pi, -i.bak, -pie …


def _shaped(w: str, *, strict: bool = False) -> bool:
    """Whether a word is shaped like a file path of the project: not a flag, URL, glob, variable or
    NAME=value; has a directory segment, or an extension in ``EXTENSIONS`` (``strict``: the extension is
    required — for string literals in scripts, where "text/plain" must not pass)."""
    if not w or len(w) > 240 or w[0] in "-@$%#!<>|&;(){}*?[" or w in (".", "..", "/"):
        return False
    if "://" in w or any(c in w for c in "*?{}$`<>|&;()\\ \t\n=,"):
        return False
    if re.match(r"^[A-Za-z]:", w) and not re.match(r"^[A-Za-z]:[\\/]", w):  # host:port, key:value
        return False
    base = w.rstrip("/").rsplit("/", 1)[-1]
    ext = base.rsplit(".", 1)[-1].lower() if "." in base.strip(".") else ""
    if ext in EXTENSIONS:
        return True
    return not strict and "/" in w.strip("/") and not w.startswith("./..")


def _targets(words: list[str]) -> tuple[list[str], list[str]]:
    """(words without redirections, files written by ``>`` / ``>>`` / ``>|`` / ``1>``). Input redirects,
    heredoc markers and ``2>`` are dropped with their operand."""
    out: list[str] = []
    written: list[str] = []
    mode = None  # what the next word is: "write" | "drop"
    for w in words:
        if mode:
            if mode == "write":
                written.append(w)
            mode = None
        elif w in (">", ">>", "1>", "1>>", ">|"):
            mode = "write"
        elif re.match(r"^1?>>?[^>&]", w):
            written.append(re.sub(r"^1?>>?", "", w))
        elif w in ("2>", "2>>", "<", "<<", "<<<", "<<-"):
            mode = "drop"
        elif re.match(r"^(2>>?|<<?<?-?)\S", w):
            continue
        else:
            out.append(w)
    return out, written


def _literals(script: str) -> list[str]:
    out: list[str] = []
    for m in _LITERAL.finditer(script):
        s = m.group(2)
        if _shaped(s, strict=True) and s not in out:
            out.append(s)
    return out


def _strip(words: list[str]) -> list[str]:
    while words and (words[0] in _WRAPPERS or re.match(r"^[A-Z_][A-Z0-9_]*=", words[0])):
        words = words[1:]
    return words


def _operands(args: list[str]) -> list[str]:
    """Path-shaped operands; ``NAME=a b c`` (``make verify files='a b'``) contributes its words."""
    out: list[str] = []
    for a in args:
        m = re.match(r"^[A-Za-z_][A-Za-z0-9_]*=(.+)$", a)
        for w in (m.group(1).split() if m else [a]):
            if _shaped(w):
                out.append(w)
    return out


def _scan(command: str, cwd: str | None, root: str | None, writes: list[str], on: list[str], depth: int = 0) -> None:
    for words, body in _commands(command):
        words, redirected = _targets(words)
        words = _strip(words)
        here = lambda p: _abs(p, cwd, root)  # noqa: E731
        writes += [here(p) for p in redirected if _shaped(p)]
        if not words:
            continue
        prog = os.path.basename(words[0])
        args = words[1:]
        if prog == "cd":
            if args and not args[0].startswith("-"):
                cwd = _abs(args[0], cwd, root) or _LOST  # `cd $WT/x`, `cd -`: where it went is unknown
            continue
        if prog == "rtk" and args[:1] == ["proxy"]:
            words = args[1:]
            if not words:
                continue
            prog, args = os.path.basename(words[0]), words[1:]
        if prog in _SHELLS and body:
            _scan(body, cwd, root, writes, on, depth + 1) if depth < 2 else None
            continue
        if prog in _SKIP:
            continue
        if prog in _PKG:
            sub = next((a for a in args if not a.startswith("-")), None)
            if sub in _PKG_SKIP or "-g" in args or "--global" in args:
                continue
        if prog == "sed":
            if any(a == "-i" or (a.startswith("-i") and not a.startswith("-in")) or re.match(r"^--in-place", a) for a in args):
                ops = [a for a in args if not a.startswith("-") and a != ""]
                script_given = any(a in ("-e", "-f") for a in args)
                files = ops if script_given else ops[1:]
                writes += [here(p) for p in files if _shaped(p)]
            continue
        if prog == "perl":
            if any(_IN_PLACE.match(a) for a in args if a.startswith("-") and not a.startswith("--")):
                skip = False
                for a in args:
                    if skip:
                        skip = False
                    elif a in ("-e", "-E"):
                        skip = True
                    elif not a.startswith("-") and _shaped(a):
                        writes.append(here(a))
            continue
        if prog == "tee":
            writes += [here(a) for a in args if not a.startswith("-") and _shaped(a)]
            continue
        if prog == "touch":
            writes += [here(a) for a in args if not a.startswith("-") and _shaped(a)]
            continue
        if prog in ("cp", "mv", "install"):
            ops = [a for a in args if not a.startswith("-")]
            if len(ops) >= 2 and _shaped(ops[-1]):
                writes.append(here(ops[-1]))
            continue
        if prog in _SCRIPTERS or prog.startswith("python"):
            script = body
            for i, a in enumerate(args):
                if a in ("-c", "-e") and i + 1 < len(args):
                    script = args[i + 1]
            if script:
                lits = [here(p) for p in _literals(script)]
                (writes if _WRITES.search(script) else on).extend(lits)
                continue
        on += [here(p) for p in _operands(args)]


_LOST = "\0"  # the effective directory after a `cd` to somewhere the command line does not tell


def _dynamic(p: str) -> bool:
    """A word the shell expands at run time (`$VAR`, `${VAR}`, `$(…)`, backticks, `cd -`): its value is not in the command."""
    return "$" in p or "`" in p or p == "-"


def _abs(p: str, cwd: str | None, root: str | None) -> str:
    """``p`` against the effective directory, ``~`` and ``~user`` expanded; "" when it cannot be known
    (an unexpanded variable in it, an unknown user, or a relative path after a `cd` to an unknown place)."""
    if _dynamic(p):
        return ""
    p = os.path.expanduser(p)
    if p.startswith("~"):
        return ""
    if os.path.isabs(p):
        return os.path.normpath(p)
    if cwd == _LOST:
        return ""
    return os.path.normpath(os.path.join(cwd or root or "", p))


def _project_relative(paths: list[str], root: str | None) -> list[str]:
    out: list[str] = []
    for p in paths:
        r = rel_path(p, root)
        if os.path.isabs(r) or r.startswith("~") or r.startswith("../") or r in ("", "."):
            continue
        if r not in out:
            out.append(r)
    return out


def shell_files(command: Any, root: str | None = None, cwd: str | None = None) -> tuple[list[str], list[str]]:
    """(files the command writes, other files it runs on), project-relative, in order, no duplicates."""
    if isinstance(command, list):
        command = command[-1] if command else ""
    if not isinstance(command, str) or not command.strip():
        return [], []
    writes: list[str] = []
    on: list[str] = []
    try:
        _scan(command.strip(), cwd or root, root, writes, on)
    except Exception:  # a parser must never take a projection down
        return [], []
    w = _project_relative(writes, root)
    return w, [p for p in _project_relative(on, root) if p not in w]


def shell_tool(command: Any, root: str | None = None, cwd: str | None = None) -> tuple[str | None, list[str], list[dict[str, str]], list[str]]:
    """``(activity, reads, files, on)`` for a shell command: ``shell_reads`` and, for a command that does
    more than read, the files it writes (activity ``edit``, ``files`` = ``[{path, op}]``) or runs on
    (activity stays ``commands``; ``on`` = paths)."""
    act, reads = shell_reads(command, root, cwd)
    if act not in ("commands", None):
        return act, reads, [], []
    writes, on = shell_files(command, root, cwd)
    if writes:
        return "edit", reads, [{"path": p, "op": "edit"} for p in writes], []
    return act, reads, [], on
