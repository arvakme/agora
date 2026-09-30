// The floating shell the session panel and the comment list share (web/docs/workstation.md §15 悬浮会话面板): where it sits over the canvas, how
// big it is, how a drag / resize / key press keeps it inside the window, when a small window puts the panel back into the layout, and which
// shell is open (one at a time). Pure: the components measure the pane and ask here. The place is the distance from the pane's top-right
// corner, so a window that changes size keeps the shell at the same corner.
import type { Node } from "../workspace/layout";

export type Place = { right: number; top: number };
/** What a browser remembers about a shell: where it is, how wide, whether it is folded to its capsule. */
export type Shell = { place: Place; width: number; folded: boolean };
export type Box = { x: number; y: number; w: number; h: number };
type Size = { w: number; h: number };
type Store = Pick<Storage, "getItem" | "setItem">;

export const MARGIN = 12;
/** Below the canvas's own top row (toolbar, library button) and the line under it that says who the camera follows. */
export const TOP_CLEAR = 92;
/** Above the canvas's bottom row (zoom, the browse / comment dock, help, the compact layout's bottom bar): what the comment list keeps clear. The session panel goes down to MARGIN. */
export const BOTTOM_CLEAR = 80;
export const MIN_W = 360;
export const MAX_W = 520;
export const DEFAULT_W = 420;
/** The shortest a shell is drawn (a window too short for it lets it shrink to what is left). */
export const MIN_H = 160;
/** A window narrower than this docks the session panel whatever the preference (the existing layout breakpoints are 960 / 640: this one is where a 360 px shell no longer leaves the canvas a useful part of the window). */
export const FLOAT_MIN_W = 1100;
export const STEP = 24;
export const DEFAULT_SHELL: Shell = { place: { right: MARGIN, top: TOP_CLEAR }, width: DEFAULT_W, folded: false };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.max(lo, v)));
const widthIn = (width: number, pane: Size) => Math.min(clamp(width, MIN_W, MAX_W), Math.max(0, pane.w - 2 * MARGIN));

/** A place inside the pane, MARGIN from every edge, for a shell `h` tall at least (a drag that went too far, a saved place in a window that has since shrunk). */
function placeIn(place: Place, w: number, pane: Size, h = MIN_H, bottom = MARGIN): Place {
  return {
    right: clamp(place.right, MARGIN, pane.w - w - MARGIN),
    top: clamp(place.top, MARGIN, pane.h - bottom - Math.min(h, Math.max(0, pane.h - MARGIN - bottom))),
  };
}

/** The shell's rectangle in the pane: `width` wide (360–520, narrower when the pane is), as tall as its content (`content`, else the room it has) and no taller than the pane less 2 × MARGIN (`bottom`: the room kept at the bottom instead of MARGIN). */
export function shellBox(shell: Shell, pane: Size, opts: { content?: number; bottom?: number } = {}): Box {
  const w = widthIn(shell.width, pane);
  const bottom = opts.bottom ?? MARGIN;
  const p = placeIn(shell.place, w, pane, MIN_H, bottom);
  const room = Math.max(0, pane.h - p.top - bottom);
  const h = Math.min(room, clamp(opts.content ?? room, MIN_H, room));
  return { x: pane.w - p.right - w, y: p.top, w, h };
}

/** A drag by (dx, dy) px: the shell follows the pointer (`right` shrinks as it moves right) and stays in the window. `h` is its height now, so its bottom stays inside too. */
export function dragTo(shell: Shell, dx: number, dy: number, pane: Size, h?: number): Shell {
  const w = widthIn(shell.width, pane);
  return { ...shell, place: placeIn({ right: shell.place.right - dx, top: shell.place.top + dy }, w, pane, h) };
}

/** The left edge dragged so the shell is `by` px wider (negative: narrower): 360–520, the right edge stays put. */
export function resizeTo(shell: Shell, by: number, pane: Size): Shell {
  const width = widthIn(shell.width + by, pane);
  return { ...shell, width, place: placeIn(shell.place, width, pane) };
}

/** Alt+arrows move the shell by STEP, Alt+Shift+←/→ make it wider / narrower; any other key is not the shell's (null). */
export function keyMove(shell: Shell, key: string, mods: { alt: boolean; shift: boolean }, pane: Size, h?: number): Shell | null {
  if (!mods.alt) return null;
  if (mods.shift) return key === "ArrowLeft" ? resizeTo(shell, STEP, pane) : key === "ArrowRight" ? resizeTo(shell, -STEP, pane) : null;
  if (key === "ArrowLeft") return dragTo(shell, -STEP, 0, pane, h);
  if (key === "ArrowRight") return dragTo(shell, STEP, 0, pane, h);
  if (key === "ArrowUp") return dragTo(shell, 0, -STEP, pane, h);
  if (key === "ArrowDown") return dragTo(shell, 0, STEP, pane, h);
  return null;
}

/**
 * Whether the session panel floats now: the viewer chose it, the window is wide enough (FLOAT_MIN_W) and there is a canvas column to float over.
 * A pure function of those three, so a window that shrinks docks the panel and one that grows floats it again for whoever chose it, with nothing kept
 * in between: the panel itself is the same component either way (its draft, scroll and replay stay).
 */
export const floatWanted = (a: { pref: boolean; windowW: number; canvasColumn: boolean }) => a.pref && a.canvasColumn && a.windowW >= FLOAT_MIN_W;

/** The layout without one group, the rest taking its room (null when nothing else is left): what the canvas column is laid out in while a group floats. */
export function withoutGroup(root: Node, id: string): Node | null {
  if (root.kind === "group") return root.id === id ? null : root;
  const kept = root.children.map((c, i) => ({ child: withoutGroup(c, id), size: root.sizes[i] }));
  if (kept.every((k, i) => k.child === root.children[i])) return root;
  const rest = kept.filter((k): k is { child: Node; size: number } => k.child !== null);
  if (!rest.length) return null;
  if (rest.length === 1) return rest[0].child;
  const total = rest.reduce((a, k) => a + k.size, 0);
  return { ...root, children: rest.map((k) => k.child), sizes: rest.map((k) => k.size / total) };
}

/** Which floating shell is open ("session" / "comments"): expanding one folds the other to its capsule. */
export type ShellName = "session" | "comments";
let open: ShellName | null = null;
/** How far from the pane's right edge each shell's visible part (its panel, or its capsule) reaches: a capsule sits beside what the other shell covers. */
const reaches: Partial<Record<ShellName, number>> = {};
const ls = new Set<() => void>();
export const floatFocus = {
  get: () => open,
  set(v: ShellName | null) {
    if (v === open) return;
    open = v;
    ls.forEach((l) => l());
  },
  reach: (name: ShellName) => reaches[name],
  setReach(name: ShellName, px: number | null) {
    if (px === null ? reaches[name] === undefined : reaches[name] === px) return;
    if (px === null) delete reaches[name];
    else reaches[name] = px;
    ls.forEach((l) => l());
  },
  subscribe(l: () => void) {
    ls.add(l);
    return () => void ls.delete(l);
  },
};

/** Where a folded shell's capsule sits from the right edge: its own place, or beside whatever the other shell covers there (`others`: their reaches) when that would cover it. */
export const capsuleRight = (place: Place, others: (number | undefined)[]) => Math.max(place.right, ...others.map((o) => (o === undefined ? 0 : o + 8)));

const INTERACTIVE = "button, input, textarea, select, a, [contenteditable], .wm-tab, .wm-add, [data-nodrag]";
/**
 * Whether a press may start a drag of the shell: the empty part of its head does, its buttons, fields and tabs do not.
 * The drag itself is held by app/dragGuard.ts (selection, capture, Esc).
 */
export function mayDrag(e: { target: unknown; currentTarget?: unknown }): boolean {
  const t = e.target as { closest?: (s: string) => unknown } | null;
  return !t?.closest?.(INTERACTIVE);
}

const keyOf = (name: ShellName) => `agora.float.${name}`;
/** The comment list floated before the shell was shared: its place and folded state carry over (its width is the shell's now). */
const OLD_COMMENTS = "agora.commentsPanel";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Per browser (each viewer's own): the page works without it, so nothing here can fail loudly. */
export function loadShell(name: ShellName, store: Store = localStorage): Shell {
  try {
    const read = (k: string) => JSON.parse(store.getItem(k) ?? "null") as { place?: { right?: unknown; top?: unknown }; width?: unknown; folded?: unknown } | null;
    const v = read(keyOf(name)) ?? (name === "comments" ? read(OLD_COMMENTS) : null);
    const right = num(v?.place?.right);
    const top = num(v?.place?.top);
    if (right == null || top == null) return DEFAULT_SHELL;
    return { place: { right, top }, width: clamp(num(v?.width) ?? DEFAULT_W, MIN_W, MAX_W), folded: v?.folded === true };
  } catch {
    return DEFAULT_SHELL;
  }
}

export function saveShell(name: ShellName, shell: Shell, store: Store = localStorage): void {
  try {
    store.setItem(keyOf(name), JSON.stringify(shell));
  } catch {
    /* private window: this page only */
  }
}
