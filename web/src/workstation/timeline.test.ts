// 工位视图 timeline: lanes built from the native logs, one squeezed time axis, and a worker's place
// and pose as a pure function of time (so scrubbing and replay are exact).
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { buildAxis, buildLane, figureAt, HOME, OUTSIDE, readPath, segAt, WALK_MS } from "./timeline.ts";

const S = 1000;
const user = (id: string, at: number): Item => ({ id, kind: "user", text: "改一下", at });
const tool = (id: string, at: number, endAt: number, name: string, input: string, files?: { path: string; op: "edit" | "write" }[]): Item => ({
  id,
  kind: "tool",
  at,
  endAt,
  msg: `m-${id}`,
  tool: { name, input, output: "ok", ...(files ? { files } : {}) },
});
const end = (id: string, at: number): Item => ({ id, kind: "end", at });

// Claude Code: reads server/app.py, edits it, runs the tests, waits on a question; then a second turn much later.
const ROOT = "/tmp/proj";
const items: Item[] = [
  user("u1", 0),
  tool("r1", 2 * S, 3 * S, "Read", `${ROOT}/server/app.py`),
  tool("e1", 5 * S, 6 * S, "Edit", `${ROOT}/server/app.py`, [{ path: "server/app.py", op: "edit" }]),
  tool("b1", 6 * S, 10 * S, "Bash", "pytest -q"),
  tool("q1", 10 * S, 14 * S, "AskUserQuestion", "{}"),
  end("x1", 15 * S),
  user("u2", 600 * S),
  tool("e2", 601 * S, 602 * S, "Write", `${ROOT}/docs/notes.md`, [{ path: "docs/notes.md", op: "write" }]),
  end("x2", 603 * S),
];

describe("buildLane", () => {
  const lane = buildLane("s1", items, { root: ROOT });
  it("maps tool calls to read / write / exec / wait and the gaps inside a turn to thinking", () => {
    expect(lane.segs.map((s) => [s.kind, s.start / S, s.end / S])).toEqual([
      ["think", 0, 2],
      ["read", 2, 3],
      ["think", 3, 5],
      ["write", 5, 6],
      ["exec", 6, 10],
      ["wait", 10, 14],
      ["think", 14, 15],
      ["think", 600, 601],
      ["write", 601, 602],
      ["think", 602, 603],
    ]);
    expect(lane.segs[1]).toMatchObject({ path: "server/app.py", turn: 1, itemId: "r1", label: "读 app.py" });
    expect(lane.segs[8]).toMatchObject({ path: "docs/notes.md", turn: 2 });
    expect(lane.turns).toEqual([
      { n: 1, start: 0, end: 15 * S },
      { n: 2, start: 600 * S, end: 603 * S },
    ]);
  });
  it("is deterministic: the same log gives the same lane", () => {
    expect(buildLane("s1", [...items].reverse(), { root: ROOT })).toEqual(lane);
  });
  it("a running call lasts until now", () => {
    const l = buildLane("s1", [user("u", 0), { ...tool("b", 1 * S, 0, "Bash", "sleep 9"), endAt: undefined, tool: { name: "Bash", input: "sleep 9" } }], { live: true, now: 7 * S });
    expect(l.segs.at(-1)).toMatchObject({ kind: "exec", start: 1 * S, end: 7 * S });
  });
});

describe("readPath", () => {
  it("takes a file path from the input, relative to the project", () => {
    expect(readPath("/tmp/proj/server/app.py", "/tmp/proj")).toBe("server/app.py");
    expect(readPath("./web/a.ts", "/tmp/proj")).toBe("web/a.ts");
    expect(readPath("grep -n foo", "/tmp/proj")).toBeUndefined();
    expect(readPath("/etc/hosts", "/tmp/proj")).toBe("/etc/hosts");
  });
});

describe("buildAxis", () => {
  const lanes = [buildLane("s1", items, { root: ROOT }), buildLane("s2", [user("v", 4 * S), tool("c", 5 * S, 8 * S, "exec_command", "npm test"), end("y", 9 * S)])];
  const axis = buildAxis(lanes, { gap: 20 * S, gapW: 3 * S })!;
  it("squeezes long idle gaps, keeps busy time real", () => {
    expect(axis.toX(0)).toBe(0);
    expect(axis.toX(15 * S)).toBe(15 * S);
    expect(axis.toX(600 * S)).toBe(18 * S);
    expect(axis.span).toBe(21 * S);
    expect(axis.breaks).toHaveLength(1);
    expect(axis.breaks[0]).toMatchObject({ from: 15 * S, to: 600 * S });
  });
  it("round-trips between time and axis", () => {
    for (const t of [0, 7 * S, 15 * S, 601.5 * S, 603 * S]) expect(axis.fromX(axis.toX(t))).toBeCloseTo(t, 6);
  });
  it("finds the segment under a click", () => {
    expect(segAt(lanes[0], axis, axis.toX(8 * S))?.kind).toBe("exec");
    expect(segAt(lanes[1], axis, axis.toX(20 * S), 100)).toBeNull();
    // A click next to a short call picks the call, not the thinking around it.
    expect(segAt(lanes[0], axis, axis.toX(4.9 * S), 0.5 * S)?.kind).toBe("write");
  });
});

describe("figureAt (replay)", () => {
  const lane = buildLane("s1", items, { root: ROOT });
  const locate = (p: string) => (p.startsWith("server/") ? "api" : null);
  it("starts at home, walks to the node of the file it reads (arriving as the read starts), then works there", () => {
    expect(figureAt(lane, 0.5 * S, locate)).toMatchObject({ pose: "think", at: HOME });
    expect(figureAt(lane, 2 * S - WALK_MS / 2, locate)).toMatchObject({ pose: "walk", at: "api", from: HOME, walk: 0.5 });
    expect(figureAt(lane, 2 * S, locate)).toMatchObject({ pose: "read", at: "api", walk: 1 });
    expect(figureAt(lane, 5.5 * S, locate)).toMatchObject({ pose: "write", at: "api", walk: 1 });
    expect(figureAt(lane, 8 * S, locate)).toMatchObject({ pose: "exec", at: "api" });
    expect(figureAt(lane, 12 * S, locate)).toMatchObject({ pose: "wait", at: "api" });
  });
  it("is idle between turns and goes to the outside desk for files off the diagram", () => {
    expect(figureAt(lane, 100 * S, locate)).toMatchObject({ pose: "idle", at: "api", seg: null });
    expect(figureAt(lane, 601.5 * S, locate)).toMatchObject({ pose: "write", at: OUTSIDE, from: "api" });
  });
  it("jumping straight to a time gives the same state as getting there step by step", () => {
    const ts = Array.from({ length: 700 }, (_, i) => i * S);
    const stepped = ts.map((t) => figureAt(lane, t, locate));
    expect(figureAt(lane, 602 * S, locate)).toEqual(stepped[602]);
  });
  it("reduced motion: no walking", () => {
    expect(figureAt(lane, 2 * S + 10, locate, 0)).toMatchObject({ pose: "read", walk: 1 });
  });
});

// Server-side tool facts (server/canvas/adapters/): the page does not need to know the CLI's tool names.
describe("buildLane with server tool facts", () => {
  const facts: Item[] = [
    user("u1", 0),
    // Codex reads through the shell: name "shell", but the server says read + which file.
    { id: "c1", kind: "tool", at: 1 * S, endAt: 2 * S, msg: "m1", tool: { name: "shell", input: "sed -n 1,40p server/x.py", activity: "read", reads: ["server/x.py"] } },
    // A CLI Agora has never heard of: an unknown tool name with a known activity.
    { id: "g1", kind: "tool", at: 3 * S, endAt: 4 * S, msg: "m2", tool: { name: "frobnicate_file", input: "{}", activity: "edit", files: [{ path: "a.txt", op: "edit" }] } },
    { id: "w1", kind: "tool", at: 5 * S, endAt: 7 * S, msg: "m3", tool: { name: "approve_gate", input: "{}", activity: "tools", waitsUser: true } },
    end("x1", 8 * S),
  ];
  const lane = buildLane("s1", facts, { root: ROOT });
  it("uses tool.activity, tool.reads and tool.waitsUser", () => {
    const tools = lane.segs.filter((s) => s.itemId);
    expect(tools.map((s) => [s.itemId, s.kind, s.path])).toEqual([
      ["c1", "read", "server/x.py"],
      ["g1", "write", "a.txt"],
      ["w1", "wait", undefined],
    ]);
  });
});
