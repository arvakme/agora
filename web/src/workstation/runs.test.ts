// Runs: the typed client normalises what /api/agent/runs serves (and falls back when it does not
// exist yet); top-level runs derived from transcripts; bubble eligibility and side-by-side slots.
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { pickBubbles, slots } from "./crowd.ts";
import { fetchRunTree, normaliseRun, resetRunClient } from "./runs/client.ts";
import { runFromTranscript } from "./runs/derive.ts";
import { flatten, receiptAt } from "./runs/types.ts";

describe("normaliseRun", () => {
  it("reads the wire shape, nests children, converts seconds and drops junk", () => {
    const r = normaliseRun({
      id: "claude:abc",
      agent: "claude",
      name: "Claude Code",
      sessionId: "s1",
      running: true,
      segments: [{ kind: "write", start: 1_790_000_000, end: 1_790_000_004, path: "server/a.py" }, { kind: "bogus", start: 1 }],
      receipts: [],
      children: [{ id: "smx:T-1", agent: "codex", via: "seedmux", evidence: "seedmux", task: "补测试", segments: [], receipts: [{ at: 1_790_000_001_000, state: "dispatched" }, { at: 1_790_000_009_000, state: "claimed" }] }],
    })!;
    expect(r.segs).toEqual([{ kind: "write", start: 1_790_000_000_000, end: 1_790_000_004_000, path: "server/a.py", label: "write" }]);
    expect(r.children[0]).toMatchObject({ id: "smx:T-1", parentId: "claude:abc", via: "seedmux", spawnAt: 1_790_000_001_000, task: "补测试" });
    expect(receiptAt(r.children[0], 1_790_000_010_000)).toBe("claimed");
    expect(flatten([r]).map((f) => [f.run.id, f.depth])).toEqual([
      ["claude:abc", 0],
      ["smx:T-1", 1],
    ]);
    expect(normaliseRun({ agent: "x" })).toBeNull();
  });
});

describe("fetchRunTree", () => {
  it("returns null (and stops asking for a while) when the server has no run trees yet", async () => {
    resetRunClient();
    let calls = 0;
    const f = (async () => ((calls++, new Response("", { status: 404 })))) as unknown as typeof fetch;
    expect(await fetchRunTree("s1", f)).toBeNull();
    expect(await fetchRunTree("s1", f)).toBeNull();
    expect(calls).toBe(1);
  });
  it("picks the session's own run from the list", async () => {
    resetRunClient();
    const body = { runs: [{ id: "x", agent: "pi", sessionId: "other" }, { id: "y", agent: "pi", sessionId: "s1", children: [] }] };
    const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchRunTree("s1", f))?.id).toBe("y");
  });
});

describe("runFromTranscript", () => {
  const items: Item[] = [
    { id: "u", kind: "user", text: "改", at: 0 },
    { id: "t1", kind: "tool", at: 1000, endAt: 2000, msg: "m1", tool: { name: "Bash", input: "pytest -q", output: "ok" } },
    { id: "t2", kind: "tool", at: 3000, endAt: 5000, msg: "m2", tool: { name: "Task", input: "查回调签名", output: "ok" } },
    { id: "e", kind: "end", at: 6000 },
  ];
  it("makes one top-level run with the canvas's words for each step", () => {
    const r = runFromTranscript({ sessionId: "s1", agent: "claude", name: "Claude Code", items, running: false, now: 10_000 });
    expect(r).toMatchObject({ id: "s1", sessionId: "s1", agent: "claude", running: false, lastAt: 6000 });
    expect(r.segs.map((s) => [s.kind, s.label])).toEqual([
      ["think", "思考"],
      ["exec", "跑 pytest"],
      ["think", "思考"],
      ["delegate", "派 查回调签名"],
      ["think", "思考"],
    ]);
    expect(r.segs[1].cmd).toBe("pytest -q");
  });
});

describe("pickBubbles / slots", () => {
  it("gives every busy session a bubble, a sub-agent only when it needs you; needs first", () => {
    const ids = pickBubbles([
      { id: "a", depth: 0, need: false, writing: false, order: 0 },
      { id: "b", depth: 1, need: false, writing: true, order: 1 },
      { id: "c", depth: 1, need: true, writing: false, order: 2 },
      { id: "d", depth: 0, need: false, writing: true, order: 3 },
      { id: "e", depth: 0, need: false, writing: false, order: 4, idle: true },
    ]);
    expect(ids).toEqual(["c", "d", "a"]);
  });
  it("stands figures at one node side by side in tree order", () => {
    const s = slots([
      { id: "sub", place: "api", order: 2 },
      { id: "pi", place: "api", order: 0 },
      { id: "cc", place: "db", order: 1 },
    ]);
    expect([s.get("pi"), s.get("sub"), s.get("cc")]).toEqual([0, 1, 0]);
  });
});
