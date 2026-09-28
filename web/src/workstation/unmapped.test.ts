// Files off the diagram (web/docs/workstation.md「新想法」): the files agents wrote that land on the 图外
// tray, grouped by their nearest common folder; a folder with more than two becomes a suggestion to
// draw it in. It only suggests — nothing changes the diagram.
import { describe, expect, it } from "vitest";
import type { Locate } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { drawInHints } from "./unmapped.ts";

const w = (path: string, kind: RunSeg["kind"] = "write"): RunSeg => ({ kind, start: 0, end: 1, label: kind, path });
const run = (id: string, segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
// on the diagram: server/app.py and everything under server/api/
const locate: Locate = (p) => (p === "server/app.py" || p.startsWith("server/api/") ? { place: "api" } : null);

describe("drawInHints", () => {
  it("a folder with three files written off the diagram becomes a suggestion; two are not enough, reads and top-level files never count", () => {
    const pi = run("pi", [w("server/cache/redis.py"), w("server/cache/memory.py"), w("server/app.py"), w("server/cache/ttl.py"), w("docs/a.md", "read"), w("docs/b.md", "read"), w("docs/c.md", "read"), w("README.md"), w("NOTES.md"), w("TODO.md")]);
    expect(drawInHints([pi], locate)).toEqual([
      { dir: "server/cache/", files: ["server/cache/memory.py", "server/cache/redis.py", "server/cache/ttl.py"], text: "server/cache/ 有 3 个新文件，要画进图里吗？" },
    ]);
    expect(drawInHints([run("pi", pi.segs.filter((g) => g.path !== "server/cache/ttl.py"))], locate)).toEqual([]);
  });

  it("groups by the nearest common folder and counts each file once, sub-agents' writes included", () => {
    const codex = run("codex", [w("lib/jobs/a/x.py"), w("lib/jobs/b/z.py"), w("lib/cache/1.py"), w("lib/cache/1.py")], { parentId: "pi" });
    const pi = run("pi", [w("lib/jobs/a/y.py"), w("lib/cache/2.py"), w("lib/cache/3.py")], { children: [codex] });
    // lib/jobs/a/ has only two; lib/ has six, all taken by the deeper folders
    expect(drawInHints([pi, codex], locate).map((h) => h.text)).toEqual(["lib/cache/ 有 3 个新文件，要画进图里吗？", "lib/jobs/ 有 3 个新文件，要画进图里吗？"]);
  });
});
