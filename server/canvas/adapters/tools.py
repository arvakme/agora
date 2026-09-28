"""Shared tool vocabulary: activities, and which files a shell command reads.

Each adapter's ``ToolVocab.classify`` starts from its own table (it knows its CLI's tool names
and argument keys); what they share lives here:

- ``activity_of``: the name-based fallback (the union of the three CLIs' names the page used to
  keep in ``trajectoryModel.activityOf``).
- ``shell_reads``: the files a shell command reads (``cat``, ``sed -n``, ``head``/``tail``,
  ``nl``, ``less``/``bat``, ``rtk read``) or searches (``rg``/``grep`` with explicit paths),
  relative to the project root — Codex runs everything through a shell, so without this its
  reads were invisible to the workstation view.
- ``shell_tool``: ``shell_reads`` plus the files a shell command *writes* (``sed -i``, redirects, ``tee``,
  ``cp``/``mv`` targets, scripts that open a file for writing) and the files it *runs on* (a test or
  script path in the command) — an agent that edits through the shell walks the diagram too.
- ``spawn_in_output``: a Seedmux dispatch printed by ``smx-team spawn/assign``
  (``task=T-xx pane=<UUID>``) in a tool's output.
- ``patch_files``: the files a ``*** Begin Patch`` text writes (Cursor records Codex-family models'
  ``ApplyPatch`` with the patch as its input).
- ``names_ticket``: whether a worker was given a Seedmux ticket (its prompt names it, or it ran
  ``smx-team ack/reply`` for it) — how a worker whose sid Seedmux never learns is recognised.
"""

from __future__ import annotations

import os
import re
import shlex
from typing import Any

from server.canvas.adapters.common import rel_path


def activity_of(name: str = "") -> str:
    """Tool name → activity (the page's former ``activityOf``: Claude Code / Pi / Codex names)."""
    n = (name or "").lower()
    if n in ("read", "read_file", "view", "readfile", "notebookread"):
        return "read"
    if n in ("grep", "glob", "find", "ls", "search", "list", "list_dir", "find_file_by_name") or n.endswith("_inspect"):
        return "search"
    if n in ("write", "write_file", "create"):
        return "write"
    if n in ("edit", "multiedit", "multi_edit", "apply_patch", "applypatch", "notebookedit", "str_replace", "strreplace", "search_replace", "delete"):
        return "edit"
    if n in ("bash", "shell", "pwsh", "exec", "exec_command", "write_stdin", "bashoutput", "killshell", "execute", "run_terminal_command", "run_terminal_cmd") or n.startswith("terminal_"):
        return "commands"
    if n in ("websearch", "web_search"):
        return "webSearch"
    if n in ("webfetch", "web_fetch", "fetchurl"):
        return "webFetch"
    if n in ("task", "agent", "subagent", "spawn_agent", "spawn_subagent", "run_subagent") or n.startswith("subagent_"):
        return "subagents"
    if n in ("todowrite", "update_plan", "todo_write"):
        return "plan"
    if n in ("askuserquestion", "ask_user_question", "request_user_input", "askquestion", "askuser", "exitplanmode"):
        return "questions"
    return "tools"


# ——— shell commands ———
_OPS = {"&&", "||", ";", "|", "&", "|&"}
_HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")
READERS = {"cat", "head", "tail", "nl", "less", "more", "bat", "wc", "file", "stat"}
SEARCHERS = {"rg", "grep", "egrep", "fgrep", "ag", "ack"}
LISTERS = {"ls", "find", "fd", "tree", "eza"}
# Flags that take a value, per program (so the value is not mistaken for a path).
_VALUE_FLAGS = {
    "head": {"-n", "-c"},
    "tail": {"-n", "-c"},
    "sed": {"-e", "-f"},
    "rg": {"-g", "--glob", "-t", "--type", "-T", "-e", "-m", "--max-count", "-A", "-B", "-C", "-M", "--max-columns", "-j", "--threads"},
    "grep": {"-e", "-f", "-m", "-A", "-B", "-C", "--include", "--exclude"},
    "nl": {"-b", "-w", "-s", "-v", "-i"},
}
_WRAPPERS = {"sudo", "command", "time", "nice", "env", "noglob"}
_KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "("}  # what may precede a command in a shell line


def _program(words: list[str]) -> list[str]:
    """A simple command's words from the program it runs: wrappers (``sudo``, ``env``…), ``VAR=value``
    assignments, shell keywords (``do``, ``then``…) and ``rtk proxy`` skipped."""
    while words and (words[0] in _WRAPPERS or words[0] in _KEYWORDS or re.match(r"^[A-Z_][A-Z0-9_]*=", words[0])):
        words = words[1:]
    return words[2:] if words[:2] == ["rtk", "proxy"] else words


def _commands(command: str) -> list[tuple[list[str], str]]:
    """The simple commands of a shell line (split on ``&& || ; | &`` and newlines), each as
    ``(words, heredoc body)``; the body (``python3 - <<'EOF' … EOF``) belongs to the last command of
    the line that opens it, and is data, not commands."""
    out: list[tuple[list[str], str]] = []
    lines = command.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        body = ""
        m = _HEREDOC.search(line)
        if m:
            start = i
            while i < len(lines) and lines[i].strip() != m.group(1):
                i += 1
            body = "\n".join(lines[start:i])
            i += 1
        # fd duplications (2>&1, >&2) are not command separators; &> is a plain redirect.
        line = re.sub(r"\d*>&\d+", " ", line).replace("&>>", ">>").replace("&>", ">")
        try:
            lex = shlex.shlex(line, posix=True, punctuation_chars=";&|")
            lex.whitespace_split = True
            tokens = list(lex)
        except ValueError:
            tokens = re.split(r"\s+", line.strip())
        cur: list[str] = []
        first = len(out)
        for t in tokens:
            if t in _OPS:
                if cur:
                    out.append((cur, ""))
                cur = []
            else:
                cur.append(t)
        if cur:
            out.append((cur, ""))
        if body and len(out) > first:
            out[-1] = (out[-1][0], body)
    return out


def _simple_commands(command: str) -> list[list[str]]:
    return [words for words, _ in _commands(command)]


def _redirects(words: list[str]) -> tuple[list[str], bool, list[str]]:
    """(words without redirections, whether stdout goes to a file, files read with ``<``).
    ``> f`` / ``>> f`` / ``1> f`` are writes (never reads of ``f``); ``2> f`` is ignored; ``<< EOF``
    and ``<<< s`` are heredoc / here-strings."""
    out: list[str] = []
    writes = False
    inputs: list[str] = []
    skip = None  # what the next word is: "write" | "input" | "drop"
    for w in words:
        if skip is not None:
            if skip == "input":
                inputs.append(w)
            skip = None
            continue
        if w in (">", ">>", "1>", "1>>", ">|"):
            writes, skip = True, "drop"
        elif re.match(r"^1?>>?[^>&]", w):
            writes = True
        elif w in ("2>", "2>>"):
            skip = "drop"
        elif re.match(r"^2>>?.", w):
            pass
        elif w in ("<<", "<<-", "<<<"):
            skip = "drop"
        elif w.startswith("<<"):
            pass
        elif w == "<":
            skip = "input"
        elif w.startswith("<"):
            inputs.append(w[1:])
        else:
            out.append(w)
    return out, writes, inputs


def _looks_like_path(w: str) -> bool:
    if not w or w.startswith("-") or w in (".", "..", "/", "-"):
        return False
    if any(c in w for c in "*?{}$`<>|&;()") or "=" in w.split("/")[0]:
        return False
    base = w.rstrip("/").rsplit("/", 1)[-1]
    return "/" in w or "." in base


def _operands(prog: str, args: list[str]) -> list[str]:
    out, skip = [], False
    vals = _VALUE_FLAGS.get(prog, set())
    for a in args:
        if skip:
            skip = False
            continue
        if a == "--":
            continue
        if a.startswith("-"):
            if a in vals:
                skip = True
            continue
        out.append(a)
    return out


def _resolve(p: str, cwd: str | None, root: str | None) -> str:
    p = os.path.expanduser(p)
    if cwd and not os.path.isabs(p):
        p = os.path.normpath(os.path.join(cwd, p))
    return rel_path(p, root)


def shell_reads(command: Any, root: str | None = None, cwd: str | None = None) -> tuple[str | None, list[str]]:
    """(activity, paths) for a shell command line: ``read`` when every simple command only reads
    files, ``search`` when it only reads / searches / lists, else ``commands``; ``paths`` are the
    files it reads (explicit file operands of readers and searchers), relative to ``root``.
    ``(None, [])`` when there is no command."""
    if isinstance(command, list):
        command = command[-1] if command else ""
    if not isinstance(command, str) or not command.strip():
        return None, []
    kinds: list[str] = []
    paths: list[str] = []
    for words in _simple_commands(command.strip()):
        words, writes, inputs = _redirects(words)
        paths += [_resolve(p, cwd, root) for p in inputs if _looks_like_path(p)]
        while words and (words[0] in _WRAPPERS or re.match(r"^[A-Z_][A-Z0-9_]*=", words[0])):
            words = words[1:]
        if not words:
            if writes:
                kinds.append("commands")
            continue
        prog = os.path.basename(words[0])
        args = words[1:]
        if prog == "rtk" and args:  # the user's command rewriter: `rtk read <f>`, `rtk proxy <cmd…>`
            if args[0] == "proxy":
                words = args[1:]
                if not words:
                    continue
                prog, args = os.path.basename(words[0]), words[1:]
            elif args[0] == "read":
                prog, args = "cat", args[1:]
            else:
                prog, args = args[0], args[1:]
        if prog == "cd":  # later relative paths are relative to where it went
            if args and not args[0].startswith("-") and (cwd or root):
                cwd = os.path.normpath(os.path.join(cwd or root or "", os.path.expanduser(args[0])))
            continue
        if prog in ("pwd", "echo", "true", "printf"):
            continue
        if prog == "sed":
            ops = _operands("sed", args)
            if "-i" in args or any(a.startswith("-i") for a in args):
                kinds.append("commands")
                continue
            kinds.append("read")
            paths += [_resolve(p, cwd, root) for p in (ops[1:] if not any(a in ("-e", "-f") for a in args) else ops) if _looks_like_path(p)]
        elif prog in READERS:
            kinds.append("read")
            paths += [_resolve(p, cwd, root) for p in _operands(prog, args) if _looks_like_path(p)]
        elif prog in SEARCHERS:
            kinds.append("search")
            ops = _operands(prog, args)
            explicit = any(a in ("-e", "-f", "--regexp") for a in args)
            files = ops if explicit else ops[1:]
            paths += [_resolve(p, cwd, root) for p in files if _looks_like_path(p) and "." in p.rstrip("/").rsplit("/", 1)[-1]]
        elif prog in LISTERS:
            kinds.append("search")
        elif prog in ("git",) and args[:1] in (["show"], ["log"], ["diff"], ["status"], ["blame"]):
            kinds.append("search")
        else:
            kinds.append("commands")
        if writes and kinds and kinds[-1] != "commands":
            kinds[-1] = "commands"  # `head -5 a.py > b.py`: reads a.py, but it writes a file
    seen: list[str] = []
    for p in paths:
        if p not in seen:
            seen.append(p)
    if not kinds:
        return "commands", seen
    if all(k == "read" for k in kinds):
        return "read", seen
    if all(k in ("read", "search") for k in kinds):
        return "search", seen
    return "commands", seen


# ——— patch text (``*** Begin Patch`` … ``*** End Patch``, the Codex-family edit format) ———
_PATCH_FILE = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$", re.M)
PATCH_OP = {"Add": "add", "Update": "edit", "Delete": "delete"}


def patch_files(patch: Any, root: str | None = None) -> list[dict[str, str]]:
    """The files a patch text writes (``*** Add File:`` / ``Update File:`` / ``Delete File:``; a
    ``*** Move to:`` target counts as edited), relative to ``root``."""
    if not isinstance(patch, str):
        return []
    out: list[dict[str, str]] = []
    for m in _PATCH_FILE.finditer(patch):
        op, path = (PATCH_OP[m.group(1)], m.group(2)) if m.group(1) else ("edit", m.group(3))
        f = {"path": rel_path(path, root), "op": op}
        if f not in out:
            out.append(f)
    return out


SPAWN = re.compile(r"\btask=(T-[0-9a-zA-Z]+)\s+pane=([0-9A-Fa-f-]{36})")


def spawn_in_output(text: Any, command: Any = None) -> dict[str, str] | None:
    """A Seedmux dispatch in a tool's output: ``smx-team spawn/assign`` prints ``task=T-xx pane=<UUID>``.
    Only trusted when the call's own command ran ``smx-team`` (a ``cat`` / ``grep`` of an old log
    that happens to contain the line is not a dispatch); ``command=None`` = unknown → not trusted."""
    if not isinstance(text, str):
        return None
    if not is_dispatch(command):
        return None
    m = SPAWN.search(text)
    return {"taskId": m.group(1), "pane": m.group(2).upper(), "via": "seedmux"} if m else None


def is_dispatch(command: Any) -> bool:
    """Whether a shell command runs ``smx-team spawn`` or ``smx-team assign`` (parsed, not a substring:
    ``echo smx-team spawn`` or ``grep smx-team`` are not dispatches)."""
    if isinstance(command, list):
        command = command[-1] if command else ""
    if not isinstance(command, str) or "smx-team" not in command:
        return False
    for words in _simple_commands(command.strip()):
        words = _program(_redirects(words)[0])
        if not words or os.path.basename(words[0]) not in ("smx-team", "smx-team.py"):
            continue
        sub = next((w for w in words[1:] if not w.startswith("-")), None)
        if sub in ("spawn", "assign"):
            return True
    return False


# ——— a worker's ticket (Seedmux never learns the sid of a CLI without hooks: Devin, Cursor) ———
def prompt_names_ticket(text: Any, task_id: str) -> bool:
    """Whether a prompt names the ticket as a whole word (Seedmux's worker envelope: ``任务 T-xx``,
    ``task=T-xx``, ``tasks/T-xx/prompt.md``)."""
    return isinstance(text, str) and re.search(rf"(?<![\w-]){re.escape(task_id)}(?![\w-])", text) is not None


def replies_to_ticket(command: Any, task_id: str) -> bool:
    """Whether a shell command runs ``smx-team ack|reply <T-xx>`` — what only the ticket's worker does
    (a dispatcher runs ``spawn`` / ``verify``; printing the id is not replying to it)."""
    if isinstance(command, list):
        command = command[-1] if command else ""
    if not isinstance(command, str) or task_id not in command:
        return False
    for words in _simple_commands(command.strip()):
        words = _program(_redirects(words)[0])
        if not words or os.path.basename(words[0]) not in ("smx-team", "smx-team.py"):
            continue
        args = [w for w in words[1:] if not w.startswith("-")]
        if args[:1] in (["ack"], ["reply"]) and task_id in args[1:]:
            return True
    return False
