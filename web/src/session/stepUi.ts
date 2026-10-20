import { tr } from "../i18n";
// The words and the enabled state of the buttons on a canvas change (a step in the session, a reply in a comment thread).
// One place, so every 撤销 says the same thing and a button that is off says why. Pure.

export type UndoControl = { kind: "undo" | "redo"; label: string; hint: string; disabled: boolean };
export type UndoView = { status: string | null; statusHint?: string; button: UndoControl | null };

const NOT_OPEN = (zh: string, en: string) => tr(`先打开这块画布，才能${zh}`, `Open this canvas first to ${en}`);

/**
 * `canRedo`: the elements the undo took off are still held (this page, since the undo). After a reload 已撤销 stays but
 * the state to put back is gone — the agent can make the change again.
 */
export function undoView({ undone, canRedo, canAct }: { undone: boolean; canRedo: boolean; canAct: boolean }): UndoView {
  if (!undone) {
    return { status: null, button: { kind: "undo", label: tr("撤销", "Undo"), hint: canAct ? tr("撤销这一步（把画布退回这一步之前）", "Undo this step (put the canvas back as it was before it)") : NOT_OPEN("撤销这一步", "undo this step"), disabled: !canAct } };
  }
  if (!canRedo) return { status: tr("已撤销", "Undone"), statusHint: tr("这一步已经撤销；重新打开页面后不能重做，需要的话让 Agent 再做一次", "This step was undone; it can't be redone after the page reloads — ask the agent to do it again if you need it"), button: null };
  return { status: tr("已撤销", "Undone"), button: { kind: "redo", label: tr("重做", "Redo"), hint: canAct ? tr("重做这一步（把这一步的改动再放回画布）", "Redo this step (put its changes back on the canvas)") : NOT_OPEN("重做这一步", "redo this step"), disabled: !canAct } };
}

export type MarkView = { label: string; hint: string; disabled: boolean; pressed: boolean };

/**
 * 标出改动: outline what the step changed on its canvas, until clicked again.
 * `live`: how many of the touched elements are still on the canvas (null: the page cannot tell yet).
 */
export function markView({ touched, live, undone, on }: { touched: readonly string[]; live: number | null; undone: boolean; on: boolean }): MarkView {
  const off = (hint: string): MarkView => ({ label: tr("标出改动", "Highlight changes"), hint, disabled: true, pressed: false });
  if (undone) return off(tr("这一步已撤销，画布上没有它改的东西", "This step was undone; nothing it changed is on the canvas"));
  if (touched.length === 0) return off(tr("这一步没有改画布", "This step didn't change the canvas"));
  if (live === 0) return off(tr("这一步改的元素已经不在画布上了", "The elements this step changed are no longer on the canvas"));
  return on ? { label: tr("已标出", "Highlighted"), hint: tr("已标出 · 再点取消", "Highlighted · click again to clear"), disabled: false, pressed: true } : { label: tr("标出改动", "Highlight changes"), hint: tr("在图上标出这一步改了什么", "Highlight on the diagram what this step changed"), disabled: false, pressed: false };
}
