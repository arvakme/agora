// The floating shell (web/docs/workstation.md §15 悬浮会话面板): the card's box and size (eight resize handles, height set by the person, never by the content), dragging,
// snapping and docking, the bottom bar and its pill, the rail tab a folded shell leaves at the window's edge, which shell is open, and when a small window docks the panel.
// Pure: the components measure the pane and ask here.
import { describe, expect, it } from "vitest";
import { columns, group, groups } from "../workspace/layout.ts";
import {
  applySnap, barBox, barSlot, cycleWidth, DEFAULT_BAR, DEFAULT_SHELL, dragBy, floatFocus, floatMode, H_EDGE, H_MIN, HANDLES, keyMove, loadBar, loadShell, MARGIN, mayDrag, normalizeFloatPref,
  pillBox, railTop, resizeBar, resizeBy, saveBar, saveShell, shellBox, shouldDock, SNAP, TOP_CLEAR, W_DEFAULT, W_MAX, W_MIN, withoutGroup, BAR_H, BAR_W_DEFAULT, BAR_W_MAX, BAR_W_MIN, CHROME_H, FLOAT_MIN_H, FLOAT_MIN_W, type Handle, type Shell,
} from "./floatShell.ts";

const pane = { w: 1440, h: 810 };
const edges = (b: { x: number; y: number; w: number; h: number }) => ({ l: b.x, r: b.x + b.w, t: b.y, b: b.y + b.h });
const inside = (b: { x: number; y: number; w: number; h: number }, p = pane) => b.x >= MARGIN - 1e-6 && b.y >= MARGIN - 1e-6 && b.x + b.w <= p.w - MARGIN + 1e-6 && b.y + b.h <= p.h - MARGIN + 1e-6;

describe("shellBox: at the right, 12 px in, under the canvas's toolbar; the size is the person's", () => {
  it("default: 420 wide, 72% of the canvas tall, MARGIN off the right edge, TOP_CLEAR down", () => {
    const b = shellBox(DEFAULT_SHELL, pane);
    expect(b.w).toBe(W_DEFAULT);
    expect(b.h).toBe(Math.round(0.72 * pane.h));
    expect(b.x + b.w).toBe(pane.w - MARGIN);
    expect(b.y).toBe(TOP_CLEAR);
    expect(inside(b)).toBe(true);
  });
  it("the comment list's default is a shorter card", () => {
    expect(shellBox(DEFAULT_SHELL, pane, "comments").h).toBeLessThan(shellBox(DEFAULT_SHELL, pane).h);
  });
  it("width 320–800, height 240 to the window less 24, whatever was saved", () => {
    expect(shellBox({ ...DEFAULT_SHELL, width: 99999 }, pane).w).toBe(W_MAX);
    expect(shellBox({ ...DEFAULT_SHELL, width: 5 }, pane).w).toBe(W_MIN);
    expect(shellBox({ ...DEFAULT_SHELL, height: 99999, place: { right: MARGIN, top: MARGIN } }, pane).h).toBe(pane.h - H_EDGE);
    expect(shellBox({ ...DEFAULT_SHELL, height: 5 }, pane).h).toBe(H_MIN);
  });
  it("the height is what the person pulled: it does not depend on anything else, and stays after a smaller window (clamped, not forgotten)", () => {
    const s: Shell = { ...DEFAULT_SHELL, height: 500 };
    expect(shellBox(s, pane).h).toBe(500);
    expect(shellBox(s, { w: 1200, h: 620 }).h).toBe(500);
    expect(shellBox(s, { w: 1200, h: 400 }).h).toBe(400 - H_EDGE);
    expect(s.height).toBe(500);
  });
  it("a window too small for the minimum gives the shell what the window has, inside it", () => {
    const b = shellBox(DEFAULT_SHELL, { w: 300, h: 260 });
    expect(b.w).toBe(300 - 2 * MARGIN);
    expect(inside(b, { w: 300, h: 260 })).toBe(true);
  });
  it("a saved place in a window that has shrunk is brought back inside", () => {
    const b = shellBox({ ...DEFAULT_SHELL, place: { right: 900, top: 800 } }, { w: 800, h: 600 });
    expect(inside(b, { w: 800, h: 600 })).toBe(true);
  });
});

describe("resizeBy: eight handles, the opposite edges stay, the size stays in range, the position does not drift", () => {
  const start = shellBox({ ...DEFAULT_SHELL, place: { right: 300, top: 120 }, width: 500, height: 450 }, pane);
  const sh: Shell = { ...DEFAULT_SHELL, place: { right: 300, top: 120 }, width: 500, height: 450 };
  const fixed: Record<Handle, ("l" | "r" | "t" | "b")[]> = { n: ["l", "r", "b"], s: ["l", "r", "t"], e: ["l", "t", "b"], w: ["r", "t", "b"], ne: ["l", "b"], nw: ["r", "b"], se: ["l", "t"], sw: ["r", "t"] };
  it("there are eight handles: four edges and four corners", () => {
    expect([...HANDLES].sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  });
  for (const h of HANDLES) {
    it(`${h}: the edges it does not hold stay where they were, for a small drag in every direction`, () => {
      for (const [dx, dy] of [[30, 20], [-30, -20], [30, -20], [-30, 20]]) {
        const b = shellBox(resizeBy(sh, h, dx, dy, pane), pane);
        for (const k of fixed[h]) expect(edges(b)[k]).toBeCloseTo(edges(start)[k], 6);
        expect(inside(b)).toBe(true);
      }
    });
    it(`${h}: dragged past the smallest, the largest and out of the window, the size is in range, the far edges have not moved, the box is inside`, () => {
      for (const [dx, dy] of [[5000, 5000], [-5000, -5000], [5000, -5000], [-5000, 5000], [0, 5000], [5000, 0], [-5000, 0], [0, -5000]]) {
        const b = shellBox(resizeBy(sh, h, dx, dy, pane), pane);
        expect(b.w).toBeGreaterThanOrEqual(W_MIN - 1e-6);
        expect(b.w).toBeLessThanOrEqual(W_MAX + 1e-6);
        expect(b.h).toBeGreaterThanOrEqual(H_MIN - 1e-6);
        expect(b.h).toBeLessThanOrEqual(pane.h - H_EDGE + 1e-6);
        for (const k of fixed[h]) expect(edges(b)[k]).toBeCloseTo(edges(start)[k], 6);
        expect(inside(b)).toBe(true);
      }
    });
  }
  it("east dragged far left stops at the minimum width; west dragged far right too; the opposite edge does not move", () => {
    const e = shellBox(resizeBy(sh, "e", -5000, 0, pane), pane);
    expect(e.w).toBe(W_MIN);
    expect(e.x).toBe(start.x);
    const w = shellBox(resizeBy(sh, "w", 5000, 0, pane), pane);
    expect(w.w).toBe(W_MIN);
    expect(w.x + w.w).toBe(start.x + start.w);
  });
  it("north dragged far up gives the tallest the window allows; south far down stops at the bottom margin", () => {
    expect(shellBox(resizeBy(sh, "n", 0, -5000, pane), pane).h).toBeLessThanOrEqual(pane.h - H_EDGE);
    const s = shellBox(resizeBy(sh, "s", 0, 5000, pane), pane);
    expect(s.y + s.h).toBe(pane.h - MARGIN);
  });
  it("the result depends on the shell it started from and the total drag, so a drag that goes back is back where it was", () => {
    const there = resizeBy(sh, "se", 80, 60, pane);
    const back = resizeBy(sh, "se", 0, 0, pane);
    expect(shellBox(back, pane)).toEqual(start);
    expect(shellBox(there, pane).w).toBe(start.w + 80);
  });
});

describe("dragBy / applySnap / shouldDock", () => {
  it("the shell follows the pointer (right shrinks as it moves right), inside the window", () => {
    const s = dragBy(DEFAULT_SHELL, -200, 40, pane).shell;
    expect(s.place.right).toBe(DEFAULT_SHELL.place.right + 200);
    expect(s.place.top).toBe(DEFAULT_SHELL.place.top + 40);
    for (const [dx, dy] of [[-9999, -9999], [9999, 9999], [-9999, 9999], [9999, -9999]]) expect(inside(shellBox(dragBy(DEFAULT_SHELL, dx, dy, pane).shell, pane))).toBe(true);
  });
  it("its size does not change while it moves", () => {
    const s = { ...DEFAULT_SHELL, width: 555, height: 444 };
    const b = shellBox(dragBy(s, -300, 50, pane).shell, pane);
    expect([b.w, b.h]).toEqual([555, 444]);
  });
  it("within SNAP of the left or right edge (beyond the margin) it says which edge it would snap to; further away, none", () => {
    const near = dragBy(DEFAULT_SHELL, -(pane.w - W_DEFAULT - MARGIN - MARGIN - SNAP + 4), 0, pane);
    expect(near.snap).toBe("left");
    expect(dragBy(DEFAULT_SHELL, 0, 0, pane).snap).toBe("right");
    expect(dragBy(DEFAULT_SHELL, -400, 0, pane).snap).toBeNull();
  });
  it("letting go snaps it to the margin at that edge", () => {
    const d = dragBy(DEFAULT_SHELL, -(pane.w - W_DEFAULT - 2 * MARGIN - 10), 0, pane);
    expect(d.snap).toBe("left");
    expect(shellBox(applySnap(d.shell, d.snap, pane), pane).x).toBe(MARGIN);
    const r = dragBy({ ...DEFAULT_SHELL, place: { right: 20, top: 92 } }, 0, 0, pane);
    expect(shellBox(applySnap(r.shell, r.snap, pane), pane).x + W_DEFAULT).toBe(pane.w - MARGIN);
    expect(applySnap(DEFAULT_SHELL, null, pane)).toEqual(DEFAULT_SHELL);
  });
  it("released at the window's right edge = back to the docked column; anywhere else, no", () => {
    expect(shouldDock(1440, 1440)).toBe(true);
    expect(shouldDock(1436, 1440)).toBe(true);
    expect(shouldDock(1400, 1440)).toBe(false);
  });
});

describe("cycleWidth: double-click the title bar: narrow 340 → default 420 → wide 640 → narrow", () => {
  it("cycles and keeps the right edge", () => {
    const w = (s: Shell) => shellBox(s, pane).w;
    let s: Shell = { ...DEFAULT_SHELL, width: 340 };
    s = cycleWidth(s, pane);
    expect(w(s)).toBe(420);
    s = cycleWidth(s, pane);
    expect(w(s)).toBe(640);
    s = cycleWidth(s, pane);
    expect(w(s)).toBe(340);
    expect(shellBox(s, pane).x + 340).toBe(pane.w - MARGIN);
  });
  it("from a width in between it goes to the next larger one", () => {
    expect(shellBox(cycleWidth({ ...DEFAULT_SHELL, width: 500 }, pane), pane).w).toBe(640);
    expect(shellBox(cycleWidth({ ...DEFAULT_SHELL, width: 700 }, pane), pane).w).toBe(340);
  });
});

describe("keyMove: Alt+arrows move by a step, Alt+Shift+arrows resize; other keys are not ours", () => {
  const s: Shell = { ...DEFAULT_SHELL, place: { right: 200, top: 200 }, width: 420, height: 400 };
  const base = shellBox(s, pane);
  it("Alt+← moves left, Alt+↓ down", () => {
    expect(shellBox(keyMove(s, "ArrowLeft", { alt: true, shift: false }, pane)!, pane).x).toBeLessThan(base.x);
    expect(shellBox(keyMove(s, "ArrowDown", { alt: true, shift: false }, pane)!, pane).y).toBeGreaterThan(base.y);
  });
  it("Alt+Shift+← wider, → narrower, ↑ taller, ↓ shorter", () => {
    const at = (k: string) => shellBox(keyMove(s, k, { alt: true, shift: true }, pane)!, pane);
    expect(at("ArrowLeft").w).toBeGreaterThan(base.w);
    expect(at("ArrowRight").w).toBeLessThan(base.w);
    expect(at("ArrowUp").h).toBeGreaterThan(base.h);
    expect(at("ArrowDown").h).toBeLessThan(base.h);
  });
  it("without Alt, or another key: null", () => {
    expect(keyMove(s, "ArrowLeft", { alt: false, shift: false }, pane)).toBeNull();
    expect(keyMove(s, "a", { alt: true, shift: false }, pane)).toBeNull();
  });
});

describe("floatMode: the person's choice, unless the window is too small or there is no canvas column", () => {
  const ok = { windowW: 1440, windowH: 900, canvasColumn: true };
  it("dock / card / bar as chosen in a window of at least 1100 × 640 with a canvas column", () => {
    expect(FLOAT_MIN_W).toBe(1100);
    expect(FLOAT_MIN_H).toBe(640);
    expect(floatMode({ ...ok, pref: "card" })).toBe("card");
    expect(floatMode({ ...ok, pref: "bar" })).toBe("bar");
    expect(floatMode({ ...ok, pref: "dock" })).toBe("dock");
    expect(floatMode({ ...ok, windowW: 1100, windowH: 640, pref: "card" })).toBe("card");
  });
  it("narrower than 1100, lower than 640 or with nothing to float over: docked", () => {
    expect(floatMode({ ...ok, windowW: 1000, windowH: 800, pref: "card" })).toBe("dock");
    expect(floatMode({ ...ok, windowW: 1440, windowH: 639, pref: "bar" })).toBe("dock");
    expect(floatMode({ ...ok, canvasColumn: false, pref: "card" })).toBe("dock");
  });
  it("it depends on nothing else, so a window that grows again gets the chosen form back", () => {
    const at = (w: number) => floatMode({ ...ok, windowW: w, pref: "bar" });
    expect([1440, 1000, 1440].map(at)).toEqual(["bar", "dock", "bar"]);
  });
  it("the stored preference: the old boolean becomes card / dock, garbage becomes dock", () => {
    expect(normalizeFloatPref(true)).toBe("card");
    expect(normalizeFloatPref(false)).toBe("dock");
    expect(normalizeFloatPref("bar")).toBe("bar");
    expect(normalizeFloatPref("card")).toBe("card");
    expect(normalizeFloatPref("dock")).toBe("dock");
    expect(normalizeFloatPref("nope")).toBe("dock");
    expect(normalizeFloatPref(undefined)).toBe("dock");
  });
});

describe("the bottom bar", () => {
  const dock = { x: 617, y: 750, w: 206, h: 40 }; // the 浏览 / 评论 bar, in the pane's frame
  it("the strip: 780 wide, 58 tall, centred over the bar and just above it, not over it", () => {
    const b = barBox(DEFAULT_BAR, pane, dock);
    expect(b.w).toBe(BAR_W_DEFAULT);
    expect(b.h).toBe(BAR_H);
    expect(b.x + b.w / 2).toBe(dock.x + dock.w / 2);
    expect(b.y + b.h).toBeLessThanOrEqual(dock.y);
    expect(dock.y - (b.y + b.h)).toBeLessThanOrEqual(16);
  });
  it("its width is 480–1000 and inside the window", () => {
    expect(barBox({ ...DEFAULT_BAR, width: 10 }, pane, dock).w).toBe(BAR_W_MIN);
    expect(barBox({ ...DEFAULT_BAR, width: 99999 }, pane, dock).w).toBe(BAR_W_MAX);
    expect(barBox({ ...DEFAULT_BAR, width: 900 }, { w: 800, h: 810 }, dock).w).toBe(800 - 2 * MARGIN);
  });
  it("pulled up to a half screen: the bottom stays where it was, the top goes up; 240 to the window less 24; default about 45%", () => {
    const strip = barBox(DEFAULT_BAR, pane, dock);
    const half = barBox({ ...DEFAULT_BAR, expanded: true }, pane, dock);
    expect(half.y + half.h).toBe(strip.y + strip.h);
    expect(half.h).toBe(Math.round(0.45 * pane.h));
    expect(barBox({ ...DEFAULT_BAR, expanded: true, height: 5 }, pane, dock).h).toBe(H_MIN);
    expect(barBox({ ...DEFAULT_BAR, expanded: true, height: 99999 }, pane, dock).h).toBeLessThanOrEqual(pane.h - H_EDGE);
    expect(barBox({ ...DEFAULT_BAR, expanded: true, height: 99999 }, pane, dock).y).toBeGreaterThanOrEqual(MARGIN);
  });
  it("with the comment list's card up at the right, the bar keeps clear of it (moves left, narrows only when it must), and only when they share some height", () => {
    const list = { x: 1008, y: 182, w: 420, h: 420 };
    expect(barBox(DEFAULT_BAR, pane, dock, list)).toEqual(barBox(DEFAULT_BAR, pane, dock)); // the strip is below the card: nothing to avoid
    const half = barBox({ ...DEFAULT_BAR, expanded: true }, pane, dock, list);
    expect(half.x + half.w).toBeLessThanOrEqual(list.x - MARGIN);
    expect(half.x).toBeGreaterThanOrEqual(MARGIN);
    expect(half.w).toBe(BAR_W_DEFAULT);
    const tight = barBox({ ...DEFAULT_BAR, expanded: true }, { w: 1100, h: 810 }, { ...dock, x: 447 }, { x: 700, y: 182, w: 388, h: 420 });
    expect(tight.x + tight.w).toBeLessThanOrEqual(700 - MARGIN);
    expect(tight.w).toBeGreaterThanOrEqual(BAR_W_MIN);
  });
  it("the pane is where the composer is: the strip's middle between the avatar/status and the buttons; the half screen's body under the title row", () => {
    const strip = barBox(DEFAULT_BAR, pane, dock);
    const s = barSlot(strip, false);
    expect(s.h).toBeLessThanOrEqual(BAR_H);
    expect(s.x).toBeGreaterThan(strip.x);
    expect(s.x + s.w).toBeLessThan(strip.x + strip.w);
    const half = barBox({ ...DEFAULT_BAR, expanded: true }, pane, dock);
    const body = barSlot(half, true);
    expect(body.y).toBe(half.y + CHROME_H);
    expect(body.h).toBe(half.h - CHROME_H);
    expect([body.x, body.w]).toEqual([half.x, half.w]);
  });
  it("resizeBar: either side changes the width about the centre (480–1000); the top handle the half screen's height (240 to window − 24)", () => {
    const b0 = barBox(DEFAULT_BAR, pane, dock);
    const wider = resizeBar(DEFAULT_BAR, "e", 60, 0, pane, dock);
    expect(barBox(wider, pane, dock).w).toBe(b0.w + 120);
    expect(barBox(resizeBar(DEFAULT_BAR, "w", 60, 0, pane, dock), pane, dock).w).toBe(b0.w - 120);
    expect(barBox(resizeBar(DEFAULT_BAR, "e", 9999, 0, pane, dock), pane, dock).w).toBe(BAR_W_MAX);
    expect(barBox(resizeBar(DEFAULT_BAR, "e", -9999, 0, pane, dock), pane, dock).w).toBe(BAR_W_MIN);
    const tall = resizeBar({ ...DEFAULT_BAR, expanded: true }, "n", 0, -60, pane, dock);
    expect(barBox(tall, pane, dock).h).toBe(Math.round(0.45 * pane.h) + 60);
    expect(barBox(resizeBar({ ...DEFAULT_BAR, expanded: true }, "n", 0, -9999, pane, dock), pane, dock).h).toBeLessThanOrEqual(pane.h - H_EDGE);
    expect(barBox(resizeBar({ ...DEFAULT_BAR, expanded: true }, "n", 0, 9999, pane, dock), pane, dock).h).toBe(H_MIN);
  });
  it("the pill: beside the bar without touching it, level with it and as tall as it, as wide as it is told (canvas/dockPlace.ts groupPlace says)", () => {
    const p = pillBox(dock, 176);
    expect(p.x).toBeGreaterThan(dock.x + dock.w);
    expect(p).toMatchObject({ y: dock.y, w: 176, h: dock.h });
  });
  it("the bar's middle is the one it is given (the canvas body's), not where the bar below happens to be; it narrows before it would lean off that middle", () => {
    const b = barBox(DEFAULT_BAR, pane, dock, undefined, 500);
    expect(b.x + b.w / 2).toBe(500);
    const edge = barBox({ ...DEFAULT_BAR, width: 1000 }, pane, dock, undefined, 300);
    expect(edge.x + edge.w / 2).toBe(300);
    expect(edge.x).toBeGreaterThanOrEqual(MARGIN);
  });
  it("remembered per browser: width, height, half screen, folded; garbage gives the default", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveBar({ width: 900, height: 500, expanded: true, folded: false }, st);
    expect(loadBar(st)).toEqual({ width: 900, height: 500, expanded: true, folded: false });
    expect(loadBar({ getItem: () => "{x", setItem() {} })).toEqual(DEFAULT_BAR);
    expect(loadBar({ getItem: () => JSON.stringify({ width: 99999, height: 3 }), setItem() {} })).toMatchObject({ width: BAR_W_MAX, height: H_MIN });
  });
});

describe("railTop: the rail tab a folded shell leaves at the window's edge", () => {
  const body = { top: 0, height: 810 };
  it("at the middle of where the card was, inside the canvas (never up by the toolbar, never down on the bottom controls)", () => {
    expect(railTop(400, 132, body, [])).toBe(400 - 66);
    expect(railTop(10, 132, body, [])).toBeGreaterThanOrEqual(96);
    expect(railTop(9999, 132, body, []) + 132).toBeLessThanOrEqual(body.height - 64);
  });
  it("beside another tab it goes under it (or over it when there is no room under), never on it", () => {
    const first = { top: 334, bottom: 466 };
    const below = railTop(400, 132, body, [first]);
    expect(below).toBeGreaterThanOrEqual(first.bottom);
    const low = railTop(760, 132, body, [{ top: 560, bottom: 690 }]);
    expect(low + 132).toBeLessThanOrEqual(560);
  });
});

describe("withoutGroup: the layout without the floating group (the layout itself is not changed)", () => {
  const canvas = group(["c1", "c2"]);
  const sessions = group(["s1", "s2"]);
  const root = columns(canvas, sessions, [0.6, 0.4]);
  it("the other column takes the width; the tree the caller keeps still has both", () => {
    const rest = withoutGroup(root, sessions.id);
    expect(rest && groups(rest).map((g) => g.id)).toEqual([canvas.id]);
    expect(groups(root).map((g) => g.id)).toEqual([canvas.id, sessions.id]);
  });
  it("the only group cannot float (null); an id that is not there changes nothing", () => {
    expect(withoutGroup(sessions, sessions.id)).toBeNull();
    expect(withoutGroup(root, "nope")).toBe(root);
  });
});

describe("one card open at a time; what each shell covers", () => {
  it("expanding one folds the other; each is told once", () => {
    floatFocus.set(null);
    const seen: (string | null)[] = [];
    const off = floatFocus.subscribe(() => seen.push(floatFocus.get()));
    floatFocus.set("session");
    floatFocus.set("comments");
    floatFocus.set("comments");
    floatFocus.set(null);
    off();
    expect(seen).toEqual(["session", "comments", null]);
  });
  it("a folded shell's rail box is told to the other, and let go", () => {
    floatFocus.setRail("session", { top: 300, bottom: 430 });
    expect(floatFocus.rail("session")).toEqual({ top: 300, bottom: 430 });
    floatFocus.setRail("session", null);
    expect(floatFocus.rail("session")).toBeUndefined();
  });
});

describe("floatFocus.card: where a card is, for what keeps clear of it", () => {
  it("told and let go", () => {
    floatFocus.setCard("comments", { x: 1, y: 2, w: 3, h: 4 });
    expect(floatFocus.card("comments")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    floatFocus.setCard("comments", null);
    expect(floatFocus.card("comments")).toBeUndefined();
  });
});

describe("floatFocus.mount: whether any shell is on the page", () => {
  it("present while at least one is mounted, counted per key", () => {
    expect(floatFocus.present()).toBe(false);
    const a = floatFocus.mount("session");
    const b = floatFocus.mount("comments");
    expect(floatFocus.present()).toBe(true);
    a();
    expect(floatFocus.present()).toBe(true);
    b();
    expect(floatFocus.present()).toBe(false);
  });
});

describe("mayDrag: a press that may start a drag", () => {
  const el = (tag: string, cls = "") => ({ tagName: tag.toUpperCase(), closest: (sel: string) => (sel.split(",").some((s) => s.trim() === tag || (cls && s.trim() === `.${cls}`)) ? {} : null) });
  it("the empty part of the title bar does; buttons, fields, the session menu and the handles do not", () => {
    const head = el("header");
    expect(mayDrag({ target: head, currentTarget: head })).toBe(true);
    expect(mayDrag({ target: el("button") })).toBe(false);
    expect(mayDrag({ target: el("input") })).toBe(false);
    expect(mayDrag({ target: el("textarea") })).toBe(false);
    expect(mayDrag({ target: el("div", "float-pick") })).toBe(false);
  });
});

describe("remembering: per browser, per shell", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("keeps place, size and folded for the next visit, separately for each shell", () => {
    const st = store();
    const s: Shell = { place: { right: 40, top: 200 }, width: 480, height: 500, folded: true };
    saveShell("session", s, st);
    expect(loadShell("session", st)).toEqual(s);
    expect(loadShell("comments", st)).toEqual(DEFAULT_SHELL);
  });
  it("what the first floating version saved (no height) loads with the default height; the comment list's own older key still gives its place", () => {
    const st = store();
    st.setItem("agora.float.session", JSON.stringify({ place: { right: 50, top: 100 }, width: 400, folded: false }));
    expect(loadShell("session", st)).toEqual({ place: { right: 50, top: 100 }, width: 400, height: null, folded: false });
    st.setItem("agora.commentsPanel", JSON.stringify({ place: { right: 30, top: 130 }, folded: true }));
    expect(loadShell("comments", st).place).toEqual({ right: 30, top: 130 });
  });
  it("garbage, out-of-range sizes or a blocked store: a usable shell, no throw", () => {
    const bad = { getItem: () => "{oops", setItem: () => { throw new Error("no"); } };
    expect(loadShell("session", bad)).toEqual(DEFAULT_SHELL);
    expect(() => saveShell("session", DEFAULT_SHELL, bad)).not.toThrow();
    const wild = loadShell("session", { getItem: () => JSON.stringify({ place: { right: 1, top: 1 }, width: 99999, height: 2, folded: 1 }), setItem() {} });
    expect(wild.width).toBeLessThanOrEqual(W_MAX);
    expect(wild.height).toBeGreaterThanOrEqual(H_MIN);
  });
});
