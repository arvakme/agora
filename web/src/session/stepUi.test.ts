// The label and the enabled state of the two buttons on a canvas change (a step of the session, a reply in a comment thread):
// 撤销 / 重做, and 标出改动. One place, so every 撤销 says the same thing; a button that is off says why, and each reason is its own sentence.
import { describe, expect, it } from "vitest";
import { markView, undoView } from "./stepUi";

describe("undoView", () => {
  it("names the button 撤销 and is on when the canvas is open", () => {
    const v = undoView({ undone: false, canRedo: false, canAct: true });
    expect(v.status).toBeNull();
    expect(v.button).toMatchObject({ kind: "undo", label: "撤销", disabled: false });
    expect(v.button?.hint).toBeTruthy();
  });

  it("is off, with a reason of its own, when the canvas is not open to act on", () => {
    const on = undoView({ undone: false, canRedo: false, canAct: true }).button!;
    const off = undoView({ undone: false, canRedo: false, canAct: false }).button!;
    expect(off).toMatchObject({ kind: "undo", disabled: true });
    expect(off.hint).toBeTruthy();
    expect(off.hint).not.toBe(on.hint);
  });

  it("after an undo says 已撤销 and offers 重做 while the undone state can still be put back", () => {
    const v = undoView({ undone: true, canRedo: true, canAct: true });
    expect(v.status).toBe("已撤销");
    expect(v.button).toMatchObject({ kind: "redo", label: "重做", disabled: false });
  });

  it("after a reload there is nothing to put back: 已撤销 alone, with the reason", () => {
    const v = undoView({ undone: true, canRedo: false, canAct: true });
    expect(v.status).toBe("已撤销");
    expect(v.button).toBeNull();
    expect(v.statusHint).toBeTruthy();
  });

  it("重做 is off when the canvas is not open", () => {
    expect(undoView({ undone: true, canRedo: true, canAct: false }).button).toMatchObject({ kind: "redo", disabled: true });
  });
});

describe("markView", () => {
  const base = { touched: ["a", "b"], live: 2, undone: false, on: false };

  it("is on, and says in words what it does", () => {
    const v = markView(base);
    expect(v).toMatchObject({ label: "标出改动", disabled: false, pressed: false });
    expect(v.hint).toBeTruthy();
  });

  it("once on: 已标出, pressed, and still clickable to take it off", () => {
    expect(markView({ ...base, on: true })).toMatchObject({ label: "已标出", pressed: true, disabled: false });
  });

  it("is off, each for its own reason: nothing touched, everything gone from the canvas, undone", () => {
    const hints = [markView({ ...base, touched: [], live: 0 }), markView({ ...base, live: 0 }), markView({ ...base, undone: true })].map((v) => {
      expect(v.disabled).toBe(true);
      expect(v.pressed).toBe(false);
      return v.hint;
    });
    expect(new Set([...hints, markView(base).hint]).size).toBe(4);
  });

  it("the canvas can be asked while the page does not know yet (live unknown): not off", () => {
    expect(markView({ ...base, live: null }).disabled).toBe(false);
  });
});
