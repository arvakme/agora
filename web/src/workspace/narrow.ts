// On a phone the window manager shows one pane: the layout tree is drawn as a single group of all its tabs and the saved
// layout is left alone, so the desktop arrangement is back as soon as the screen is wide again.
import { useSyncExternalStore } from "react";
import { groups, type Group, type Node, type Split } from "./layout.ts";

/** Same breakpoint as the top bar's icon-only buttons (app/styles.css). */
export const NARROW_QUERY = "(max-width: 640px)";
const NARROW_GROUP = "narrow";
/** While a turn plays, the canvas it plays on takes this share of the height and the session (its current step) the rest. */
const STACK_TOP = 0.6;
/** A stacked canvas and session each keep at least this much height: under it Excalidraw's two bars overlap on the canvas, and the session's composer on its messages. */
export const NARROW_MIN_PANE = 180;
/** The two tabs shown at once on a phone, the canvas above and the session below: while a turn plays, and with the bottom-bar form of the session panel. `bottomPx`: the session's strip height when it is folded; else `bottomShare` of the height, the usual share when absent. */
export type Stack = { top: string; bottom: string; bottomPx?: number; bottomShare?: number };

/** Every tab of `root`, in screen order, as one group showing `focused` (the first tab when `focused` is not in the layout). */
export function collapse(root: Node, focused: string): Group {
  const tabs = groups(root).flatMap((g) => g.tabs);
  return { kind: "group", id: NARROW_GROUP, tabs, active: tabs.includes(focused) ? focused : tabs[0] };
}

/** What a phone draws: one pane of every tab, or with a `stack` whose tabs are both open the canvas over the session, in stable ids so nothing remounts when the play starts or ends. */
export function narrowRoot(root: Node, focused: string, stack: Stack | null, height = 0): Node {
  const open = groups(root).flatMap((g) => g.tabs);
  if (!stack || !open.includes(stack.top) || !open.includes(stack.bottom)) return collapse(root, focused);
  const wanted = stack.bottomPx && height > 0 ? Math.min(stack.bottomPx / height, 1 - STACK_TOP) : (stack.bottomShare ?? 1 - STACK_TOP);
  // a share dragged on a taller screen (or before the keyboard came up) must not leave either pane under its minimum on this one; the folded strip is its own height
  const min = height > 0 ? NARROW_MIN_PANE / height : 0;
  const bottom = stack.bottomPx || min >= 0.5 ? wanted : Math.min(Math.max(wanted, min), 1 - min);
  const part = (id: string, tab: string): Group => ({ kind: "group", id, tabs: [tab], active: tab });
  const col: Split = { kind: "split", id: "narrow-stack", dir: "col", sizes: [1 - bottom, bottom], children: [part("narrow-top", stack.top), part("narrow-bottom", stack.bottom)] };
  return col;
}

/** The strip's height: the session's tab bar and its composer. */
const SHEET_FOLDED_PX = 150;
/** Pulled up, it takes this share of the height. */
const SHEET_PULLED_SHARE = 0.55;

/**
 * The pair a phone shows with the session panel as a bottom bar: the canvas in focus (else the last one used, else the first open) over the session in focus (else the one of that
 * canvas, else the first open); null when a canvas or a session is not open. `open` is the ids in the layout, `canvasOf` a session tab's canvas, `share` where the person dragged the divider to when pulled up.
 */
export function sheetPair(open: ReadonlySet<string>, focused: string, lastCanvas: string, kindOf: (id: string) => string | undefined, canvasOf: (id: string) => string | undefined, pulledUp: boolean, share?: number | null): Stack | null {
  const ids = [...open];
  const canvases = ids.filter((id) => kindOf(id) === "canvas");
  const sessions = ids.filter((id) => kindOf(id) === "session");
  const top = kindOf(focused) === "canvas" && open.has(focused) ? focused : open.has(lastCanvas) && kindOf(lastCanvas) === "canvas" ? lastCanvas : canvases[0];
  const bottom = kindOf(focused) === "session" && open.has(focused) ? focused : (sessions.find((id) => canvasOf(id) === top) ?? sessions[0]);
  return top && bottom ? { top, bottom, ...(pulledUp ? { bottomShare: share ?? SHEET_PULLED_SHARE } : { bottomPx: SHEET_FOLDED_PX }) } : null;
}

const subscribe = (notify: () => void) => {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
};
export const useNarrow = () => useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_QUERY).matches, () => false);
