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
vi.mock("../nested/store", () => ({ nested: { get: () => ({ scenes: new Map([["c", els]]), titles: { c: "canvas" }, index: new Map() }) }, nav: { go: () => {} } }));
vi.mock("../session/ui", () => ({ canvases: new Map([["c", { api }]]) }));
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
