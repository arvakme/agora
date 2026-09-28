// Going back up from a child canvas (docs/nested-canvas.md §2): the parent it goes to, the
// keyboard shortcut (⌘↑ on a Mac, Ctrl+↑ elsewhere) and the one-time "you are in a child canvas"
// hint. Pure (type-only imports), so it runs under vitest in node.
import type { El } from "../canvas/scene";
import type { ParentRef } from "./graph";

export const isMacPlatform = (platform = typeof navigator === "undefined" ? "" : navigator.platform) => /Mac|iPhone|iPad/i.test(platform);
/** How the shortcut is written in tooltips and hints. */
export const upKeyLabel = (mac = isMacPlatform()) => (mac ? "⌘↑" : "Ctrl+↑");

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** ⌘↑ (Mac) / Ctrl+↑ (elsewhere), nothing else held. */
export const isUpKey = (e: KeyLike, mac = isMacPlatform()) =>
  e.key === "ArrowUp" && !e.altKey && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** Excalidraw uses ⌘/Ctrl+arrow on one selected box, ellipse or diamond: it grows a flowchart from it. */
export const flowchartTakesKey = (selected: readonly El[]) =>
  selected.length === 1 && (selected[0].type === "rectangle" || selected[0].type === "ellipse" || selected[0].type === "diamond");

/** The canvas one level up from `canvasId`, or null on a top-level canvas. */
export const parentCanvas = (canvasId: string, index: ReadonlyMap<string, ParentRef>) => index.get(canvasId)?.canvasId ?? null;

/**
 * Where the up shortcut goes for a key press on `canvasId`, or null when it is not for us: not
 * the shortcut, typing in a field, Excalidraw's flowchart owns it, or already at the top.
 */
export function upOnKey(e: KeyLike & { editable?: boolean }, canvasId: string | null, index: ReadonlyMap<string, ParentRef>, selected: readonly El[], mac = isMacPlatform()): string | null {
  if (!canvasId || e.editable || !isUpKey(e, mac) || flowchartTakesKey(selected)) return null;
  return parentCanvas(canvasId, index);
}

/** A key event's target is a text field (an input, a textarea, Excalidraw's text editor, a contenteditable). */
export const isEditableTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || !!el.isContentEditable;
};

/** The one-time hint on entering a child canvas: dismissed once per browser. */
export const BACK_HINT_KEY = "agora.nested.backHint";
type Store = Pick<Storage, "getItem" | "setItem">;
const storage = (): Store | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
export function backHintSeen(s: Store | undefined = storage()): boolean {
  try {
    return s?.getItem(BACK_HINT_KEY) === "1";
  } catch {
    return false;
  }
}
const seenLs = new Set<() => void>();
/** Hear when the hint is dismissed (the button, or going up by any route). */
export const onBackHintSeen = (f: () => void) => (seenLs.add(f), () => void seenLs.delete(f));
export function markBackHintSeen(s: Store | undefined = storage()) {
  seenLs.forEach((f) => f());
  try {
    s?.setItem(BACK_HINT_KEY, "1");
  } catch {
    /* private mode: the hint may show again next time */
  }
}
