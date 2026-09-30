// A page runs a canvas edit only after the server granted it the claim, and reports whether it is on screen
// (server/canvas/executors.py: the order edits are offered in; sessions.py: one claim per request).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEvent, setBridgeHandler } from "./agents.ts";

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
const serve = (claimOk: boolean) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return { ok: true, json: async () => (url.endsWith("/claim") ? { ok: claimOk } : { ok: true }) } as Response;
  });

describe("a page that executes canvas edits", () => {
  beforeEach(() => (calls = []));
  afterEach(() => vi.unstubAllGlobals());

  it("claims the request first, runs it, and posts the result", async () => {
    vi.stubGlobal("fetch", serve(true));
    const ran = vi.fn(async () => ({ status: "applied" }));
    setBridgeHandler(ran);
    await handleEvent({ t: "hello", sub: "page-1" });
    await handleEvent({ t: "bridge", rid: "b-1", kind: "apply" });
    expect(calls.map((c) => c.url)).toContain("/api/agent/bridge/b-1/claim");
    expect(calls.find((c) => c.url.endsWith("/claim"))?.body).toEqual({ sub: "page-1" });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toEqual({ url: "/api/agent/bridge/b-1", body: { status: "applied" } });
  });

  it("does not run a request another page was given (the claim is refused): a woken-up background tab never applies it twice", async () => {
    vi.stubGlobal("fetch", serve(false));
    const ran = vi.fn(async () => ({ status: "applied" }));
    setBridgeHandler(ran);
    await handleEvent({ t: "hello", sub: "page-1" });
    await handleEvent({ t: "bridge", rid: "b-2", kind: "apply" });
    expect(ran).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/api/agent/bridge/b-2")).toBe(false); // and posts no result for it
  });

  it("runs a request at most once even if it arrives twice", async () => {
    vi.stubGlobal("fetch", serve(true));
    const ran = vi.fn(async () => ({ status: "applied" }));
    setBridgeHandler(ran);
    await handleEvent({ t: "hello", sub: "page-1" });
    await handleEvent({ t: "bridge", rid: "b-3", kind: "apply" });
    await handleEvent({ t: "bridge", rid: "b-3", kind: "apply" });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("reports its visibility and last focus to the server once connected", async () => {
    vi.stubGlobal("fetch", serve(true));
    await handleEvent({ t: "hello", sub: "page-9" });
    const state = calls.find((c) => c.url === "/api/agent/events/page-9/state");
    expect(state).toBeTruthy();
    expect(typeof state!.body.visible).toBe("boolean");
    expect(typeof state!.body.focusedAt).toBe("number");
  });
});
