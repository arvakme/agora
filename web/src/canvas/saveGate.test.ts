import { describe, expect, it } from "vitest";
import { createProjectHarness } from "../project/emptyGuard.harness";
import { createSaveGate } from "./saveGate";
import type { El } from "./scene";

const el = (id: string, isDeleted = false) => ({ id, type: "rectangle", isDeleted }) as unknown as El;

describe("save gate", () => {
  it("saves nothing for a canvas this mount has not loaded (an empty scene before the load)", () => {
    const g = createSaveGate();
    expect(g.payload("c1", [])).toBeNull();
    g.arm("c1", [el("a")]);
    expect(g.payload("c1", [el("a")])).toEqual({ elements: [el("a")], clear: false });
    g.disarm("c1");
    expect(g.payload("c1", [])).toBeNull();
  });

  it("marks an empty scene as cleared only when the canvas had elements on this mount", () => {
    const g = createSaveGate();
    g.arm("c1", [el("a")]);
    expect(g.payload("c1", [el("a", true)])).toEqual({ elements: [], clear: true }); // the user deleted everything
    expect(g.payload("c1", [])).toEqual({ elements: [], clear: false }); // still empty: nothing was cleared now
    g.arm("c2", []); // loaded empty
    expect(g.payload("c2", [])).toEqual({ elements: [], clear: false });
  });
});

describe("saving against the server", () => {
  it("carries the version this mount loaded; a stale one is a conflict and never overwrites", async () => {
    const h = createProjectHarness({ c1: 3 });
    await h.mountAndLoad("c1"); // GET: version v1
    h.serverChangedElsewhere("c1", 5); // someone else saved: v2
    h.gateSave("c1", 4); // this page saves 4 elements on top of v1
    await h.idle();
    expect(h.calls.at(-1)!.body.base).toBe("v1");
    expect(h.client.status().conflicts).toEqual(["canvas:c1"]);
    expect(h.count("c1")).toBe(5);
  });

  it("an empty scene over a non-empty file is refused without the mark, taken with it, and the page reloads on refusal", async () => {
    const h = createProjectHarness({ c1: 3 });
    await h.mountAndLoad("c1");
    h.saveRaw("c1", { elements: [], clear: false });
    await h.idle();
    expect(h.count("c1")).toBe(3);
    expect(h.refusedFor).toEqual(["canvas:c1"]);
    expect(h.client.status().conflicts).toEqual([]);
    h.saveRaw("c1", { elements: [], clear: true });
    await h.idle();
    expect(h.count("c1")).toBe(0);
  });
});
