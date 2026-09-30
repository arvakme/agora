// The words and the enabled state of the buttons on a canvas change (a step in the session, a reply in a comment thread).
// One place, so every 撤销 says the same thing and a button that is off says why. Pure.

export type UndoControl = { kind: "undo" | "redo"; label: string; hint: string; disabled: boolean };
export type UndoView = { status: string | null; statusHint?: string; button: UndoControl | null };

const NOT_OPEN = "先打开这块画布，才能";

/**
 * `canRedo`: the elements the undo took off are still held (this page, since the undo). After a reload 已撤销 stays but
 * the state to put back is gone — the agent can make the change again.
 */
export function undoView({ undone, canRedo, canAct }: { undone: boolean; canRedo: boolean; canAct: boolean }): UndoView {
  if (!undone) {
    return { status: null, button: { kind: "undo", label: "撤销", hint: canAct ? "撤销这一步（把画布退回这一步之前）" : `${NOT_OPEN}撤销这一步`, disabled: !canAct } };
  }
  if (!canRedo) return { status: "已撤销", statusHint: "这一步已经撤销；重新打开页面后不能重做，需要的话让 Agent 再做一次", button: null };
  return { status: "已撤销", button: { kind: "redo", label: "重做", hint: canAct ? "重做这一步（把这一步的改动再放回画布）" : `${NOT_OPEN}重做这一步`, disabled: !canAct } };
}

export type MarkView = { label: string; hint: string; disabled: boolean; pressed: boolean };

/**
 * 标出改动: outline what the step changed on its canvas, until clicked again.
 * `live`: how many of the touched elements are still on the canvas (null: the page cannot tell yet).
 */
export function markView({ touched, live, undone, on }: { touched: readonly string[]; live: number | null; undone: boolean; on: boolean }): MarkView {
  const off = (hint: string): MarkView => ({ label: "标出改动", hint, disabled: true, pressed: false });
  if (undone) return off("这一步已撤销，画布上没有它改的东西");
  if (touched.length === 0) return off("这一步没有改画布");
  if (live === 0) return off("这一步改的元素已经不在画布上了");
  return on ? { label: "已标出", hint: "已标出 · 再点取消", disabled: false, pressed: true } : { label: "标出改动", hint: "在图上标出这一步改了什么", disabled: false, pressed: false };
}
