// The words and the enabled state of the two buttons on a canvas change (a step of the session, a reply in a comment thread):
// 撤销 / 重做, and 标出改动. One place, so every 撤销 says the same thing.
import { describe, expect, it } from "vitest";
import { markView, undoView } from "./stepUi";

describe("undoView", () => {
  it("names the button 撤销 and says what it does to the canvas", () => {
    const v = undoView({ undone: false, canRedo: false, canAct: true });
    expect(v.status).toBeNull();
    expect(v.button).toMatchObject({ kind: "undo", label: "撤销", disabled: false });
    expect(v.button?.hint).toBe("撤销这一步（把画布退回这一步之前）");
  });

  it("is off, with the reason, when the canvas is not open to act on", () => {
    const v = undoView({ undone: false, canRedo: false, canAct: false });
    expect(v.button).toMatchObject({ kind: "undo", disabled: true });
    expect(v.button?.hint).toBe("先打开这块画布，才能撤销这一步");
  });

  it("after an undo says 已撤销 and offers 重做 while the undone state can still be put back", () => {
    const v = undoView({ undone: true, canRedo: true, canAct: true });
    expect(v.status).toBe("已撤销");
    expect(v.button).toMatchObject({ kind: "redo", label: "重做", disabled: false });
    expect(v.button?.hint).toBe("重做这一步（把这一步的改动再放回画布）");
  });

  it("after a reload there is nothing to put back: 已撤销 alone, with why", () => {
    const v = undoView({ undone: true, canRedo: false, canAct: true });
    expect(v.status).toBe("已撤销");
    expect(v.button).toBeNull();
    expect(v.statusHint).toContain("让 Agent 再做一次");
  });

  it("重做 is off when the canvas is not open", () => {
    expect(undoView({ undone: true, canRedo: true, canAct: false }).button).toMatchObject({ kind: "redo", disabled: true });
  });
});

describe("markView", () => {
  const base = { touched: ["a", "b"], live: 2, undone: false, on: false };

  it("says in words what it does, not just that it is a button", () => {
    const v = markView(base);
    expect(v).toMatchObject({ label: "标出改动", disabled: false, pressed: false });
    expect(v.hint).toBe("在图上标出这一步改了什么");
  });

  it("once on: 已标出, and the way back", () => {
    const v = markView({ ...base, on: true });
    expect(v).toMatchObject({ label: "已标出", pressed: true });
    expect(v.hint).toBe("已标出 · 再点取消");
  });

  it("a step that did not touch the canvas is off and says so", () => {
    const v = markView({ ...base, touched: [], live: 0 });
    expect(v.disabled).toBe(true);
    expect(v.hint).toBe("这一步没有改画布");
  });

  it("everything it touched is gone from the canvas: off, with that reason", () => {
    const v = markView({ ...base, live: 0 });
    expect(v.disabled).toBe(true);
    expect(v.hint).toBe("这一步改的元素已经不在画布上了");
  });

  it("an undone step has nothing to mark", () => {
    const v = markView({ ...base, undone: true });
    expect(v.disabled).toBe(true);
    expect(v.hint).toBe("这一步已撤销，画布上没有它改的东西");
  });

  it("the canvas can be asked while the page does not know yet (live unknown): not off", () => {
    expect(markView({ ...base, live: null }).disabled).toBe(false);
  });
});
