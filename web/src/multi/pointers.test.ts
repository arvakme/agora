// Several sessions at once: one pointer each, side by side on a shared node, and a notice when two
// of them write the same file or node close together.
import { describe, expect, it } from "vitest";
import type { Link } from "../pointer/codeLinks.ts";
import { activeSessions, conflicts, conflictsOf, sessionPointers, stacks, type SessionWrites } from "./pointers.ts";

const links: Link[] = [
  { id: "api", label: "API", globs: ["server/**"] },
  { id: "web", label: "Web", globs: ["web/**"] },
];
const w = (path: string, at: number, turn = 1) => ({ path, op: "edit" as const, at, toolId: `t-${path}-${at}`, turn });
const MIN = 60_000;

describe("sessionPointers / stacks", () => {
  const sessions: SessionWrites[] = [
    { sessionId: "claude", files: [w("server/app.py", 1 * MIN), w("web/a.ts", 2 * MIN)] },
    { sessionId: "codex", files: [w("web/b.ts", 3 * MIN)] },
    { sessionId: "pi", files: [w("server/db.py", 4 * MIN)] },
  ];
  it("gives each session its own pointer on its latest mapped write", () => {
    const ps = sessionPointers(sessions, links);
    expect(ps.map((p) => [p.sessionId, p.state.current?.element])).toEqual([
      ["claude", "web"],
      ["codex", "web"],
      ["pi", "api"],
    ]);
  });
  it("puts pointers on one node side by side, the followed session first", () => {
    const st = stacks(sessionPointers(sessions, links), "claude");
    const web = st.find((s) => s.element === "web")!;
    expect(web.pointers.map((p) => p.sessionId)).toEqual(["claude", "codex"]);
    expect(st[0].element).toBe("web");
    // Without a followed session the most recent writer leads.
    expect(stacks(sessionPointers(sessions, links)).find((s) => s.element === "web")!.pointers.map((p) => p.sessionId)).toEqual(["codex", "claude"]);
  });
  it("replays: only writes up to the given time count", () => {
    const ps = sessionPointers(sessions, links, 1.5 * MIN);
    expect(ps.find((p) => p.sessionId === "claude")!.state.current?.element).toBe("api");
    expect(ps.find((p) => p.sessionId === "codex")!.state.current).toBeNull();
  });
});

describe("activeSessions", () => {
  it("keeps running and recent sessions; the last focused one gets no exception (no stale pointer)", () => {
    const info = (id: string) => ({ a: { lastAt: 0, running: true }, b: { lastAt: 100 * MIN, running: false }, c: { lastAt: 0, running: false }, d: { lastAt: 0, running: false } })[id]!;
    expect(activeSessions(["a", "b", "c", "d"], info, 110 * MIN)).toEqual(["a", "b"]);
  });
});

describe("conflicts", () => {
  it("same file by two sessions within the window", () => {
    const cs = conflicts(
      [
        { sessionId: "claude", files: [w("server/app.py", 1 * MIN)] },
        { sessionId: "codex", files: [w("server/app.py", 5 * MIN)] },
      ],
      links,
      { now: 6 * MIN },
    );
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: "file", path: "server/app.py", element: "api", sessions: ["claude", "codex"], at: 5 * MIN });
  });
  it("same node through different files; nothing outside the window or within one session", () => {
    const cs = conflicts(
      [
        { sessionId: "claude", files: [w("server/app.py", 1 * MIN), w("server/app.py", 2 * MIN), w("web/a.ts", 1 * MIN)] },
        { sessionId: "codex", files: [w("server/db.py", 8 * MIN), w("web/a.ts", 40 * MIN)] },
      ],
      links,
      { now: 41 * MIN },
    );
    expect(cs.map((c) => [c.kind, c.element, c.path])).toEqual([["node", "api", undefined]]);
    expect(conflictsOf(cs, "codex")).toHaveLength(1);
    expect(conflictsOf(cs, "pi")).toHaveLength(0);
  });
  it("files outside the diagram still conflict by path; old ones drop off; replay sees only the past", () => {
    const s = [
      { sessionId: "a", files: [w("docs/x.md", 1 * MIN)] },
      { sessionId: "b", files: [w("docs/x.md", 2 * MIN)] },
    ];
    expect(conflicts(s, links, { now: 3 * MIN })[0]).toMatchObject({ kind: "file", path: "docs/x.md" });
    expect(conflicts(s, links, { now: 200 * MIN })).toHaveLength(0);
    expect(conflicts(s, links, { at: 1.5 * MIN })).toHaveLength(0);
  });
});
