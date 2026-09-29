// FX1 (RV1 P1, P2): the camera driver (replayView.ts `createCamera`) with the canvas, the store and the clock replaced by small stand-ins — the director's
// functions, the stage's place and the follow shot are the real ones. A manual pause is the person having the view: nothing the camera does writes it;
// and the way home goes back to the view the person had, at the zoom they had.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewAt } from "./director";
import type { WorkRun } from "./runs/types";

const pane = { w: 900, h: 700 };
type V = { zoom: number; scrollX: number; scrollY: number; width: number; height: number };
const w = {
  reduced: false,
  time: 5000,
  pos: { x: 2000, y: 0 },
  view: { ...viewAt({ x: 0, y: 0 }, 1, pane), width: pane.w, height: pane.h } as V,
  writes: [] as V[],
  /** The canvas has nothing in the scene store yet (an empty canvas the agent has not drawn on). */
  noScene: false,
  listeners: new Map<string, (e: unknown) => void>(),
};
const els = [{ id: "api", x: 0, y: 0, width: 400, height: 300 }];
const api = {
  getAppState: () => ({ width: pane.w, height: pane.h }),
  getSceneElements: () => els,
  updateScene: ({ appState: v }: { appState: { scrollX: number; scrollY: number; zoom: { value: number } } }) => {
    w.view = { ...w.view, scrollX: v.scrollX, scrollY: v.scrollY, zoom: v.zoom.value };
    w.writes.push(w.view);
  },
};
vi.mock("../canvas/viewport", () => ({ viewport: { get: () => w.view }, firstView: { set: () => {}, drop: () => {} } }));
vi.mock("../nested/store", () => ({ nested: { get: () => ({ scenes: w.noScene ? new Map() : new Map([["c", els], ["d", els]]), titles: { c: "canvas", d: "other" }, index: new Map() }) }, nav: { go: () => {} } }));
vi.mock("../session/ui", () => ({ canvases: new Map([["c", { api }], ["d", { api }]]) }));
vi.mock("./clock", () => ({ clock: { time: () => w.time }, prefersReducedMotion: () => w.reduced }));
vi.mock("./geometry", () => ({ buildGeometry: () => ({ locate: () => ({ place: "api" }), dock: () => w.pos, route: undefined, boxes: new Map(), boxOf: () => undefined }) }));
vi.mock("./replayDom", () => ({ occupiedOf: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), excalidrawEl: () => null }));
vi.mock("./focus", () => ({ figurePositions: { get: () => w.pos } }));
vi.mock("./replayHistory", () => ({ replacingPush: (f: () => void) => f() }));
vi.mock("./scenePlaces", () => ({ scenePlaces: () => ({}) }));

const run: WorkRun = { id: "r", agent: "claude", name: "Claude", segs: [{ kind: "write", start: 0, end: 100000, path: "api", label: "write" }], receipts: [], children: [], running: true, lastAt: 100000 };
const wheel = () => w.listeners.get("wheel")!({ type: "wheel", target: { closest: (s: string) => (s === ".excalidraw" ? {} : null) } });
const FRAME = 1000 / 60;

beforeEach(() => {
  w.reduced = false;
  w.time = 5000;
  w.pos = { x: 2000, y: 0 };
  w.view = { ...viewAt({ x: 0, y: 0 }, 1, pane), width: pane.w, height: pane.h };
  w.writes = [];
  w.noScene = false;
  w.listeners.clear();
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("history", { state: null, replaceState: () => {} });
  vi.stubGlobal("location", { href: "http://local.invalid/" });
  vi.stubGlobal("addEventListener", (k: string, f: (e: unknown) => void) => w.listeners.set(k, f));
  vi.stubGlobal("removeEventListener", (k: string, f: unknown) => void (w.listeners.get(k) === f && w.listeners.delete(k)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { createCamera } = await import("./replayView");
const { byCamera, userNav } = await import("./navOrigin");
const liveHooks = (paused: { on: boolean }, working = () => true) => ({ setManual: (x: boolean) => void (paused.on = x), live: { current: () => "c", working, away: () => {} } });

describe("FX1 · P1: a manual pause is not got round by the reduced-motion branch, the overview or the way home", () => {
  it("reduced motion, following an agent 2000 units away, the wheel pauses it: the next frame writes nothing", () => {
    w.reduced = true;
    const paused = { on: false };
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), liveHooks(paused));
    c.tick();
    wheel();
    expect(paused.on).toBe(true);
    const before = { ...w.view };
    w.writes = [];
    for (let i = 0; i < 5; i++) c.frame(16);
    expect(w.writes).toHaveLength(0);
    expect(w.view.scrollX).toBe(before.scrollX);
    c.stop();
  });
  it("…and 「继续」 hands the camera back: the shot is there again", () => {
    w.reduced = true;
    const paused = { on: false };
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), liveHooks(paused));
    c.tick();
    wheel();
    c.frame(16);
    c.resume();
    c.frame(16);
    expect(paused.on).toBe(false);
    expect(w.writes.length).toBeGreaterThan(0);
    c.stop();
  });
  it("a play, dragged by the person on the way, is not put on the whole diagram when it comes to its summary", () => {
    const paused = { on: false };
    const c = createCamera(() => "c", () => run, () => ({ start: 0, end: 10000 }), { setManual: (x) => void (paused.on = x) });
    c.tick();
    wheel();
    expect(paused.on).toBe(true);
    w.writes = [];
    w.time = 10000;
    c.frame(16);
    c.frame(16);
    expect(w.writes).toHaveLength(0);
    c.exit();
  });
  it("a play that is not paused still opens on the whole diagram and ends on it (the play's own overview is unchanged)", () => {
    const c = createCamera(() => "c", () => run, () => ({ start: 0, end: 10000 }), { setManual: () => {} });
    c.tick();
    w.writes = [];
    w.time = 10000;
    c.frame(16);
    expect(w.writes.length).toBeGreaterThan(0);
    c.exit();
  });
  it("a paused play, then 「继续」 at the summary: the overview comes back (the summary is a whole-diagram view)", () => {
    const c = createCamera(() => "c", () => run, () => ({ start: 0, end: 10000 }), { setManual: () => {} });
    c.tick();
    c.frame(16);
    wheel();
    w.time = 10000;
    c.frame(16);
    w.writes = [];
    c.resume();
    c.frame(16);
    expect(w.writes.length).toBeGreaterThan(0);
    c.exit();
  });
});

describe("FX1 · P2: the way home returns the view the person had — at their zoom", () => {
  it("looking at a big diagram at 30 %, the turn brings the camera close, and three seconds after it the view is the 30 % one again (not 70 %)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    w.view = { ...viewAt({ x: 900, y: 300 }, 0.3, pane), width: pane.w, height: pane.h };
    w.pos = { x: 0, y: 0 };
    const own = { ...w.view };
    let working = true;
    const paused = { on: false };
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), liveHooks(paused, () => working));
    c.tick();
    for (let i = 0; i < 60 * 6; i++) (vi.setSystemTime(Date.now() + FRAME), w.time += FRAME, c.tick(), c.frame(FRAME));
    expect(w.view.zoom).toBeGreaterThanOrEqual(0.69); // the shot is close
    working = false;
    for (let i = 0; i < 60 * 30; i++) (vi.setSystemTime(Date.now() + FRAME), w.time += FRAME, c.tick(), c.frame(FRAME));
    expect(paused.on).toBe(false);
    expect(w.view.zoom).toBeCloseTo(own.zoom, 2);
    expect(Math.abs(w.view.scrollX - own.scrollX) * own.zoom).toBeLessThan(3);
    c.stop();
  });
});

describe("FX2a · #1: an empty canvas — the agent is at work in the tray, and the camera goes to it at once", () => {
  it("no scene in the store: the figure at the tray outside the pane is followed (a cut to it), not left off screen", () => {
    w.noScene = true;
    w.pos = { x: 0, y: -1500 }; // the tray, far from the view
    const paused = { on: false };
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), liveHooks(paused));
    c.tick();
    for (let i = 0; i < 90; i++) c.frame(FRAME);
    const centre = { x: pane.w / 2 / w.view.zoom - w.view.scrollX, y: pane.h / 2 / w.view.zoom - w.view.scrollY };
    expect(Math.hypot(centre.x - w.pos.x, centre.y - (w.pos.y - 40))).toBeLessThan(200);
    c.stop();
  });
});

describe("FX2a · #2: the canvas in front changes with no input of the person's (the app opened it for the agent): not their doing, no pause", () => {
  it("no pointer, key or wheel lately: the camera goes on, on that canvas, and is not paused", () => {
    const paused = { on: false };
    let cur = "c";
    const hooks = { setManual: (x: boolean) => void (paused.on = x), live: { current: () => cur, working: () => true, away: () => {} } };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), hooks);
    c.tick();
    cur = "d";
    for (let i = 0; i < 40; i++) (vi.setSystemTime(Date.now() + 200), c.tick());
    expect(paused.on).toBe(false);
    expect(c.shown()).toBe("d");
    c.stop();
  });
  it("the person's own navigation (the app says so where it happens): paused at once — however the canvas change is seen later", () => {
    const paused = { on: false };
    const hooks = { setManual: (x: boolean) => void (paused.on = x), live: { current: () => "c", working: () => true, away: () => {} } };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), hooks);
    c.tick();
    userNav.note(); // the browser's back, a breadcrumb, a tab: no pointer, key or wheel reaches the page for some of them
    expect(paused.on).toBe(true);
    c.stop();
  });
  it("F4: the camera's own move and the person's 'back' half a second later: still theirs when the canvas change is seen after the mount grace", () => {
    const paused = { on: false };
    let cur = "c";
    const hooks = { setManual: (x: boolean) => void (paused.on = x), live: { current: () => cur, working: () => true, away: () => {} } };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), hooks);
    c.tick();
    byCamera(() => userNav.note()); // the camera's own navigation
    expect(paused.on).toBe(false);
    vi.setSystemTime(Date.now() + 500);
    userNav.note(); // the person goes back
    cur = "d";
    for (let i = 0; i < 40; i++) (vi.setSystemTime(Date.now() + 200), c.tick());
    expect(paused.on).toBe(true);
    expect(c.shown()).toBe("d");
    c.stop();
  });
  it("a note that no canvas change follows is not held against a later change the app made", () => {
    const paused = { on: false };
    let cur = "c";
    const hooks = { setManual: (x: boolean) => void (paused.on = x), live: { current: () => cur, working: () => true, away: () => {} } };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), hooks);
    c.tick();
    userNav.note();
    c.resume(); // handed back
    for (let i = 0; i < 10; i++) (vi.setSystemTime(Date.now() + 200), c.tick());
    expect(paused.on).toBe(false);
    cur = "d"; // the app opens another canvas (an agent's read)
    for (let i = 0; i < 10; i++) (vi.setSystemTime(Date.now() + 200), c.tick());
    expect(paused.on).toBe(false);
    c.stop();
  });
});

describe("FX2a · #14: the tab comes back from the background: the camera goes on from its own state, not from a view something reset", () => {
  it("a 30 s gap in the frames and the canvas view reset to the origin: the next frame is back on the camera's view", () => {
    w.pos = { x: 300, y: 200 };
    const paused = { on: false };
    const c = createCamera(() => null, () => run, () => ({ start: 0, end: null }), liveHooks(paused));
    c.tick();
    for (let i = 0; i < 120; i++) c.frame(FRAME);
    const before = { ...w.view };
    w.view = { ...w.view, scrollX: 0, scrollY: 0 }; // what the hidden tab came back with
    c.frame(30000);
    expect(Math.abs(w.view.scrollX - before.scrollX)).toBeLessThan(60);
    expect(Math.abs(w.view.scrollY - before.scrollY)).toBeLessThan(60);
    c.stop();
  });
});
