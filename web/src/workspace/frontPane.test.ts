// POL1: the live camera moves the canvas the person is on — the pane they last used — not whichever canvas comes first in the DOM.
import { describe, expect, it } from "vitest";
import { nextFront, pickPane, type Slot } from "./frontPane";

const slot = (id: string, o: Partial<Slot> = {}): Slot => ({ id, hidden: false, front: false, ...o });
const kinds: Record<string, "canvas" | "session"> = { a: "canvas", b: "canvas", s: "session" };
const isCanvas = (id: string) => kinds[id] === "canvas";

describe("the pane in front", () => {
  it("follows the focus over canvases, and stays on the last canvas while a session has the focus", () => {
    let f: string | null = null;
    f = nextFront(f, "a", (id) => kinds[id]);
    expect(f).toBe("a");
    f = nextFront(f, "s", (id) => kinds[id]);
    expect(f).toBe("a");
    f = nextFront(f, "b", (id) => kinds[id]);
    expect(f).toBe("b");
  });
});

describe("the canvas pane the live camera takes", () => {
  it("the front canvas, even when another canvas comes first", () => {
    expect(pickPane([slot("a"), slot("b", { front: true })], isCanvas)).toBe("b");
  });
  it("not a front pane that is hidden behind another tab: the first canvas on screen", () => {
    expect(pickPane([slot("a"), slot("b", { front: true, hidden: true })], isCanvas)).toBe("a");
  });
  it("sessions are not canvases", () => {
    expect(pickPane([slot("s", { front: true }), slot("b")], isCanvas)).toBe("b");
  });
  it("no canvas on screen: none", () => {
    expect(pickPane([slot("s"), slot("a", { hidden: true })], isCanvas)).toBeNull();
  });
});
