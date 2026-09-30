// Playing a turn (web/docs/workstation.md §11 按轮追踪): the +N on each node the turn has changed so far, and the
// summary at the end (「这一轮改了 X 个节点、Y 个文件」). From the run's write segments inside the turn's window —
// the run's own and its sub-agents' — pure.
import { describe, expect, it } from "vitest";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { fileCounts, summaryOf, turnWrites } from "./playCounts.ts";
import { nodePath } from "./runs/nodePath.ts";

const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start, end, path, label: kind });
const run = (id: string, segs: RunSeg[], children: WorkRun[] = []): WorkRun => ({ id, agent: "claude", name: id, segs, receipts: [], running: false, lastAt: 0, children });
const dirOf = (p: string) => p.split("/")[0];
const place = (p: string) => (p.startsWith("docs/") ? null : dirOf(p));

const kid = run("k", [seg("write", 1500, 1600, "db/models.py"), seg("write", 9000, 9100, "db/late.py")]);
const r = run(
  "r",
  [seg("read", 1000, 1100, "api/a.py"), seg("write", 1100, 1200, "api/a.py"), seg("write", 1300, 1400, "api/b.py"), seg("exec", 1400, 1500), seg("write", 1700, 1800, "docs/x.md"), seg("write", 5000, 5100, "web/z.ts"), seg("write", 100, 200, "old/before.py")],
  [kid],
);
const win = { start: 1000, end: 2000 };

describe("turnWrites: the files written inside the window", () => {
  it("only writes (not reads, not commands), only inside the window, the sub-agents' too", () => {
    expect(turnWrites(r, win).map((w) => w.path).sort()).toEqual(["api/a.py", "api/b.py", "db/models.py", "docs/x.md"]);
  });
  it("a window with no end goes on to now: later writes count", () => {
    expect(turnWrites(r, { start: 1000, end: null }).map((w) => w.path)).toContain("web/z.ts");
  });
});

describe("fileCounts: the +N at a moment", () => {
  it("nothing before the first write of the turn", () => {
    expect(fileCounts(r, win, 1050, place).size).toBe(0);
  });
  it("a file counts once its write has started, per node", () => {
    const c = fileCounts(r, win, 1350, place);
    expect(c.get("api")).toBe(2);
    expect(c.has("db")).toBe(false);
  });
  it("adds up over the turn, sub-agents included; a file written twice counts once; off the diagram is not counted", () => {
    const c = fileCounts(r, win, 2000, place);
    expect(c.get("api")).toBe(2);
    expect(c.get("db")).toBe(1);
    expect([...c.keys()].sort()).toEqual(["api", "db"]);
  });
  it("a parent node shows its sub-diagram's total (the canvas's own place function decides)", () => {
    expect(fileCounts(r, win, 2000, () => "parent").get("parent")).toBe(4);
  });
  it("the same file twice in one turn is one file", () => {
    const twice = run("t", [seg("write", 1000, 1100, "api/a.py"), seg("write", 1200, 1300, "api/a.py")]);
    expect(fileCounts(twice, win, 2000, place).get("api")).toBe(1);
  });
});

describe("summaryOf: X nodes, Y files", () => {
  it("counts the files (the ones off the diagram too) and the nodes they land on", () => {
    expect(summaryOf(r, win, place)).toEqual({ nodes: 2, files: 4 });
  });
  it("a turn that wrote nothing", () => {
    expect(summaryOf(run("q", [seg("read", 1000, 1100, "a")]), win, place)).toEqual({ nodes: 0, files: 0 });
  });
});

describe("FX4 · P2 #7: a canvas edit is not a file — nodes come from the edit's ids, files exclude node paths", () => {
  const editSeg = (start: number, canvas: string, ids: string[]): RunSeg => ({ kind: "write", start, end: start + 900, label: "改图", path: nodePath(canvas, ids[0]), edit: { canvas, ids } });
  const er = run("e", [editSeg(1100, "c", ["n1", "n2"])]);
  it("two nodes drawn in one stop: 2 nodes, 0 files", () => {
    expect(summaryOf(er, win, (p) => p)).toEqual({ nodes: 2, files: 0 });
  });
  it("mixed with real files: the files count is the files, the nodes are both kinds", () => {
    const mixed = run("m", [editSeg(1100, "c", ["n1", "n2"]), seg("write", 1300, 1400, "api/a.py"), seg("write", 1500, 1600, "api/b.py")]);
    expect(summaryOf(mixed, win, place)).toEqual({ nodes: 3, files: 2 });
  });
  it("the +N on a node counts files only: a node path adds none", () => {
    expect(fileCounts(er, win, 5000, (p) => p).size).toBe(0);
  });
});
