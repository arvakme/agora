// PR 回放 (web/docs/workstation.md「PR 回放」): a merged PR's git commits as one synthetic run — a
// thinking beat per commit (its title), then one write per node its files land on, nearest node first,
// then a summary beat. Pure: `replayRun(spec, ctx)`; `fileCounts` is what the node badges show at t.
import { describe, expect, it } from "vitest";
import { OUTSIDE } from "./place.ts";
import { fileCounts, replayRun, type ReplayCtx, type ReplaySpec } from "./replay.ts";

/** A fake diagram: a directory is a node; nodes lie along x (api 100, db 200, web 300, cache 400). */
const X: Record<string, number> = { "api/": 100, "db/": 200, "web/": 300, "cache/": 400 };
const dirOf = (p: string) => Object.keys(X).find((d) => p.startsWith(d));
const ctx: ReplayCtx = { place: (p) => dirOf(p) ?? OUTSIDE, dock: (p) => (dirOf(p) ? { x: X[dirOf(p)!], y: 0 } : null) };

const f = (path: string, op: "add" | "edit" | "delete" | "rename" = "edit") => ({ path, op, additions: 3, deletions: 1 });
const spec = (commits: { title: string; files: string[] }[], extra: Partial<ReplaySpec> = {}): ReplaySpec => ({
  id: "pr-7",
  kind: "pr",
  number: 7,
  title: "补缓存",
  author: "Arvak",
  url: "",
  mergedAt: "2026-09-20T08:00:00Z",
  source: "github",
  commits: commits.map((c, i) => ({ sha: `s${i}`, title: c.title, at: `2026-09-20T0${i}:00:00Z`, files: c.files.map((p) => f(p)) })),
  ...extra,
});
const raw = { fit: false } as const;
const writes = (r: ReturnType<typeof replayRun>) => r.segs.filter((s) => s.kind === "write");

describe("one PR, one figure", () => {
  it("is named PR #number, drawn as the agent that made it (a neutral figure when unknown)", () => {
    const r = replayRun(spec([{ title: "a", files: ["api/x.go"] }]), ctx, 1000);
    expect(r.name).toBe("PR #7");
    expect(r.task).toBe("补缓存");
    expect(r.agent).toBe("worker");
    for (const kind of ["claude", "codex", "pi", "grok", "cursor", "devin"])
      expect(replayRun(spec([{ title: "a", files: ["api/x.go"] }], { agent: { kind } }), ctx, 0).agent).toBe(kind);
    expect(replayRun(spec([{ title: "a", files: [] }], { agent: { kind: "unknown" } }), ctx, 0).agent).toBe("worker");
    expect(r.parentId).toBeUndefined();
    expect(r.children).toEqual([]);
    expect(r.running).toBe(false);
  });
  it("starts at the time given and its segments run without gaps or overlaps", () => {
    const r = replayRun(spec([{ title: "a", files: ["api/x.go", "db/y.go"] }, { title: "b", files: ["web/z.ts"] }]), ctx, 5000);
    expect(r.segs[0].start).toBe(5000);
    for (let i = 1; i < r.segs.length; i++) expect(r.segs[i].start).toBe(r.segs[i - 1].end);
    expect(r.lastAt).toBe(r.segs[r.segs.length - 1].end);
  });
});

describe("a commit: think first, then write by node", () => {
  const r = replayRun(spec([{ title: "加缓存层", files: ["api/a.go", "api/b.go", "db/c.sql"] }]), ctx, 0, raw);
  it("thinks about 0.8 s with the commit title as its words", () => {
    expect(r.segs[0].kind).toBe("think");
    expect(r.segs[0].end - r.segs[0].start).toBe(800);
    expect(r.segs[0].note).toBe("加缓存层");
  });
  it("makes one write per node: the files of one node are one segment", () => {
    const w = writes(r);
    expect(w).toHaveLength(2);
    expect(w.find((s) => s.path!.startsWith("api/"))!.files!.map((x) => x.path)).toEqual(["api/a.go", "api/b.go"]);
    expect(w.find((s) => s.path!.startsWith("db/"))!.files).toHaveLength(1);
  });
  it("carries the turn (the commit's number) on every segment of it", () => {
    expect(new Set(r.segs.slice(0, 3).map((s) => s.turn))).toEqual(new Set([1]));
  });
});

describe("write durations: clamp(0.9 + 0.25 × files, 1.2, 3.0) s", () => {
  const dur = (n: number) => {
    const r = replayRun(spec([{ title: "t", files: Array.from({ length: n }, (_, i) => `api/f${i}.go`) }]), ctx, 0, raw);
    const w = writes(r)[0];
    return w.end - w.start;
  };
  it("one file: the floor", () => expect(dur(1)).toBe(1200));
  it("four files: 1.9 s", () => expect(dur(4)).toBe(1900));
  it("twelve files: the ceiling", () => expect(dur(12)).toBe(3000));
});

describe("the order goes to the nearest node, so it does not run back and forth", () => {
  it("visits a line of nodes in one sweep whatever order the files come in", () => {
    const r = replayRun(spec([{ title: "t", files: ["cache/1", "api/1", "web/1", "db/1"] }]), ctx, 0, raw);
    const xs = writes(r).map((s) => X[dirOf(s.path!)!]);
    const up = xs.every((x, i) => i === 0 || x > xs[i - 1]);
    const down = xs.every((x, i) => i === 0 || x < xs[i - 1]);
    expect(up || down).toBe(true);
  });
  it("the next commit starts from where the last one ended", () => {
    const r = replayRun(spec([{ title: "a", files: ["api/1", "db/1"] }, { title: "b", files: ["api/2", "db/2"] }]), ctx, 0, raw);
    const order = writes(r).map((s) => dirOf(s.path!));
    expect(order).toEqual(["api/", "db/", "db/", "api/"]);
  });
  it("is the same every time", () => {
    const s = spec([{ title: "t", files: ["web/1", "api/1", "db/1", "x/none"] }]);
    expect(replayRun(s, ctx, 0)).toEqual(replayRun(s, ctx, 0));
  });
});

describe("files off the diagram, deletions, squash, empty", () => {
  it("files outside every node are written where the tray is, after the nodes", () => {
    const r = replayRun(spec([{ title: "t", files: ["docs/a.md", "api/1"] }]), ctx, 0, raw);
    const w = writes(r);
    expect(w.map((s) => ctx.place(s.path!))).toEqual(["api/", OUTSIDE]);
  });
  it("a PR that only touches files outside the diagram counts no nodes", () => {
    const r = replayRun(spec([{ title: "t", files: ["docs/a.md", "docs/b.md"] }]), ctx, 0, raw);
    expect(writes(r)).toHaveLength(1);
    expect(r.segs[r.segs.length - 1].note).toBe("这个 PR 改了 0 个节点、2 个文件");
  });
  it("a deleted file is a write with its op kept", () => {
    const s = spec([{ title: "t", files: ["api/old.go"] }]);
    s.commits[0].files[0].op = "delete";
    const w = writes(replayRun(s, ctx, 0, raw))[0];
    expect(w.kind).toBe("write");
    expect(w.files![0].op).toBe("delete");
  });
  it("a squash PR has one commit: one thinking beat, then its nodes", () => {
    const r = replayRun(spec([{ title: "补缓存 (#7)", files: ["api/1", "db/1", "web/1"] }], { source: "squash" }), ctx, 0, raw);
    expect(r.segs.filter((s) => s.kind === "think" && s.note === "补缓存 (#7)")).toHaveLength(1);
    expect(writes(r)).toHaveLength(3);
  });
  it("an empty PR is just its summary: 0 nodes, 0 files", () => {
    const r = replayRun(spec([]), ctx, 0, raw);
    expect(writes(r)).toHaveLength(0);
    expect(r.segs).toHaveLength(1);
    expect(r.segs[0].note).toBe("这个 PR 改了 0 个节点、0 个文件");
  });
  it("a commit without files still gets its thinking beat", () => {
    const r = replayRun(spec([{ title: "空提交", files: [] }]), ctx, 0, raw);
    expect(r.segs.map((s) => s.kind)).toEqual(["think", "think"]);
  });
});

describe("the summary and the whole length", () => {
  it("ends with 2 s and the count of nodes and distinct files", () => {
    const r = replayRun(spec([{ title: "a", files: ["api/1", "db/1"] }, { title: "b", files: ["api/1", "web/1"] }]), ctx, 0, raw);
    const last = r.segs[r.segs.length - 1];
    expect(last.end - last.start).toBe(2000);
    expect(last.note).toBe("这个 PR 改了 3 个节点、3 个文件");
  });
  it("a typical PR takes about 20–40 s at 1×", () => {
    for (const [commits, per] of [[3, 2], [4, 2], [6, 3], [9, 3]]) {
      const cs = Array.from({ length: commits }, (_, i) => ({ title: `c${i}`, files: ["api/", "db/", "web/", "cache/"].slice(0, per).map((d, j) => `${d}f${i}_${j}`) }));
      const r = replayRun(spec(cs), ctx, 0);
      const total = r.segs[r.segs.length - 1].end - r.segs[0].start;
      expect(total).toBeGreaterThanOrEqual(19_000);
      expect(total).toBeLessThanOrEqual(41_000);
    }
  });
});

describe("walking takes what it takes: a segment is the walk there plus the writing", () => {
  const slow: ReplayCtx = { ...ctx, walkMs: (from, to) => (from == null ? 0 : (Math.abs(X[dirOf(from)!] - X[dirOf(to)!]) / 100) * 3000) };
  it("a write at another node lasts its walk longer; the first one, where it appears, has none", () => {
    const s = spec([{ title: "t", files: ["api/1", "db/1", "cache/1"] }]);
    const a = writes(replayRun(s, ctx, 0, raw));
    const b = writes(replayRun(s, slow, 0, raw));
    expect(b[0].end - b[0].start).toBe(a[0].end - a[0].start);
    expect(b[1].end - b[1].start).toBe(a[1].end - a[1].start + 3000);
    expect(b[2].end - b[2].start).toBe(a[2].end - a[2].start + 6000);
  });
  it("fitting squeezes the writing, not the walking", () => {
    const cs = Array.from({ length: 12 }, (_, i) => ({ title: `c${i}`, files: ["api/1", "web/1"] }));
    const r = replayRun(spec(cs), slow);
    const w = writes(r);
    // every hop api↔web is 200 px = 6 s of walking that stays whole; staying put walks nothing
    const dirs = w.map((x) => dirOf(x.path!));
    w.forEach((x, i) => {
      if (i > 0 && dirs[i] !== dirs[i - 1]) expect(x.end - x.start).toBeGreaterThanOrEqual(6000 + 700);
    });
    expect(dirs.some((d, i) => i > 0 && d !== dirs[i - 1])).toBe(true);
  });
});

describe("a heavy PR is long rather than a blur: no write under 0.7 s (a walk needs that), no thought under 0.35 s", () => {
  it("keeps the floors", () => {
    const cs = Array.from({ length: 30 }, (_, i) => ({ title: `c${i}`, files: ["api/", "db/", "web/", "cache/"].map((d, j) => `${d}f${i}_${j}`) }));
    const r = replayRun(spec(cs), ctx, 0);
    for (const s of r.segs) expect(s.end - s.start).toBeGreaterThanOrEqual(s.kind === "write" ? 700 : 350);
  });
});

describe("fileCounts: the +N on each node at a moment", () => {
  const r = replayRun(spec([{ title: "a", files: ["api/1", "api/2", "api/3", "db/1"] }, { title: "b", files: ["api/3", "web/1"] }]), ctx, 0, raw);
  const at = (t: number) => fileCounts(r, t, (p) => (dirOf(p) ? dirOf(p)! : null));
  const w = writes(r);
  it("nothing before the first write starts", () => expect(at(w[0].start - 1).size).toBe(0));
  it("counts up while a node's write goes on and never more than its files", () => {
    const mid = at((w[0].start + w[0].end) / 2).get("api/") ?? 0;
    expect(mid).toBeGreaterThanOrEqual(1);
    expect(mid).toBeLessThanOrEqual(3);
    expect(at(w[0].end).get("api/")).toBe(3);
  });
  it("adds up over the commits; a file written twice counts once", () => {
    const all = at(r.lastAt);
    expect(all.get("api/")).toBe(3);
    expect(all.get("db/")).toBe(1);
    expect(all.get("web/")).toBe(1);
  });
  it("the tray gets no badge", () => {
    const o = replayRun(spec([{ title: "t", files: ["docs/a.md"] }]), ctx, 0, raw);
    expect(fileCounts(o, o.lastAt, (p) => (dirOf(p) ? dirOf(p)! : null)).size).toBe(0);
  });
  it("a parent node shows the total of its sub-diagram (the canvas's own place function decides)", () => {
    const parent = fileCounts(r, r.lastAt, () => "parent");
    expect(parent.get("parent")).toBe(5);
  });
});
