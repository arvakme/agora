// PR 回放's camera (web/docs/workstation.md「PR 回放」): which canvas the main view shows at a moment of
// the replay — the parent while the figure walks in it, a sub-diagram from the moment the figure has gone
// in at a node's door (it is behind it) until it comes out, the whole diagram again for the summary.
// Pure: `cameraCanvas(root, stateOf)`; `stateOf(canvas)` says whether the figure is behind a door on that
// canvas and into which canvas the door leads.
import { describe, expect, it } from "vitest";
import { cameraCanvas, cameraPath, type DoorState } from "./replayCamera.ts";

const doors = (m: Record<string, DoorState>) => (c: string): DoorState => m[c] ?? { behind: false, into: null };

describe("which canvas the view shows", () => {
  it("the diagram itself while the figure walks on it, stands at a node, or is not there yet", () => {
    expect(cameraCanvas("root", doors({}))).toBe("root");
  });
  it("a sub-diagram once the figure is behind the door of the node that opens it", () => {
    expect(cameraCanvas("root", doors({ root: { behind: true, into: "api" } }))).toBe("api");
  });
  it("and deeper: behind a door in that sub-diagram too", () => {
    const s = doors({ root: { behind: true, into: "api" }, api: { behind: true, into: "users" } });
    expect(cameraCanvas("root", s)).toBe("users");
    expect(cameraPath("root", s)).toEqual(["root", "api", "users"]);
  });
  it("back on the parent once it comes out (the parent no longer says behind)", () => {
    expect(cameraCanvas("root", doors({ root: { behind: false, into: "api" }, api: { behind: true, into: "users" } }))).toBe("root");
  });
  it("in the sub-diagram it is standing on a node of (not behind a door there): that sub-diagram", () => {
    expect(cameraCanvas("root", doors({ root: { behind: true, into: "api" }, api: { behind: false, into: null } }))).toBe("api");
  });
  it("stays where it is when a door leads nowhere known", () => {
    expect(cameraCanvas("root", doors({ root: { behind: true, into: null } }))).toBe("root");
  });
  it("never goes round in a loop of doors", () => {
    const s = doors({ a: { behind: true, into: "b" }, b: { behind: true, into: "a" } });
    expect(cameraPath("a", s)).toEqual(["a", "b"]);
  });
  it("the summary is on the whole diagram, whatever door the figure is behind", () => {
    const s = doors({ root: { behind: true, into: "api" } });
    expect(cameraCanvas("root", s, { summary: true })).toBe("root");
  });
});
