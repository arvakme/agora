// Going into a sub-diagram is asked for explicitly (docs/nested-canvas.md §2): the small mark on the node's bottom-right, the
// breadcrumb, a `?canvas=` link, the entrance capsule (workstation/EntryMarks.tsx) — and, from the keyboard, Shift+Enter on the
// selected node. A double-click is Excalidraw's own (edit a node's text, add text on empty canvas). Pure (type-only imports).
import type { El } from "../canvas/scene";

/** How the shortcut is written in tooltips and the help. */
export const ENTER_KEY_LABEL = "⇧↵";

/** The mark's click target, px (a square at least: the count and the stale dot widen it). */
export const MARK_SIZE = 26;

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** Shift+Enter, nothing else held. */
export const isEnterKey = (e: KeyLike) => e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;

/**
 * Where the shortcut goes for a key press: the sub-diagram of the selected node (`node`), or null when it is not for us — not
 * the shortcut, typing in a field (Shift+Enter is a new line there), no node selected, or it has no sub-diagram (that exists).
 */
export function enterOnKey(e: KeyLike & { editable?: boolean }, node: El | undefined, childOf: (e: El) => string | null, exists: (child: string) => boolean): string | null {
  if (e.editable || !isEnterKey(e) || !node) return null;
  const child = childOf(node);
  return child && exists(child) ? child : null;
}
