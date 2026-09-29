// Which session a canvas comment is handed to (session/pickSession.ts): the one the person is looking at,
// else the most recently active one that can still take a message; a dead one is never picked.
import { describe, expect, it } from "vitest";
import { pickSession, sendable } from "./pickSession.ts";
import type { Binding, Status } from "./agents.ts";

const b = (agent: Binding["agent"], createdAt = 1): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt });
const st = (over: Partial<Status> = {}): Status => ({ running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0, app: null }, ...over });
const gone = st({ native: { state: "missing", blocking: true, nativeId: "n", candidates: [], message: "原生会话目录已不在" } });

const ids = ["old", "new", "watched"];
const base = { ids, bindings: { old: b("pi"), new: b("claude"), watched: b("codex") }, status: {}, activeAt: { old: 1, new: 5, watched: 3 }, open: new Set<string>() };

describe("sendable: the server's own rules, read off the status it pushes", () => {
  it("is true for a bound session with no problem, or no status yet", () => {
    expect(sendable(b("pi"), undefined)).toBe(true);
    expect(sendable(b("pi"), st())).toBe(true);
  });
  it("is false without a binding, for a copy, and when the native log is gone (unless a live terminal holds it)", () => {
    expect(sendable(undefined, st())).toBe(false);
    expect(sendable(b("pi"), st({ copy: { from: "x", fromInstance: "y", at: 1 } }))).toBe(false);
    expect(sendable(b("pi"), gone)).toBe(false);
    expect(sendable(b("pi"), { ...gone, terminal: { alive: true, attach: "", clients: 0, app: "tmux" } })).toBe(true);
    expect(sendable(b("pi"), st({ native: { state: "duplicates", blocking: false, nativeId: "n", candidates: [], message: "" } }))).toBe(true);
  });
});

describe("pickSession", () => {
  it("prefers the session the person has open and is looking at", () => {
    const r = pickSession({ ...base, open: new Set(["watched", "old"]), focused: "watched" });
    expect(r.sid).toBe("watched");
  });
  it("then any open one (the most recent), then the most recently active", () => {
    expect(pickSession({ ...base, open: new Set(["watched", "old"]), focused: "new" }).sid).toBe("watched"); // focused but its tab is closed
    expect(pickSession({ ...base }).sid).toBe("new");
  });
  it("skips a dead session even when it is the one being looked at", () => {
    const r = pickSession({ ...base, status: { watched: gone, new: gone }, open: new Set(["watched"]), focused: "watched" });
    expect(r.sid).toBe("old");
    expect(r.live).toEqual(["old"]);
  });
  it("skips the ones already tried", () => {
    expect(pickSession({ ...base, skip: ["new"] }).sid).toBe("watched");
  });
  it("returns nothing when no session can take it: the person is asked to choose", () => {
    const r = pickSession({ ...base, status: { old: gone, new: gone, watched: gone } });
    expect(r.sid).toBeUndefined();
    expect(pickSession({ ...base, ids: ["unbound"] }).sid).toBeUndefined();
  });
  it("lists every live candidate, most recent first (the button names the agent when there are several)", () => {
    expect(pickSession({ ...base }).live).toEqual(["new", "watched", "old"]);
  });
});
