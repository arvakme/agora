// The floating shell the session panel and the comment list share (web/docs/workstation.md §15 悬浮会话面板): where it sits, how big it is, how a
// drag and a resize keep it inside the window, when a small window puts it back into the layout, and the one that is open at a time. Pure.
import { describe, expect, it } from "vitest";
import { columns, group, groups } from "../workspace/layout.ts";
import {
  BOTTOM_CLEAR, capsuleRight, DEFAULT_SHELL, DEFAULT_W, mayDrag, dragTo, FLOAT_MIN_W, floatFocus, floatWanted, keyMove, loadShell, MARGIN, MAX_W, MIN_W, resizeTo, saveShell, shellBox, TOP_CLEAR, withoutGroup,
} from "./floatShell.ts";

const panes = [{ w: 1440, h: 900 }, { w: 1100, h: 800 }, { w: 800, h: 600 }, { w: 420, h: 500 }];

describe("shellBox: default at the right, MARGIN off the edge, under the canvas's toolbar", () => {
  it("right edge MARGIN in, top TOP_CLEAR down, inside the window in every size", () => {
    for (const pane of panes) {
      const b = shellBox(DEFAULT_SHELL, pane);
      expect(b.x + b.w).toBe(pane.w - MARGIN);
      expect(b.y).toBe(TOP_CLEAR);
      expect(b.y + b.h).toBeLessThanOrEqual(pane.h - MARGIN);
      expect(b.x).toBeGreaterThanOrEqual(0);
    }
  });
  it("the width is DEFAULT_W in [MIN_W, MAX_W], and a window too narrow for MIN_W makes it as wide as the window allows", () => {
    expect(shellBox(DEFAULT_SHELL, { w: 1440, h: 900 }).w).toBe(DEFAULT_W);
    expect(MIN_W).toBe(360);
    expect(MAX_W).toBe(520);
    expect(shellBox({ ...DEFAULT_SHELL, width: 9999 }, { w: 1440, h: 900 }).w).toBe(MAX_W);
    expect(shellBox({ ...DEFAULT_SHELL, width: 10 }, { w: 1440, h: 900 }).w).toBe(MIN_W);
    expect(shellBox(DEFAULT_SHELL, { w: 300, h: 500 }).w).toBe(300 - 2 * MARGIN);
  });
  it("the height follows the content up to the window less 2 × MARGIN, and never past the bottom margin", () => {
    const pane = { w: 1440, h: 900 };
    expect(shellBox(DEFAULT_SHELL, pane, { content: 300 }).h).toBe(300);
    expect(shellBox({ ...DEFAULT_SHELL, place: { right: MARGIN, top: MARGIN } }, pane, { content: 5000 }).h).toBe(pane.h - 2 * MARGIN);
    const low = shellBox({ ...DEFAULT_SHELL, place: { right: MARGIN, top: 600 } }, pane, { content: 5000 });
    expect(low.y + low.h).toBeLessThanOrEqual(pane.h - MARGIN);
  });
});

describe("shellBox with a bottom clearance (the comment list keeps clear of the canvas's bottom controls)", () => {
  it("is no taller than the pane less the top and the clearance", () => {
    const pane = { w: 1000, h: 800 };
    const b = shellBox(DEFAULT_SHELL, pane, { bottom: BOTTOM_CLEAR });
    expect(b.y + b.h).toBeLessThanOrEqual(pane.h - BOTTOM_CLEAR);
    expect(BOTTOM_CLEAR).toBe(80);
    const c = shellBox({ ...DEFAULT_SHELL, place: { right: MARGIN, top: 780 } }, pane, { bottom: BOTTOM_CLEAR });
    expect(c.h).toBeGreaterThan(0);
  });
});

describe("dragTo / resizeTo: a drag keeps the shell in the window", () => {
  const pane = { w: 1440, h: 900 };
  it("follows the pointer (right shrinks as it moves right)", () => {
    const s = dragTo(DEFAULT_SHELL, -100, 50, pane);
    expect(s.place.right).toBe(DEFAULT_SHELL.place.right + 100);
    expect(s.place.top).toBe(DEFAULT_SHELL.place.top + 50);
  });
  it("whatever the pointer did, the whole shell is inside the window, MARGIN from its edges", () => {
    for (const [dx, dy] of [[-9999, -9999], [9999, 9999], [-9999, 9999], [9999, -9999]]) {
      const b = shellBox(dragTo(DEFAULT_SHELL, dx, dy, pane), pane, { content: 400 });
      expect(b.x).toBeGreaterThanOrEqual(MARGIN);
      expect(b.y).toBeGreaterThanOrEqual(MARGIN);
      expect(b.x + b.w).toBeLessThanOrEqual(pane.w - MARGIN);
      expect(b.y + b.h).toBeLessThanOrEqual(pane.h - MARGIN);
    }
  });
  it("the left edge drags the width in [MIN_W, MAX_W], the right edge stays put", () => {
    const wide = resizeTo(DEFAULT_SHELL, 500, pane);
    const narrow = resizeTo(DEFAULT_SHELL, -500, pane);
    expect(shellBox(wide, pane).w).toBe(MAX_W);
    expect(shellBox(narrow, pane).w).toBe(MIN_W);
    expect(shellBox(wide, pane).x + shellBox(wide, pane).w).toBe(shellBox(DEFAULT_SHELL, pane).x + shellBox(DEFAULT_SHELL, pane).w);
  });
  it("a saved place in a window that has shrunk is brought back in", () => {
    const b = shellBox({ ...DEFAULT_SHELL, place: { right: 900, top: 800 } }, { w: 800, h: 600 }, { content: 300 });
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y + b.h).toBeLessThanOrEqual(600 - MARGIN);
  });
});

describe("keyMove: the keyboard's way to move and resize", () => {
  const pane = { w: 1440, h: 900 };
  it("Alt+arrows move by a step, Alt+Shift+←/→ resize; other keys are not ours", () => {
    expect(keyMove(DEFAULT_SHELL, "ArrowLeft", { alt: true, shift: false }, pane)!.place.right).toBeGreaterThan(DEFAULT_SHELL.place.right);
    expect(keyMove(DEFAULT_SHELL, "ArrowDown", { alt: true, shift: false }, pane)!.place.top).toBeGreaterThan(DEFAULT_SHELL.place.top);
    expect(keyMove(DEFAULT_SHELL, "ArrowLeft", { alt: true, shift: true }, pane)!.width).toBeGreaterThan(DEFAULT_SHELL.width);
    expect(keyMove(DEFAULT_SHELL, "ArrowLeft", { alt: false, shift: false }, pane)).toBeNull();
    expect(keyMove(DEFAULT_SHELL, "a", { alt: true, shift: false }, pane)).toBeNull();
  });
});

describe("floatWanted: a small window puts the panel back into the layout, a wide one floats it again for whoever chose it", () => {
  it("floats only with the preference on, a window at least FLOAT_MIN_W wide, and a canvas column to float over", () => {
    expect(FLOAT_MIN_W).toBe(1100);
    expect(floatWanted({ pref: true, windowW: 1440, canvasColumn: true })).toBe(true);
    expect(floatWanted({ pref: true, windowW: 1100, canvasColumn: true })).toBe(true);
    expect(floatWanted({ pref: true, windowW: 1000, canvasColumn: true })).toBe(false); // 1000 × 800: docked
    expect(floatWanted({ pref: false, windowW: 1600, canvasColumn: true })).toBe(false); // the default: docked
    expect(floatWanted({ pref: true, windowW: 1600, canvasColumn: false })).toBe(false); // nothing to float over
  });
  it("it is a pure function of the preference and the window: growing back floats it again, with nothing kept", () => {
    const at = (w: number) => floatWanted({ pref: true, windowW: w, canvasColumn: true });
    expect([1440, 1000, 1440].map(at)).toEqual([true, false, true]);
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
  it("the only group cannot float: nothing is left to float over (null)", () => {
    expect(withoutGroup(sessions, sessions.id)).toBeNull();
  });
  it("an id that is not there changes nothing", () => {
    expect(withoutGroup(root, "nope")).toBe(root);
  });
});

describe("one shell open at a time", () => {
  it("what each shell covers at the right (its reach) is told to the other, and let go", () => {
    floatFocus.setReach("session", 432);
    expect(floatFocus.reach("session")).toBe(432);
    floatFocus.setReach("session", null);
    expect(floatFocus.reach("session")).toBeUndefined();
  });
  it("expanding one folds the other; each is told once", () => {
    floatFocus.set(null);
    const seen: (string | null)[] = [];
    const off = floatFocus.subscribe(() => seen.push(floatFocus.get()));
    floatFocus.set("session");
    floatFocus.set("comments");
    floatFocus.set("comments"); // no change, no news
    floatFocus.set(null);
    off();
    expect(seen).toEqual(["session", "comments", null]);
  });
});

describe("mayDrag: a press that may start a drag", () => {
  const el = (tag: string, cls = "", inside?: unknown) => ({ tagName: tag.toUpperCase(), closest: (sel: string) => (sel.split(",").some((s) => s.trim() === tag || (cls && s.trim() === `.${cls}`)) ? {} : null), inside });
  it("the empty part of the head starts one; buttons, fields and the tabs do not", () => {
    const head = el("header");
    expect(mayDrag({ target: head, currentTarget: head })).toBe(true);
    expect(mayDrag({ target: el("button"), currentTarget: head })).toBe(false);
    expect(mayDrag({ target: el("input"), currentTarget: head })).toBe(false);
    expect(mayDrag({ target: el("textarea"), currentTarget: head })).toBe(false);
    expect(mayDrag({ target: el("div", "wm-tab"), currentTarget: head })).toBe(false);
  });
});

describe("remembering: per browser, per shell", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("keeps place, width and folded for the next visit, separately for each shell", () => {
    const st = store();
    saveShell("session", { place: { right: 40, top: 200 }, width: 480, folded: true }, st);
    expect(loadShell("session", st)).toEqual({ place: { right: 40, top: 200 }, width: 480, folded: true });
    expect(loadShell("comments", st)).toEqual(DEFAULT_SHELL);
  });
  it("garbage or a blocked store: the default, no throw", () => {
    const bad = { getItem: () => "{oops", setItem: () => { throw new Error("no"); } };
    expect(loadShell("session", bad)).toEqual(DEFAULT_SHELL);
    expect(() => saveShell("session", DEFAULT_SHELL, bad)).not.toThrow();
    expect(loadShell("session", { getItem: () => JSON.stringify({ place: { right: "x" }, width: 99999, folded: 1 }), setItem() {} }).width).toBeLessThanOrEqual(MAX_W);
  });
});

describe("capsuleRight: a folded shell's capsule stays clear of the other shell's open panel or capsule", () => {
  it("in its own place when nothing else is at the right", () => {
    expect(capsuleRight(DEFAULT_SHELL.place, [undefined])).toBe(MARGIN);
  });
  it("beside what is there (its reach + 8) when that would cover it", () => {
    expect(capsuleRight(DEFAULT_SHELL.place, [MARGIN + DEFAULT_W])).toBe(MARGIN + DEFAULT_W + 8);
  });
  it("a capsule the viewer moved further left than that stays where it is", () => {
    expect(capsuleRight({ right: 900, top: 100 }, [MARGIN + DEFAULT_W])).toBe(900);
  });
});
