"""Draw Agora's own architecture through the agora CLI (the path an agent's skill uses): the build command of scripts/self-demo.ts.

    python3 scripts/self-demo/build.py top | top2 | children | lint
        env: AGORA_SESSION (the bound session), TOP (the overview canvas id),
             AG (the agora command, default `agora`), WORK (where build-log.jsonl and ids.json go, default the current directory)

Steps read ops/<file>.json; a node written as "<first line of a label>" in from/to/node is resolved
against the canvas as `agora canvas read` shows it.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
AG = os.environ.get("AG", "agora")
WORK = Path(os.environ.get("WORK", "."))
LOG = WORK / "build-log.jsonl"


def ag(*args: str, stdin: str | None = None, ok=(0,)) -> dict:
    p = subprocess.run(
        [AG, *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        out = {"raw": p.stdout, "err": p.stderr}
    with LOG.open("a") as f:
        f.write(
            json.dumps(
                {"args": args, "code": p.returncode, "out": out}, ensure_ascii=False
            )[:20000]
            + "\n"
        )
    if p.returncode not in ok:
        sys.exit(
            f"agora {' '.join(args)} -> {p.returncode}: {json.dumps(out, ensure_ascii=False)[:3000]}"
        )
    return out


def read(canvas: str) -> dict:
    # a child canvas just created is known to the server once the page has saved the workspace (a moment later)
    for _ in range(20):
        r = ag("canvas", "read", "--canvas", canvas, ok=(0, 1))
        if "scene" in r:
            return r
        time.sleep(0.5)
    sys.exit(f"read {canvas}: {r}")


def first_line(s: str) -> str:
    return (s or "").split("\n")[0].strip()


def resolve(scene: dict, name: str) -> str:
    for n in scene["nodes"]:
        if (
            n["id"] == name
            or first_line(n.get("label", "")) == name
            or first_line(n.get("label", "")).startswith(name)
        ):
            return n["id"]
    sys.exit(
        f"no node {name!r} in {[first_line(n.get('label', '')) for n in scene['nodes']]}"
    )


def fix(ops: list, scene: dict) -> list:
    out = []
    for o in ops:
        o = dict(o)
        for k in ("from", "to", "id"):
            v = o.get(k)
            if isinstance(v, str) and v.startswith("<") and v.endswith(">"):
                o[k] = resolve(scene, v[1:-1])
        out.append(o)
    return out


def apply(canvas: str, file: str) -> dict:
    spec = json.loads((HERE / "ops" / file).read_text())
    r = read(canvas)
    ops = fix(spec["ops"], r["scene"])
    res = ag(
        "canvas",
        "apply",
        "--canvas",
        canvas,
        "--base",
        r["base"],
        "--note",
        spec["note"],
        "--json",
        json.dumps(ops, ensure_ascii=False),
    )
    lint = (res.get("lint") or {}).get("summary")
    print(f"[{canvas}] {file}: {res.get('status')} · {lint}", flush=True)
    return res


def link(canvas: str, file: str) -> None:
    spec = json.loads((HERE / "ops" / file).read_text())
    scene = read(canvas)["scene"]
    links = {resolve(scene, k): v for k, v in spec.items()}
    res = ag(
        "canvas",
        "link",
        "--canvas",
        canvas,
        "--json",
        json.dumps(links, ensure_ascii=False),
    )
    print(f"[{canvas}] link {file}: {res.get('status')}", flush=True)


def child(parent: str, node: str, title: str) -> str:
    scene = read(parent)["scene"]
    res = ag(
        "canvas",
        "child",
        "create",
        "--parent",
        parent,
        "--node",
        resolve(scene, node),
        "--title",
        title,
    )
    cid = res["canvas"]["id"]
    print(f"[{parent}] child {title}: {res.get('status')} -> {cid}", flush=True)
    return cid


def lint(canvas: str) -> None:
    res = ag("canvas", "lint", "--canvas", canvas)
    print(f"[{canvas}] lint: {res.get('summary')}", flush=True)
    for k in (
        "crossings",
        "throughNodes",
        "overlaps",
        "stackedAnchors",
        "textOverflow",
        "labelClashes",
    ):
        if res.get(k):
            print(f"   {k}: {json.dumps(res[k], ensure_ascii=False)[:600]}", flush=True)


def ids() -> dict:
    p = WORK / "ids.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_ids(d: dict) -> None:
    (WORK / "ids.json").write_text(json.dumps(d, indent=1))


def main() -> None:
    step = sys.argv[1]
    top = os.environ.get("TOP") or ids().get("top")
    d = ids()
    if step == "top":
        apply(top, "top1.json")
    elif step == "top2":
        apply(top, "top2.json")
        lint(top)
    elif step == "children":
        link(top, "top.links.json")
        srv = child(top, "本项目 Agora 服务", "服务端")
        d["server"] = srv
        for f in ("server1.json", "server2.json"):
            apply(srv, f)
        lint(srv)
        link(srv, "server.links.json")
        disp = child(srv, "派发", "派发：一次请求的生命周期")
        d["dispatch"] = disp
        apply(disp, "dispatch1.json")
        lint(disp)
        link(disp, "dispatch.links.json")
        ad = child(srv, "CLI 适配器", "会话适配")
        d["adapters"] = ad
        apply(ad, "adapters1.json")
        apply(ad, "adapters2.json")
        lint(ad)
        link(ad, "adapters.links.json")
        web = child(top, "浏览器画布", "前端画布")
        d["web"] = web
        for f in ("web1.json", "web2.json"):
            apply(web, f)
        lint(web)
        link(web, "web.links.json")
        save_ids(d)
    elif step == "lint":
        for v in d.values():
            lint(v)
    else:
        sys.exit(f"unknown step {step}")


if __name__ == "__main__":
    main()
