// Runs: the typed client normalises what /api/agent/runs serves (and falls back when it does not
// exist yet); top-level runs derived from transcripts; bubble eligibility and side-by-side slots.
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { pickBubbles, slots } from "./crowd.ts";
import type { RunTree } from "../session/agents.ts";
import { fromTree, runFromTranscript } from "./runs/derive.ts";
import { flatten, receiptAt, receiptView } from "./runs/types.ts";

describe("fromTree (the server's run tree → sub-agents)", () => {
  const T = 1_790_000_000_000;
  const seg = (kind: "read" | "write" | "exec" | "think" | "wait", s: number, e: number, path?: string) => ({ kind, start: T + s * 1000, end: T + e * 1000, itemId: `i${s}`, turn: 1, label: kind, ...(path ? { path } : {}) });
  const base = { tier: "T1" as const, depth: 0, hiddenDescendants: 0, childCount: 0, descendants: 0 };
  const tree: RunTree = {
    root: "claude:root",
    depth: null,
    folded: {},
    generatedAt: T + 60_000,
    runs: [
      { ...base, id: "claude:root", kind: "claude", label: "Claude Code", sessionId: "s1", state: "running", childCount: 2, descendants: 3, timeline: { segments: [], turns: [], moments: [
        { kind: "dispatch", at: T + 5000, childRunId: "claude:root/a1", toolCallId: "tool-agent-1" },
        { kind: "handoff", at: T + 20000, childRunId: "claude:root/a1", state: "done" },
        { kind: "dispatch", at: T + 6000, childRunId: "smx:T-9", taskId: "T-9" },
      ] } },
      { ...base, id: "claude:root/a1", kind: "claude", label: "Explore", role: "查回调签名", depth: 1, parent: { runId: "claude:root", via: "native", toolCallId: "tool-agent-1", evidence: "toolUseId" }, state: "done", startedAt: T + 5200, endedAt: T + 19000, lastAt: T + 19000, childCount: 1, descendants: 1, timeline: { segments: [seg("read", 6, 9, "docs/a.md"), seg("write", 10, 15, "server/x.py")], turns: [], moments: [] } },
      { ...base, id: "claude:root/a1/b1", kind: "claude", label: "deeper", depth: 2, parent: { runId: "claude:root/a1", via: "native", evidence: "parentAgentId" }, state: "done", timeline: { segments: [seg("read", 11, 12, "x.md")], turns: [], moments: [] } },
      { ...base, id: "smx:T-9", kind: "devin", tier: "T3", label: "worker-3", depth: 1, parent: { runId: "claude:root", via: "seedmux", taskId: "T-9", evidence: "smx-team output" }, state: "done", lastAt: T + 30000,
        receipts: [{ taskId: "T-8", agent: "devin", state: "done", createdAt: T + 1000, repliedAt: T + 3000, accept: "accepted" }, { taskId: "T-9", agent: "devin", state: "done", createdAt: T + 6000, repliedAt: T + 30000 }],
        timeline: { segments: [], turns: [], moments: [] } },
    ],
  };
  const { children, dispatches } = fromTree(tree, "s1", { now: T + 60_000 });
  it("hangs the session's sub-agents under it, one level drawn and deeper ones nested", () => {
    expect(children.map((c) => [c.id, c.parentId, c.via, !!c.coarse])).toEqual([
      ["claude:root/a1", "s1", "native", false],
      ["smx:T-9", "s1", "seedmux", true],
    ]);
    expect(children[0].children.map((c) => c.id)).toEqual(["claude:root/a1/b1"]);
    expect(flatten(children).map((f) => f.depth)).toEqual([0, 1, 0]);
  });
  it("takes dispatch / handoff from the parent's moments and segments from the child's timeline", () => {
    expect(children[0]).toMatchObject({ spawnAt: T + 5000, doneAt: T + 20000, task: "查回调签名", running: false });
    expect(children[0].segs.map((s) => [s.kind, s.path])).toEqual([["read", "docs/a.md"], ["write", "server/x.py"]]);
    expect(dispatches.get("tool-agent-1")).toBe("claude:root/a1");
  });
  it("names receipts: a native hand-back is 已返回结果, a Seedmux reply 声明完成 (never 验收 unless accepted); every ticket counts", () => {
    expect(receiptAt(children[0], T + 25000)).toBe("returned");
    const w = children[1];
    expect(w.receipts.map((r) => receiptView(w, r))).toEqual(["dispatched", "accepted", "dispatched", "claimed"]);
    expect(receiptAt(w, T + 7000)).toBe("dispatched");
    expect(receiptAt(w, T + 40000)).toBe("claimed");
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
  it("gives every session a bubble (idle ones too, last), a sub-agent only when it needs you; needs first", () => {
    const ids = pickBubbles([
      { id: "a", depth: 0, need: false, writing: false, order: 0 },
      { id: "b", depth: 1, need: false, writing: true, order: 1 },
      { id: "c", depth: 1, need: true, writing: false, order: 2 },
      { id: "d", depth: 0, need: false, writing: true, order: 3 },
      { id: "e", depth: 0, need: false, writing: false, order: 4, idle: true },
    ]);
    expect(ids).toEqual(["c", "d", "a", "e"]);
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
