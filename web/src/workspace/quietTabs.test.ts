// FX4 · P1/P2: a canvas opened for an agent is closed when nothing needs it — never while a call holds it, never once the person took it.
import { describe, expect, it } from "vitest";
import { createQuietTabs, QUIET_MS } from "./quietTabs";

describe("quiet tabs: lease, idle, ownership", () => {
  it("P1: an edit that waits 20 s for an asset holds its canvas; the idle time starts when it lets go", () => {
    const q = createQuietTabs();
    let t = 0;
    const now = () => t;
    const release = q.hold("b", now);
    q.opened("b", t);
    for (t = 1000; t <= 20_000; t += 1000) expect(q.due(t)).toEqual([]);
    t = 20_000;
    release();
    expect(q.due(t + QUIET_MS - 1)).toEqual([]); // the count starts at the release, not at the open
    expect(q.due(t + QUIET_MS)).toEqual(["b"]);
  });
  it("two calls at once: the canvas stays until both are done", () => {
    const q = createQuietTabs();
    let t = 0;
    const a = q.hold("b", () => t);
    q.opened("b", 0);
    const b = q.hold("b", () => t);
    t = 1000;
    a();
    expect(q.due(60_000)).toEqual([]);
    b();
    expect(q.due(t + QUIET_MS)).toEqual(["b"]);
  });
  it("a lease let go twice counts once", () => {
    const q = createQuietTabs();
    const a = q.hold("b", () => 0);
    q.opened("b", 0);
    const b = q.hold("b", () => 0);
    a();
    a();
    expect(q.due(60_000)).toEqual([]); // b still holds it
    b();
  });
  it("P2: the person takes it at 2 s and goes elsewhere at 4 s: it is never closed", () => {
    const q = createQuietTabs();
    q.opened("b", 0);
    q.own("b");
    expect(q.due(60_000)).toEqual([]);
    expect(q.isQuiet("b")).toBe(false);
  });
  it("P2: taking it while a call still uses it also ends the quiet (and the call's lease does not bring it back)", () => {
    const q = createQuietTabs();
    let t = 0;
    const r = q.hold("b", () => t);
    q.opened("b", 0);
    q.own("b");
    r();
    expect(q.isQuiet("b")).toBe(false);
    expect(q.due(60_000)).toEqual([]);
  });
  it("the ones that are ours: the set that is not saved into the layout", () => {
    const q = createQuietTabs();
    q.opened("a", 0);
    q.opened("b", 0);
    q.own("a");
    expect([...q.quiet()]).toEqual(["b"]);
  });
  it("a canvas that was open before (a lease but never `opened`) is not ours: never due", () => {
    const q = createQuietTabs();
    const r = q.hold("c", () => 0);
    r();
    expect(q.due(60_000)).toEqual([]);
    expect(q.quiet().size).toBe(0);
  });
});
