// Which agent tags show, in what order, with what state (session/agentTags.ts).
import { describe, expect, it } from "vitest";
import type { RunSeg, WorkRun } from "../workstation/runs/types";
import { agentTags, fitTags, tagState } from "./agentTags.ts";

const seg = (kind: RunSeg["kind"], start: number, end: number): RunSeg => ({ kind, start, end, label: kind });
const run = (id: string, o: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "claude", name: id, sessionId: `s-${id}`, segs: [], receipts: [], running: false, lastAt: 0, children: [], ...o });
const NOW = 1000;

describe("tagState", () => {
  it("a call in progress is 干活中", () => expect(tagState(run("a", { segs: [seg("write", 900, 1100)] }), NOW)).toBe("working"));
  it("a question to the person is 等你", () => expect(tagState(run("a", { segs: [seg("wait", 900, 1100)] }), NOW)).toBe("waiting"));
  it("thinking, or a turn running between calls, is 在想", () => {
    expect(tagState(run("a", { segs: [seg("think", 900, 1100)] }), NOW)).toBe("thinking");
    expect(tagState(run("a", { running: true, segs: [seg("write", 100, 200)] }), NOW)).toBe("thinking");
  });
  it("nothing going on is 空闲", () => expect(tagState(run("a", { segs: [seg("write", 100, 200)] }), NOW)).toBe("idle"));
});

describe("agentTags: order and sub-agent count", () => {
  const tops = [
    run("idle-old", { lastAt: 100 }),
    run("thinking", { running: true }),
    run("idle-new", { lastAt: 900 }),
    run("waiting", { segs: [seg("wait", 900, 1100)] }),
    run("working", { segs: [seg("exec", 900, 1100)], children: [run("k1", { children: [run("k2")] }), run("k3")] }),
  ];
  it("working, waiting, thinking, then the most recently idle first", () => {
    expect(agentTags(tops, NOW).map((t) => t.runId)).toEqual(["working", "waiting", "thinking", "idle-new", "idle-old"]);
  });
  it("counts the sub-agents under it, theirs too", () => expect(agentTags(tops, NOW).find((t) => t.runId === "working")?.kids).toBe(3));
});

describe("fitTags: what fits, the rest as 「+N」", () => {
  const tags = agentTags(["a", "b", "c", "d"].map((id, i) => run(id, { lastAt: 100 - i })), NOW);
  it("all fit: no 「+N」", () => expect(fitTags(tags, 4)).toEqual({ shown: tags, more: [] }));
  it("too many: one place is the 「+N」", () => {
    const f = fitTags(tags, 3);
    expect(f.shown.map((t) => t.runId)).toEqual(["a", "b"]);
    expect(f.more.map((t) => t.runId)).toEqual(["c", "d"]);
  });
  it("the tag of the session in front stays visible", () => expect(fitTags(tags, 3, "d").shown.map((t) => t.runId)).toEqual(["a", "d"]));
});
