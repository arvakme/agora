// The build replay's camera (web/docs/share-build-replay.md §5): the shot is where the drawing and the figure put it (./camera.ts `shotOf`); how the view
// gets there is the director's camera (../workstation/director.ts `cameraStep`: a rate-limited carrot and a critically damped spring, a cut over
// CUT_DISTANCE). Time series, at 60 fps, on the geometry of the real diagrams of the fixtures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cameraStart, CARROT_SPEED, centreOf, CUT_COOLDOWN_MS, viewAt, type CameraState } from "../workstation/director";
import { viewProblems, type ViewSample } from "../workstation/cameraCurve";
import { geometryWalk } from "./geometryWalk";
import { jumped, REPLAY_ZOOM, shotOf, stepOf } from "./camera";
import { centres, planBuild, type Beat, type Plan } from "./plan";
import type { BuildTimeline } from "./types";

const FRAME = 1000 / 60;
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as BuildTimeline;
const SIZE = { w: 900, h: 600 };

describe("shotOf: the drawing decides the zoom, the figure the centre", () => {
  const bounds = { x: 0, y: 0, w: 3000, h: 1800 };
  it("a drawing that does not fit: the zoom that fits it (never under 0.55), the centre on the figure held inside the drawing", () => {
    const s = shotOf({ size: SIZE, bounds, figure: { x: 1500, y: 900 } });
    expect(s.zoom).toBe(REPLAY_ZOOM.min);
    expect(s.centre.x).toBeCloseTo(1500, 5);
  });
  it("a drawing that fits the pane: its middle, whatever the figure does (the camera holds)", () => {
    const small = { x: 100, y: 100, w: 400, h: 300 };
    const a = shotOf({ size: SIZE, bounds: small, figure: { x: 250, y: 250 } });
    const b = shotOf({ size: SIZE, bounds: small, figure: { x: 350, y: 300 } });
    expect(a.centre).toEqual(b.centre);
    expect(a.centre).toEqual({ x: 300, y: 250 });
    expect(a.zoom).toBe(REPLAY_ZOOM.max);
  });
  it("a figure that moves further than a walk does in a frame was cut across", () => {
    expect(jumped({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(false);
    expect(jumped({ x: 0, y: 0 }, { x: 500, y: 0 })).toBe(true);
    expect(jumped(null, { x: 500, y: 0 })).toBe(false);
  });
  it("no figure: the middle of the drawing", () => {
    expect(shotOf({ size: SIZE, bounds, figure: null }).centre).toEqual({ x: 1500, y: 900 });
  });
});

/** Where the figure is at play time t on one canvas, from the plan alone: it stands where it last worked, walks a beat's walk in a straight line at the
 * pace of a walk, and is cut across in a hop (it is at the new place from the moment it sets off). */
function figureAt(plan: Plan, tl: BuildTimeline, canvas: string, t: number): { x: number; y: number } | null {
  const at = centres(tl);
  let here: { x: number; y: number } | null = null;
  for (const b of plan.beats) {
    if (b.canvas !== canvas || !b.at) continue;
    const to = at.get(`${canvas}/${b.at}`);
    if (!to) continue;
    if (b.start > t) break;
    const from = b.from ? at.get(`${b.fromCanvas}/${b.from}`) : null;
    if (b.hop || !from || !b.walkMs || b.fromCanvas !== canvas) here = to;
    else {
      const u = Math.min(1, (t - b.start) / b.walkMs);
      here = { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
    }
  }
  return here;
}

describe.each(["agent-history", "whole-diagram-in-one-change"] as const)("the camera over the whole replay of %s (brief), 60 fps at 1×", (name) => {
  const tl = load(name);
  const plan = planBuild(tl, { ...geometryWalk(tl), mode: "brief" });
  const canvas = tl.root;
  const els = [...centres(tl)].filter(([k]) => k.startsWith(`${canvas}/`)).map(([, c]) => c);
  const bounds = { x: Math.min(...els.map((c) => c.x)) - 80, y: Math.min(...els.map((c) => c.y)) - 40, w: Math.max(...els.map((c) => c.x)) - Math.min(...els.map((c) => c.x)) + 160, h: Math.max(...els.map((c) => c.y)) - Math.min(...els.map((c) => c.y)) + 80 };
  const rows: { t: number; s: CameraState; out: ReturnType<typeof stepOf>; fig: { x: number; y: number } | null }[] = [];
  let st: CameraState | null = null;
  let prevFig: { x: number; y: number } | null = null;
  const first = plan.beats.find((b) => b.canvas === canvas);
  for (let t = first ? first.start - 500 : 0; t <= plan.length; t += FRAME) {
    const fig = figureAt(plan, tl, canvas, t);
    const shot = shotOf({ size: SIZE, bounds, figure: fig });
    st ??= cameraStart(viewAt(shot.centre, shot.zoom, SIZE), SIZE);
    const out = stepOf(st, shot, { dt: FRAME, now: t, pane: SIZE, cut: jumped(prevFig, fig) });
    prevFig = fig;
    st = out.state;
    rows.push({ t, s: st, out, fig });
  }
  const speed = (i: number) => Math.hypot(rows[i].s.at.x - rows[i - 1].s.at.x, rows[i].s.at.y - rows[i - 1].s.at.y) / (FRAME / 1000);

  it("no frame's speed jumps, except across a cut (viewProblems, on each stretch between cuts)", () => {
    const stretches: ViewSample[][] = [[]];
    for (const r of rows) {
      if (r.out.cut) stretches.push([]);
      else stretches[stretches.length - 1].push({ t: r.t, canvas, zoom: r.out.view.zoom, sx: r.out.view.scrollX, sy: r.out.view.scrollY });
    }
    const snaps = stretches.flatMap((x) => viewProblems(x, { snapPx: 12 }).snaps);
    const jumps = stretches.flatMap((x) => viewProblems(x, { snapPx: 12 }).zoomJumps);
    expect(snaps).toEqual([]);
    expect(jumps).toEqual([]);
  });

  it("every move eases in: the first frame after the camera sets off is at most 20% of the peak speed of that move", () => {
    let i = 1;
    let episodes = 0;
    while (i < rows.length) {
      if (speed(i) > 0.5 && !rows[i].out.cut && speed(i - 1) <= 0.5) {
        let peak = 0;
        let j = i;
        while (j < rows.length && (speed(j) > 0.5 || rows[j].out.cut)) peak = Math.max(peak, rows[j++].out.cut ? 0 : speed(j - 1));
        if (peak > 15) {
          episodes++;
          expect(speed(i), `at ${Math.round(rows[i].t)}`).toBeLessThanOrEqual(peak * 0.2);
        }
        i = j;
      } else i++;
    }
    if (name === "agent-history") expect(episodes).toBeGreaterThan(0);
  });

  it("the speed never passes the carrot's, a cut is the only jump, and cuts keep CUT_COOLDOWN_MS apart", () => {
    for (let i = 1; i < rows.length; i++) if (!rows[i].out.cut) expect(speed(i)).toBeLessThanOrEqual(CARROT_SPEED * 1.05);
    const cuts = rows.filter((r) => r.out.cut).map((r) => r.t);
    for (let k = 1; k < cuts.length; k++) expect(cuts[k] - cuts[k - 1]).toBeGreaterThanOrEqual(CUT_COOLDOWN_MS);
  });

  it("the camera cuts in the frame the figure is cut across (every hop of the canvas), and nowhere else", () => {
    const hops = plan.beats.filter((b: Beat) => b.hop && b.canvas === canvas && b.fromCanvas === canvas);
    const cuts = rows.filter((r) => r.out.cut).map((r) => r.t);
    for (const c of cuts) expect(hops.some((b) => Math.abs(b.start - c) <= 2 * FRAME + 1), `cut at ${Math.round(c)}`).toBe(true);
    // every hop that changes the shot is a cut of the camera (a hop that leaves the shot where it is needs none)
    const at = centres(tl);
    const shotAt = (place: string | null) => shotOf({ size: SIZE, bounds, figure: place ? (at.get(`${canvas}/${place}`) ?? null) : null }).centre;
    for (const b of hops.filter((h) => Math.hypot(shotAt(h.from).x - shotAt(h.at).x, shotAt(h.from).y - shotAt(h.at).y) > 100))
      expect(cuts.some((c) => Math.abs(b.start - c) <= 2 * FRAME + 1), `hop at ${Math.round(b.start)}`).toBe(true);
    // the first frame after a cut is the shot: the camera does not set off again after it
    for (const c of rows.filter((r) => r.out.cut)) {
      const i = rows.indexOf(c);
      const after = rows.slice(i + 1, i + 12);
      expect(Math.max(...after.map((r) => Math.hypot(r.s.at.x - c.s.at.x, r.s.at.y - c.s.at.y)))).toBeLessThan(60);
    }
  });

  it("the figure is in the pane (the drawing is not larger than the view, or the camera follows it) in nearly every frame", () => {
    const seen = rows.filter((r) => r.fig);
    const inside = seen.filter((r) => {
      const c = centreOf(r.out.view, SIZE);
      return Math.abs(r.fig!.x - c.x) * r.out.view.zoom < SIZE.w / 2 && Math.abs(r.fig!.y - c.y) * r.out.view.zoom < SIZE.h / 2;
    });
    expect(inside.length / seen.length).toBeGreaterThan(0.97);
  });
});
