// The trajectory follows a played turn: the current row, the panel's view, and the sub-agents under their turn.
import { describe, expect, it } from "vitest";
import type { WorkRun } from "../workstation/runs/types";
import { currentRecord, panelPlays } from "./replayStep.ts";
import { kidsByTurn } from "./subAgents.ts";
import type { TrajTurn } from "./trajectoryModel.ts";

const rec = (id: string, at: number) => ({ id, at }) as never;
const turn = (n: number, startedAt: number, ats: number[]): TrajTurn => ({ n, startedAt, steps: [{ n: 1, records: ats.map((a, i) => rec(`t${n}r${i}`, a)) }] }) as never;
const turns = [turn(5, 100, [100, 120, 140]), turn(6, 200, [200, 230, 260])];

describe("currentRecord: the row a played turn is at", () => {
  it("the last record of that turn that has happened", () => {
    expect(currentRecord(turns, 6, 235)).toBe("t6r1");
    expect(currentRecord(turns, 6, 999)).toBe("t6r2");
  });
  it("before the turn's first record: none; another turn's records do not count", () => {
    expect(currentRecord(turns, 6, 150)).toBeNull();
    expect(currentRecord(turns, 5, 150)).toBe("t5r2");
  });
  it("a turn that is not there: none", () => expect(currentRecord(turns, 9, 500)).toBeNull());
});

describe("panelPlays: the panel goes to the trajectory while a turn plays, and back after", () => {
  it("chat → trajectory on play, and back to chat at the end", () => {
    const on = panelPlays({ view: "chat", saved: null }, true, "trajectory");
    expect(on).toEqual({ view: "trajectory", saved: "chat" });
    expect(panelPlays(on, true, "trajectory")).toBe(on);
    expect(panelPlays(on, false, "trajectory")).toEqual({ view: "chat", saved: null });
  });
  it("already on the trajectory: comes back to it", () => {
    const on = panelPlays({ view: "trajectory", saved: null }, true, "trajectory");
    expect(panelPlays(on, false, "trajectory").view).toBe("trajectory");
  });
  it("not playing and nothing saved: nothing changes", () => {
    const s = { view: "chat", saved: null };
    expect(panelPlays(s, false, "trajectory")).toBe(s);
  });
});

describe("kidsByTurn: the sub-agents under the turn that dispatched them", () => {
  const kid = (id: string, spawnAt?: number) => ({ id, spawnAt }) as WorkRun;
  it("by the delegate call's turn", () => {
    const run = { children: [kid("a"), kid("b")], segs: [{ kind: "delegate", child: "a", turn: 5 }, { kind: "delegate", child: "b", turn: 6 }] } as never;
    const m = kidsByTurn(run, turns);
    expect(m.get(5)?.map((k) => k.id)).toEqual(["a"]);
    expect(m.get(6)?.map((k) => k.id)).toEqual(["b"]);
  });
  it("without a call (a Seedmux worker): the latest turn started when it was dispatched", () => {
    const m = kidsByTurn({ children: [kid("w1", 150), kid("w2", 210), kid("w3", 90)], segs: [] }, turns);
    expect(m.get(5)?.map((k) => k.id)).toEqual(["w1"]);
    expect(m.get(6)?.map((k) => k.id)).toEqual(["w2"]);
    expect([...m.keys()]).not.toContain(4); // dispatched before any turn: under none
  });
  it("several under one turn keep their order", () => {
    const m = kidsByTurn({ children: [kid("x", 210), kid("y", 220)], segs: [] }, turns);
    expect(m.get(6)?.map((k) => k.id)).toEqual(["x", "y"]);
  });
});
