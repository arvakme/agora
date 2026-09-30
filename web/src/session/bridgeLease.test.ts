// FX4 · P1: an agent's call holds its canvas for as long as it runs (the page closes a canvas it opened quietly only when nothing uses it).
import { describe, expect, it, vi } from "vitest";

let handler: ((req: { rid: string; kind: string } & Record<string, unknown>) => Promise<unknown>) | null = null;
// the bridge's own imports that drag in the editor are not what is tested here
vi.mock("@excalidraw/excalidraw", () => ({ CaptureUpdateAction: {} }));
vi.mock("../anim/AnimLayer", () => ({ animHosts: new Map() }));
vi.mock("../canvas/scene", () => ({ byId: () => new Map(), codePathsOf: () => [], labelOf: () => "", libraryMeta: () => null, live: () => true, nameOf: () => "", versionOf: () => "" }));
vi.mock("../canvas/context", () => ({ staleIds: () => [] }));
vi.mock("../canvas/modelView", () => ({ toModelView: () => ({}) }));
vi.mock("../ops/apply", () => ({ applyPlan: () => ({}) }));
vi.mock("../ops/ops", () => ({ referencedIds: () => [], validatePlan: () => ({}) }));
vi.mock("../pointer/writeLinks", () => ({ cleanGlobs: () => [], resolveElement: () => ({}), writeCodePaths: () => {} }));
vi.mock("../nested/writeChild", () => ({ writeChildLink: () => {} }));
vi.mock("./runTurn", () => ({ fetchLibraryItems: () => [], sceneIndex: () => ({}), settle: () => {} }));
vi.mock("./agents", async (orig) => ({ ...(await orig<typeof import("./agents")>()), setBridgeHandler: (h: typeof handler) => void (handler = h) }));

describe("the bridge holds the canvas for the whole call", () => {
  it("a slow read: held before it opens the canvas, let go after it returns — and also when it throws", async () => {
    const { ui } = await import("./ui");
    const { installBridge } = await import("./agentBridge");
    const log: string[] = [];
    ui.holdCanvas = (id) => (log.push(`hold ${id}`), () => void log.push(`release ${id}`));
    ui.ensureCanvas = async () => {
      log.push("ensure");
      await new Promise((r) => setTimeout(r, 30));
      log.push("ensured");
      return undefined;
    };
    installBridge();
    const out = await handler!({ rid: "1", kind: "read", canvasId: "b" });
    expect(out).toMatchObject({ error: expect.stringContaining("not in this workspace") });
    expect(log).toEqual(["hold b", "ensure", "ensured", "release b"]);
    log.length = 0;
    ui.ensureCanvas = async () => {
      throw new Error("boom");
    };
    await expect(handler!({ rid: "2", kind: "read", canvasId: "b" })).rejects.toThrow("boom");
    expect(log).toEqual(["hold b", "release b"]);
  });
  it("a request with no canvas holds nothing", async () => {
    const { ui } = await import("./ui");
    const { installBridge } = await import("./agentBridge");
    let held = 0;
    ui.holdCanvas = () => (held++, () => {});
    installBridge();
    await handler!({ rid: "3", kind: "nonsense" });
    expect(held).toBe(0);
  });
});
