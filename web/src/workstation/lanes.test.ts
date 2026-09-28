// 工位视图 lanes built from the native logs (deterministic: the same log gives the same lane).
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { buildLane, readPath } from "./lanes.ts";

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
