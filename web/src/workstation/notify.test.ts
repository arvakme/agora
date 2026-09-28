// 等你就叫你 (web/docs/workstation.md「新想法」): while the page is hidden, a worker that starts waiting on
// you is announced once — with its question — and never for a wait you already saw begin or that is over.
import { describe, expect, it } from "vitest";
import { waitsToTell } from "./notify.ts";
import { scenario } from "./runs/fixtures.ts";
import { flatten, type WorkRun } from "./runs/types.ts";

const S = 1000;
const base = 1_000_000;
// the prototype's scenario: Pi waits on you from 27 s to 33 s
const flat = flatten(scenario(base, base + 28 * S));

describe("waitsToTell", () => {
  it("announces a wait that began after the page was hidden, with its question — once", () => {
    const got = waitsToTell(flat, base + 20 * S, base + 28 * S, new Set());
    expect(got).toEqual([{ key: `mock-pi|${base + 27 * S}`, runId: "mock-pi", sessionId: "mock-pi", title: "Agora", body: "Pi 在等你：POST /users 要不要登录才能调？" }]);
    expect(waitsToTell(flat, base + 20 * S, base + 29 * S, new Set([got[0].key]))).toEqual([]);
  });

  it("not a wait you saw begin, nor one that is over", () => {
    expect(waitsToTell(flat, base + 28 * S, base + 29 * S, new Set())).toEqual([]);
    expect(waitsToTell(flat, base + 20 * S, base + 34 * S, new Set())).toEqual([]);
  });

  it("a sub-agent's wait names who sent it and points at that session", () => {
    const codex: WorkRun = { id: "smx:T-9", agent: "codex", name: "Codex", parentId: "s1", segs: [{ kind: "wait", start: 5 * S, end: 60 * S, label: "等你回复" }], receipts: [], running: true, lastAt: 0, children: [] };
    const pi: WorkRun = { id: "s1", agent: "pi", name: "Pi", sessionId: "s1", segs: [], receipts: [], running: true, lastAt: 0, children: [codex] };
    expect(waitsToTell(flatten([pi]), 0, 10 * S, new Set())).toEqual([{ key: `smx:T-9|${5 * S}`, runId: "smx:T-9", sessionId: "s1", title: "Agora", body: "Codex（Pi 派）在等你回复" }]);
  });
});
