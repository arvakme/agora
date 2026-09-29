// Which agent tags show, in what order, with what state (session/agentTags.ts).
import { describe, expect, it } from "vitest";
import type { RunSeg, WorkRun } from "../workstation/runs/types";
import { agentTags, splitTags, tagLabel, tagState } from "./agentTags.ts";

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

describe("agentTags: how long a waiting tag has waited", () => {
  it("carries the start of the wait it is in, and nothing when it is not waiting", () => {
    const tags = agentTags([run("w", { segs: [seg("wait", 400, 1100)] }), run("x", { segs: [seg("exec", 900, 1100)] })], NOW);
    expect(tags.find((t) => t.runId === "w")?.waitSince).toBe(400);
    expect(tags.find((t) => t.runId === "x")?.waitSince).toBeUndefined();
  });
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

describe("splitTags: at work and waiting stay, the latest idle two, the rest 「+N」", () => {
  const mk = (id: string, state: "working" | "idle", lastAt = 0) => agentTags([run(id, state === "working" ? { segs: [seg("exec", 900, 1100)], lastAt } : { lastAt })], NOW)[0];
  const seven = [mk("w1", "working"), mk("w2", "working"), ...["i1", "i2", "i3", "i4", "i5"].map((id, i) => mk(id, "idle", 100 - i))];
  const all = agentTags(seven.map((t) => run(t.runId, t.state === "working" ? { segs: [seg("exec", 900, 1100)] } : { lastAt: Number(t.lastAt) })), NOW);
  it("7 sessions: the 2 at work and the 2 latest idle, the other 3 in 「+N」", () => {
    const f = splitTags(all, 8);
    expect(f.shown.map((t) => t.runId)).toEqual(["w1", "w2", "i1", "i2"]);
    expect(f.more.map((t) => t.runId)).toEqual(["i3", "i4", "i5"]);
  });
  it("little room: 「+N」 takes a place and the rest fold in", () => {
    const f = splitTags(all, 3);
    expect(f.shown).toHaveLength(2);
    expect(f.more.length).toBe(5);
  });
  it("few sessions: all shown, no 「+N」", () => {
    const f = splitTags(all.slice(0, 3), 6);
    expect(f.more).toEqual([]);
  });
  it("someone waiting is never folded behind an idle one", () => {
    const tags = agentTags([run("idle", { lastAt: 5 }), run("waiting", { segs: [seg("wait", 900, 1100)] })], NOW);
    expect(splitTags(tags, 4).shown[0].runId).toBe("waiting");
  });
  it("the tag being looked at stays visible", () => expect(splitTags(all, 3, "i5").shown.map((t) => t.runId)).toContain("i5"));
});

describe("a session whose run has no name yet still gets a tag (a fresh Grok session crashed the top bar)", () => {
  it("the tag falls back to the agent's kind, and the label never throws", () => {
    const tags = agentTags([run("a", { name: undefined as unknown as string, agent: "grok" })], NOW);
    expect(tags[0].name).toBe("grok");
    expect(tagLabel(undefined as unknown as string, false)).toBe("");
  });
});

describe("tagLabel: at most 12 characters, the full name in the tooltip", () => {
  it("the agent's name as is", () => expect(tagLabel("Claude Code · 看看沙箱云电脑在手机端的适配实现", false)).toBe("Claude Code"));
  it("several of one agent: what it is about, cut to 12 with …", () => expect(tagLabel("Claude Code · 看看沙箱云电脑在手机端的适配实现", true)).toBe("看看沙箱云电脑在手机端的…"));
  it("short stays", () => expect(tagLabel("Pi", true)).toBe("Pi"));
});
