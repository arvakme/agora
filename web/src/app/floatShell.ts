// The floating shell of the session panel and the comment list (web/docs/workstation.md §15 悬浮会话面板): a card at the right of the canvas that the person sizes with eight
// handles and moves by its title bar, a bottom bar (and its pill) for the session, the rail tab a folded shell leaves at the window's right edge, which shell is open, and when a
// small window docks the panel. Pure: the components measure the pane and ask here. The card's place is the distance from the pane's top-right corner, so a window that changes
// size keeps it at the same corner; its size is what the person pulled (never what the content wants) and is clamped to the window when it is drawn, not when it is kept.
import { PILL_GAP } from "../canvas/dockPlace";
import type { Node } from "../workspace/layout";

export type Place = { right: number; top: number };
/** A card: where, how big (`height: null` = the default share of the canvas), folded to its rail tab. */
export type Shell = { place: Place; width: number; height: number | null; folded: boolean };
export type Box = { x: number; y: number; w: number; h: number };
type Size = { w: number; h: number };
type Store = Pick<Storage, "getItem" | "setItem">;
export type ShellName = "session" | "comments";
/** The session panel's form: the docked right column, a card floating at the right, or a bar along the bottom. */
export type FloatPref = "dock" | "card" | "bar";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export const MARGIN = 12;
/** Below the canvas's own top row (toolbar, library button) and the line under it that says who the camera follows. */
export const TOP_CLEAR = 92;
export const W_MIN = 320;
export const W_MAX = 800;
export const W_DEFAULT = 420;
export const H_MIN = 240;
/** The window less this is the tallest a card or a half screen gets. */
export const H_EDGE = 24;
/** The card's default height as a share of the canvas: the session's, and the comment list's (a list needs less). */
const H_RATIO: Record<ShellName, number> = { session: 0.72, comments: 0.56 };
/** Within this of the margin, letting go snaps a dragged card to the window's left or right edge. */
export const SNAP = 16;
/** Double-click the title bar: narrow, default, wide. */
export const WIDTH_CYCLE = [340, 420, 640] as const;
/** A window narrower than this or lower than that docks the panel whatever the choice. */
export const FLOAT_MIN_W = 1100;
export const FLOAT_MIN_H = 640;
export const STEP = 24;
/** The hit area of a resize handle, straddling the card's edge: it counts as part of the card for what keeps clear of it. */
export const HANDLE = 8;
/** A card dragged so the pointer ends this close to the window's right edge goes back to the docked column. */
export const DOCK_EDGE = 6;
export const DEFAULT_SHELL: Shell = { place: { right: MARGIN, top: TOP_CLEAR }, width: W_DEFAULT, height: null, folded: false };

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wRange = (pane: Size) => {
  const max = Math.min(W_MAX, pane.w - 2 * MARGIN);
  return { min: Math.min(W_MIN, max), max };
};
const hRange = (pane: Size) => {
  const max = pane.h - H_EDGE;
  return { min: Math.min(H_MIN, max), max };
};
const defaultHeight = (kind: ShellName, pane: Size) => Math.round(H_RATIO[kind] * pane.h);

/** The card's rectangle in the pane: its width and height as the person set them (320–800, 240 to the window less 24), kept inside the window, MARGIN from every edge. */
export function shellBox(shell: Shell, pane: Size, kind: ShellName = "session"): Box {
  const wr = wRange(pane);
  const hr = hRange(pane);
  const w = clampTo(shell.width, wr.min, wr.max);
  const h = clampTo(shell.height ?? defaultHeight(kind, pane), hr.min, hr.max);
  const right = clampTo(shell.place.right, MARGIN, pane.w - w - MARGIN);
  const top = clampTo(shell.place.top, MARGIN, pane.h - h - MARGIN);
  return { x: pane.w - right - w, y: top, w, h };
}

const fromBox = (shell: Shell, l: number, t: number, r: number, b: number, pane: Size): Shell => ({ ...shell, place: { right: pane.w - r, top: t }, width: r - l, height: b - t });

/**
 * A handle dragged by (dx, dy) — the total since the drag began, so the result depends on the shell it started from and a drag that comes back is back where it was.
 * The edges the handle does not hold stay exactly where they were; the size stays in 320–800 × 240–(window − 24) and the card inside the window.
 */
export function resizeBy(shell: Shell, handle: Handle, dx: number, dy: number, pane: Size, kind: ShellName = "session"): Shell {
  const b = shellBox(shell, pane, kind);
  const wr = wRange(pane);
  const hr = hRange(pane);
  let l = b.x, r = b.x + b.w, t = b.y, bo = b.y + b.h;
  if (handle.includes("w")) l = clampTo(l + dx, Math.max(MARGIN, r - wr.max), r - wr.min);
  if (handle.includes("e")) r = clampTo(r + dx, l + wr.min, Math.min(pane.w - MARGIN, l + wr.max));
  if (handle.includes("n")) t = clampTo(t + dy, Math.max(MARGIN, bo - hr.max), bo - hr.min);
  if (handle.includes("s")) bo = clampTo(bo + dy, t + hr.min, Math.min(pane.h - MARGIN, t + hr.max));
  return fromBox(shell, l, t, r, bo, pane);
}

/** The card moved by the pointer's (dx, dy) since the drag began, inside the window; `snap` says which window edge it is within SNAP of (letting go there snaps it, `applySnap`). */
export function dragBy(shell: Shell, dx: number, dy: number, pane: Size, kind: ShellName = "session"): { shell: Shell; snap: "left" | "right" | null } {
  const b = shellBox(shell, pane, kind);
  const right = clampTo(pane.w - (b.x + b.w) - dx, MARGIN, pane.w - b.w - MARGIN);
  const top = clampTo(b.y + dy, MARGIN, pane.h - b.h - MARGIN);
  const next: Shell = { ...shell, place: { right, top }, width: b.w, height: b.h };
  const left = pane.w - right - b.w;
  return { shell: next, snap: right < MARGIN + SNAP ? "right" : left < MARGIN + SNAP ? "left" : null };
}

/** Letting go of a drag near a window edge: the card sits at that edge's margin. */
export function applySnap(shell: Shell, snap: "left" | "right" | null, pane: Size, kind: ShellName = "session"): Shell {
  if (!snap) return shell;
  const b = shellBox(shell, pane, kind);
  return { ...shell, place: { right: snap === "right" ? MARGIN : pane.w - MARGIN - b.w, top: b.y } };
}

/** The pointer let go at the window's right edge: the docked column again. */
export const shouldDock = (pointerX: number, windowW: number) => pointerX >= windowW - DOCK_EDGE;

/** Double-click on the title bar: the next of narrow / default / wide, the right edge where it was. */
export function cycleWidth(shell: Shell, pane: Size, kind: ShellName = "session"): Shell {
  const b = shellBox(shell, pane, kind);
  const next = WIDTH_CYCLE.find((w) => w > b.w + 0.5) ?? WIDTH_CYCLE[0];
  return { ...shell, place: { right: pane.w - (b.x + b.w), top: b.y }, width: next, height: b.h };
}

/** Alt+arrows move the card by STEP, Alt+Shift+arrows resize it (← wider, → narrower, ↑ taller, ↓ shorter); any other key is not the card's (null). */
export function keyMove(shell: Shell, key: string, mods: { alt: boolean; shift: boolean }, pane: Size, kind: ShellName = "session"): Shell | null {
  if (!mods.alt) return null;
  if (mods.shift) {
    if (key === "ArrowLeft") return resizeBy(shell, "w", -STEP, 0, pane, kind);
    if (key === "ArrowRight") return resizeBy(shell, "w", STEP, 0, pane, kind);
    if (key === "ArrowUp") return resizeBy(shell, "n", 0, -STEP, pane, kind);
    if (key === "ArrowDown") return resizeBy(shell, "n", 0, STEP, pane, kind);
    return null;
  }
  const d = key === "ArrowLeft" ? [-STEP, 0] : key === "ArrowRight" ? [STEP, 0] : key === "ArrowUp" ? [0, -STEP] : key === "ArrowDown" ? [0, STEP] : null;
  return d ? dragBy(shell, d[0], d[1], pane, kind).shell : null;
}

/**
 * The form the session panel has now: what the person chose (`pref`), unless the window is narrower than FLOAT_MIN_W or lower than FLOAT_MIN_H, or there is no canvas column
 * to float over. A pure function of those, so a window that shrinks docks the panel and one that grows gives the chosen form back, with nothing kept in between: the panel
 * itself is the same component in every form (its draft, scroll and replay stay).
 */
export function floatMode(a: { pref: FloatPref; windowW: number; windowH: number; canvasColumn: boolean }): FloatPref {
  return a.pref !== "dock" && a.canvasColumn && a.windowW >= FLOAT_MIN_W && a.windowH >= FLOAT_MIN_H ? a.pref : "dock";
}

/** What a browser kept as the choice: the first floating version kept a boolean (true = the card); anything else is docked. */
export function normalizeFloatPref(v: unknown): FloatPref {
  return v === true || v === "card" ? "card" : v === "bar" ? "bar" : "dock";
}

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

// ── the bottom bar ──
/** The session as a bar over the 「浏览 / 评论」 bar: a strip, or pulled up to a half screen; `folded` = the pill beside that bar. */
export type Bar = { width: number; height: number | null; expanded: boolean; folded: boolean };
export const BAR_W_MIN = 480;
export const BAR_W_MAX = 1000;
export const BAR_W_DEFAULT = 780;
export const BAR_H = 58;
/** Between the bar and the 「浏览 / 评论」 bar. */
export const BAR_GAP = 8;
const BAR_EXPANDED_RATIO = 0.45;
/** The half screen's title row (avatar, status, the two buttons). */
export const CHROME_H = 48;
/** The strip's parts: avatar and status on the left, the buttons on the right, the composer in between. */
export const BAR_LEFT = 232;
export const BAR_RIGHT = 88;
const BAR_COMPOSER_H = 42;
export const DEFAULT_BAR: Bar = { width: BAR_W_DEFAULT, height: null, expanded: false, folded: false };

const barWidth = (bar: Bar, pane: Size) => {
  const max = Math.min(BAR_W_MAX, pane.w - 2 * MARGIN);
  return clampTo(bar.width, Math.min(BAR_W_MIN, max), max);
};
const barHeight = (bar: Bar, pane: Size, bottom: number) => {
  const hr = hRange(pane);
  return clampTo(bar.height ?? Math.round(BAR_EXPANDED_RATIO * pane.h), hr.min, Math.min(hr.max, bottom - MARGIN));
};

/**
 * The bar's rectangle: centred on `center` (the canvas body's middle, in the pane's frame; default the middle of the 「浏览 / 评论」 bar, `dock`) and just above that bar; pulled up, the bottom stays and the top goes up. With the comment list's
 * card up (`avoid`) and sharing some of its height, the bar keeps clear of it: it moves away from the card, and narrows (to 480 at most) only when there is no room to move.
 */
export function barBox(bar: Bar, pane: Size, dock: Box, avoid?: Box, center = dock.x + dock.w / 2): Box {
  let w = barWidth(bar, pane);
  const room = 2 * (Math.min(center, pane.w - center) - MARGIN); // the widest the bar can be and keep its middle on `center`
  if (room >= BAR_W_MIN) w = Math.min(w, room);
  const bottom = dock.y - BAR_GAP;
  const h = bar.expanded ? barHeight(bar, pane, bottom) : BAR_H;
  let x = clampTo(center - w / 2, MARGIN, pane.w - w - MARGIN);
  const y = Math.max(MARGIN, bottom - h);
  if (avoid && y < avoid.y + avoid.h && y + h > avoid.y && x < avoid.x + avoid.w + MARGIN && x + w > avoid.x - MARGIN) {
    if (avoid.x + avoid.w / 2 >= x + w / 2) {
      const limit = avoid.x - MARGIN;
      x = Math.min(x, limit - w);
      if (x < MARGIN) (x = MARGIN, (w = Math.max(Math.min(BAR_W_MIN, w), limit - MARGIN)));
    } else {
      const from = avoid.x + avoid.w + MARGIN;
      x = Math.max(x, from);
      if (x + w > pane.w - MARGIN) w = Math.max(Math.min(BAR_W_MIN, w), pane.w - MARGIN - x);
    }
  }
  return { x, y, w, h };
}

/** Where the session pane is drawn in the bar: the strip shows only its composer, between the avatar / status and the buttons; the half screen shows all of it under the title row. */
export function barSlot(box: Box, expanded: boolean): Box {
  return expanded ? { x: box.x, y: box.y + CHROME_H, w: box.w, h: box.h - CHROME_H } : { x: box.x + BAR_LEFT, y: box.y + (box.h - BAR_COMPOSER_H) / 2, w: box.w - BAR_LEFT - BAR_RIGHT, h: BAR_COMPOSER_H };
}

/** A side handle (`e` / `w`) changes the width about the centre (the bar stays over its 「浏览 / 评论」); the top handle (`n`) the half screen's height. Total drag since it began. */
export function resizeBar(bar: Bar, edge: "e" | "w" | "n", dx: number, dy: number, pane: Size, dock: Box): Bar {
  if (edge === "n") {
    const base = bar.expanded ? barBox(bar, pane, dock).h : BAR_H;
    return { ...bar, height: barHeight({ ...bar, height: base - dy }, pane, dock.y - BAR_GAP) };
  }
  return { ...bar, width: barWidth({ ...bar, width: barWidth(bar, pane) + (edge === "e" ? 2 * dx : -2 * dx) }, pane) };
}

/** The folded bar: a pill right of the 「浏览 / 评论」 bar, as tall as it, `w` wide (canvas/dockPlace.ts groupPlace: the group of the two is what stays centred). */
export function pillBox(dock: Box, w: number): Box {
  return { x: dock.x + dock.w + PILL_GAP, y: dock.y, w, h: dock.h };
}

const KEY_BAR = "agora.float.bar";
export function loadBar(store: Store = localStorage): Bar {
  try {
    const v = JSON.parse(store.getItem(KEY_BAR) ?? "null") as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return DEFAULT_BAR;
    return {
      width: clampTo(num(v.width) ?? BAR_W_DEFAULT, BAR_W_MIN, BAR_W_MAX),
      height: num(v.height) === null ? null : clampTo(num(v.height)!, H_MIN, 4000),
      expanded: v.expanded === true,
      folded: v.folded === true,
    };
  } catch {
    return DEFAULT_BAR;
  }
}
export function saveBar(bar: Bar, store: Store = localStorage): void {
  try {
    store.setItem(KEY_BAR, JSON.stringify(bar));
  } catch {
    /* private window: this page only */
  }
}

// ── the rail tab ──
/**
 * The top of a folded shell's tab at the window's right edge (`h` tall): where the middle of the card was, kept inside the canvas — never up by the toolbar, never down on the
 * bottom controls — and clear of the tabs already there (`taken`): under one, or over it when there is no room under.
 */
export function railTop(centerY: number, h: number, body: { top: number; height: number }, taken: { top: number; bottom: number }[]): number {
  const lo = body.top + 96;
  const hi = body.top + body.height - 64 - h;
  let top = clampTo(centerY - h / 2, lo, hi);
  for (const t of [...taken].sort((a, b) => a.top - b.top)) {
    if (top < t.bottom && top + h > t.top) top = t.bottom + 8 <= hi ? t.bottom + 8 : t.top - 8 - h;
  }
  return top;
}
export const RAIL_W = 28;
/** A folded card's tab is this tall (styles.css `.rail-tab`). */
export const RAIL_H = 148;

// ── which shell is open, and what rail tabs stand where ──
let open: ShellName | null = null;
const rails: Partial<Record<ShellName, { top: number; bottom: number }>> = {};
const mounted = new Map<string, number>();
const cards: Partial<Record<ShellName, Box>> = {};
const ls = new Set<() => void>();
export const floatFocus = {
  get: () => open,
  set(v: ShellName | null) {
    if (v === open) return;
    open = v;
    ls.forEach((l) => l());
  },
  /** Where each folded shell's rail tab is (in the canvas body's frame): the other one goes under it. */
  rail: (name: ShellName) => rails[name],
  setRail(name: ShellName, box: { top: number; bottom: number } | null) {
    const was = rails[name];
    if (box === null ? was === undefined : was?.top === box.top && was.bottom === box.bottom) return;
    if (box === null) delete rails[name];
    else rails[name] = box;
    ls.forEach((l) => l());
  },
  /** Where an open card is (in the canvas body's frame): the bar keeps clear of the comment list's. */
  card: (name: ShellName) => cards[name],
  setCard(name: ShellName, box: Box | null) {
    const was = cards[name];
    if (box === null ? was === undefined : was && was.x === box.x && was.y === box.y && was.w === box.w && was.h === box.h) return;
    if (box === null) delete cards[name];
    else cards[name] = box;
    ls.forEach((l) => l());
  },
  /** A shell is on the page (a card, a bar, a pill, a rail tab): what keeps clear of the shells only measures them while one is. Returns the function that says it is gone. */
  mount(key: string) {
    mounted.set(key, (mounted.get(key) ?? 0) + 1);
    ls.forEach((l) => l());
    return () => {
      const n = (mounted.get(key) ?? 1) - 1;
      if (n <= 0) mounted.delete(key);
      else mounted.set(key, n);
      ls.forEach((l) => l());
    };
  },
  present: () => mounted.size > 0,
  subscribe(l: () => void) {
    ls.add(l);
    return () => void ls.delete(l);
  },
};

const INTERACTIVE = "button, input, textarea, select, a, [contenteditable], [data-nodrag], .float-pick, .float-h";
/**
 * Whether a press may start a drag of the card: the empty part of its title bar does; its buttons, fields, the session menu and the resize handles do not.
 * The drag itself is held by app/dragGuard.ts (selection, capture, Esc).
 */
export function mayDrag(e: { target: unknown; currentTarget?: unknown }): boolean {
  const t = e.target as { closest?: (s: string) => unknown } | null;
  return !t?.closest?.(INTERACTIVE);
}

const keyOf = (name: ShellName) => `agora.float.${name}`;
/** The comment list floated before the shell was shared: its place and folded state carry over. */
const OLD_COMMENTS = "agora.commentsPanel";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Per browser (each viewer's own): the page works without it, so nothing here can fail loudly. What the first floating version kept (no height) loads with the default height. */
export function loadShell(name: ShellName, store: Store = localStorage): Shell {
  try {
    const read = (k: string) => JSON.parse(store.getItem(k) ?? "null") as { place?: { right?: unknown; top?: unknown }; width?: unknown; height?: unknown; folded?: unknown } | null;
    const v = read(keyOf(name)) ?? (name === "comments" ? read(OLD_COMMENTS) : null);
    const right = num(v?.place?.right);
    const top = num(v?.place?.top);
    if (right == null || top == null) return DEFAULT_SHELL;
    const h = num(v?.height);
    return { place: { right, top }, width: clampTo(num(v?.width) ?? W_DEFAULT, W_MIN, W_MAX), height: h === null ? null : clampTo(h, H_MIN, 4000), folded: v?.folded === true };
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
