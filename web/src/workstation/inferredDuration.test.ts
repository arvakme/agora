// A log without times (Cursor's transcript: the server spreads the records over the turn) has no real call lengths: its items carry
// `durationInferred`, its segments `durationKnown: false`, so a read is work at the node, not a glance (web/docs/workstation.md §2).
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { buildLane } from "./lanes.ts";

const items = (inferred: boolean): Item[] => [
  { id: "u1", kind: "user", text: "读 server/app.py", at: 1000, source: "agora" },
  { id: "t1", kind: "tool", at: 2000, endAt: 3100, ...(inferred ? { durationInferred: true } : {}), tool: { name: "Read", input: "server/app.py", args: "{}", activity: "read", reads: ["server/app.py"] } },
  { id: "end-u1", kind: "end", at: 4000, turn: "u1" },
];

describe("inferred call lengths", () => {
  it("a read whose length is guessed is not a known length", () => {
    const [s] = buildLane("s1", items(true), { root: "/work/p" }).segs.filter((x) => x.kind === "read");
    expect(s.path).toBe("server/app.py");
    expect(s.durationKnown).toBe(false);
  });
  it("a read with a real length is (a Claude Read of 1.1 s stays a glance)", () => {
    const [s] = buildLane("s1", items(false), { root: "/work/p" }).segs.filter((x) => x.kind === "read");
    expect(s.durationKnown).toBeUndefined();
  });
});
