// IM1: a native session imported by hand (`PUT /api/agent/sessions/<id>` with a nativeId) has a binding and a transcript on the server but no Agora session of its own on the page: no tab,
// nothing to open — its history is in the page's store and nowhere to be seen. The page adopts every bound session it has no session for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptTargets, adoptBound } from "./adoptBound.ts";
import { agents, handleEvent, type Binding } from "./agents.ts";
import { sessions } from "./store.ts";

const binding = (createdAt = 1): Binding => ({ agent: "pi", model: "", effort: "", nativeId: "01a0f2a3", createdAt, started: true }) as Binding;
const status = { running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0 } };

describe("adoptTargets: which bound sessions the page has no session for", () => {
  it("the bound ones without a session, in binding order; nothing for those it has, nor for ones it is told to leave", () => {
    const bound = { a: {}, b: {}, c: {}, d: {} };
    expect(adoptTargets(Object.keys(bound), { a: {}, c: {} }, new Set(["d"]))).toEqual(["b"]);
    expect(adoptTargets([], {}, new Set())).toEqual([]);
  });
});

describe("adoptBound: the imported session gets its session, on a canvas, and its history is there", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    sessions.hydrate({ sessions: {}, turns: {} } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a binding arrives for a session the page does not have: it is created on the canvas of the latest session, else the open one, once", async () => {
    sessions.create("c-main", "s-old");
    await handleEvent({ t: "transcript", sessionId: "pi-fork-1", reset: true, items: [{ id: "u1", kind: "user", text: "先了解一下这个项目", at: 1, source: "terminal" }] });
    await handleEvent({ t: "status", sessionId: "pi-fork-1", binding: binding(), ...status });
    adoptBound(() => null);
    const s = sessions.get().sessions["pi-fork-1"];
    expect(s?.canvasId).toBe("c-main");
    expect(agents.get().items["pi-fork-1"]).toHaveLength(1); // its history is in the store, and now it has a place to be shown
    adoptBound(() => null);
    expect(Object.keys(sessions.get().sessions).filter((k) => k === "pi-fork-1")).toHaveLength(1);
  });

  it("no session at all yet: the canvas the page gives (the one open)", async () => {
    await handleEvent({ t: "status", sessionId: "pi-x", binding: binding(), ...status });
    adoptBound(() => "c-open");
    expect(sessions.get().sessions["pi-x"]?.canvasId).toBe("c-open");
  });

  it("no canvas to put it on: nothing yet (it is tried again when there is one)", async () => {
    await handleEvent({ t: "status", sessionId: "pi-y", binding: binding(), ...status });
    adoptBound(() => null);
    expect(sessions.get().sessions["pi-y"]).toBeUndefined();
    adoptBound(() => "c-late");
    expect(sessions.get().sessions["pi-y"]?.canvasId).toBe("c-late");
  });

  it("a session the page already has is left alone", async () => {
    sessions.create("c-a", "s-mine");
    await handleEvent({ t: "status", sessionId: "s-mine", binding: binding(), ...status });
    adoptBound(() => "c-other");
    expect(sessions.get().sessions["s-mine"]?.canvasId).toBe("c-a");
  });
});
