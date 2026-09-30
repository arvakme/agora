// FX9: one guard for every drag — while it is on: no selection, the pointer is the handle's, the page's cursor is the drag's; when it ends, for any reason, everything is as it was.
import { describe, expect, it } from "vitest";
import { createDragGuards, type GuardEnv } from "./dragGuard";

function world() {
  const style = { userSelect: "auto", webkitUserSelect: "auto", cursor: "" };
  const handlers = new Map<string, Set<(e: { pointerId?: number; key?: string; preventDefault?: () => void }) => void>>();
  let cleared = 0;
  const env: GuardEnv = {
    style,
    clearSelection: () => void cleared++,
    listen: (type, fn) => {
      const set = handlers.get(type) ?? handlers.set(type, new Set()).get(type)!;
      set.add(fn);
      return () => void set.delete(fn);
    },
  };
  const fire = (type: string, e: { pointerId?: number; key?: string } = {}) => {
    const out = { prevented: false };
    [...(handlers.get(type) ?? [])].forEach((h) => h({ ...e, preventDefault: () => void (out.prevented = true) }));
    return out;
  };
  const count = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);
  const holder = () => { const calls: string[] = []; return { calls, setPointerCapture: (id: number) => void calls.push(`cap${id}`), releasePointerCapture: (id: number) => void calls.push(`rel${id}`) }; };
  return { style, env, fire, count, holder, cleared: () => cleared, guard: createDragGuards(env) };
}
const down = (h: object, id = 1) => ({ pointerId: id, cancelable: true, preventDefault: () => {}, currentTarget: h });

describe("dragGuard", () => {
  it("on: the page selects nothing, the cursor is the drag's, the pointer is captured, the selection is cleared, the native default is refused", () => {
    const w = world(); const h = w.holder(); let prevented = false;
    w.guard({ ...down(h), preventDefault: () => void (prevented = true) }, { cursor: "col-resize" });
    expect(w.style.userSelect).toBe("none");
    expect(w.style.webkitUserSelect).toBe("none");
    expect(w.style.cursor).toBe("col-resize");
    expect(h.calls).toEqual(["cap1"]);
    expect(w.cleared()).toBe(1);
    expect(prevented).toBe(true);
    expect(w.fire("selectstart").prevented).toBe(true); // a selection cannot start meanwhile
    expect(w.fire("dragstart").prevented).toBe(true);
  });
  for (const [why, fire] of [["up", () => ["pointerup", { pointerId: 1 }]], ["cancel", () => ["pointercancel", { pointerId: 1 }]], ["lost", () => ["lostpointercapture", { pointerId: 1 }]], ["blur", () => ["blur", {}]], ["escape", () => ["keydown", { key: "Escape" }]]] as const) {
    it(`ends on ${why}: everything is put back, the listeners are gone, onEnd says why`, () => {
      const w = world(); const h = w.holder(); const ends: string[] = [];
      w.style.cursor = "text";
      w.guard(down(h), { cursor: "grabbing", onEnd: (x) => ends.push(x) });
      const [type, e] = fire() as [string, { pointerId?: number; key?: string }];
      w.fire(type, e);
      expect(w.style).toEqual({ userSelect: "auto", webkitUserSelect: "auto", cursor: "text" });
      expect(w.count()).toBe(0);
      expect(h.calls).toEqual(["cap1", "rel1"]);
      expect(ends).toEqual([why]);
      expect(w.fire("selectstart").prevented).toBe(false);
    });
  }
  it("another pointer's up does not end it; other keys do not", () => {
    const w = world(); w.guard(down(w.holder(), 1));
    w.fire("pointerup", { pointerId: 2 });
    w.fire("keydown", { key: "a" });
    expect(w.style.userSelect).toBe("none");
  });
  it("the returned function ends it (a component going away), once", () => {
    const w = world(); const ends: string[] = [];
    const end = w.guard(down(w.holder()), { onEnd: (x) => ends.push(x) });
    end(); end();
    expect(ends).toEqual(["manual"]);
    expect(w.style.userSelect).toBe("auto");
  });
  it("two at once: the page is put back when the last one ends, to what it was before the first", () => {
    const w = world(); w.style.userSelect = "text"; w.style.cursor = "pointer";
    const a = w.guard(down(w.holder(), 1), { cursor: "col-resize" });
    const b = w.guard(down(w.holder(), 2), { cursor: "grabbing" });
    a();
    expect(w.style.userSelect).toBe("none");
    b();
    expect(w.style).toEqual({ userSelect: "text", webkitUserSelect: "auto", cursor: "pointer" });
  });
  it("a pointer that is already gone does not break it (setPointerCapture throws)", () => {
    const w = world();
    w.guard({ pointerId: 1, currentTarget: { setPointerCapture: () => { throw new Error("NotFoundError"); } } });
    expect(w.style.userSelect).toBe("none");
  });
});
