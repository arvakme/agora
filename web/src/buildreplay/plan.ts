// Playing a build timeline (web/docs/share-build-replay.md §5): the steps become beats on a clock of their own —
// idle time is gone, each beat is "walk to the node, draw", and the canvas changes when the figure has got there.
// A beat's figure work is an ordinary WorkRun segment (so the walking, the bridges, the ladders and the doors of
// the 工位视图 do the rest: ../workstation/place.ts); its words are the segment's `say`. Pure, so it runs under vitest.
import type { El } from "../canvas/scene";
import { DOOR_MS } from "../workstation/rig";
import type { RunSeg, WorkRun } from "../workstation/runs/types";
import type { Actor, BuildItem, BuildTimeline, ItemKind } from "./types";

/** How long each kind of beat lasts once the figure is there (ms). */
export const DWELL: Record<ItemKind | "tick", number> = { "add-node": 650, "add-arrows": 800, expand: 900, rename: 700, move: 600, restyle: 500, delete: 600, note: 700, link: 450, tick: 450 };
/** From the figure arriving to the element landing on the canvas. */
export const LAND_LEAD_MS = 250;
/** Nothing happens for this long before the first beat: the canvas as it began. */
export const OPENING_MS = 900;
/** The pace a figure walks at (world px per ms, ../workstation/rig.ts WALK_SPEED) and how much longer than the straight line its way is. */
const WALK_PX_MS = 0.22;
const DETOUR = 1.4;
const SETTLE_MS = 500;

export type Beat = {
  i: number;
  step: number;
  canvas: string;
  /** Actor key: an agent kind, or "you". */
  actor: string;
  kind: ItemKind | "tick";
  say: string;
  /** The node the figure works at (null: where it already is). */
  place: string | null;
  quiet: boolean;
  /** Play time (ms from the opening): the figure sets off, gets there and the canvas changes, the beat is over. */
  start: number;
  land: number;
  end: number;
  add: El[];
  change: El[];
  remove: string[];
  child?: string;
};
export type ActorInfo = { key: string; agent: string; name: string };
export type Plan = { beats: Beat[]; length: number; actors: ActorInfo[] };
export type PlanOptions = {
  /** How long the walk from `from` (null: unknown) to `to` takes on a canvas; the default measures between the nodes' centres. */
  walk?: (canvas: string, from: string | null, to: string) => number;
  /** The node a canvas is entered by from the canvas above (../workstation/scenePlaces.ts `entranceOf`), when known. */
  entrance?: (canvas: string) => string | null;
  /** Who watches is not who worked: the person's steps are the author's (a guest of a share), not "你". */
  author?: boolean;
};

const actorKey = (a: Actor) => (a.kind === "you" ? "you" : a.agent || "agent");

/** Where each node is (its centre), as of the last version any step gives it: for a walk's length. */
function centres(tl: BuildTimeline): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const see = (canvas: string, e: El) => out.set(`${canvas}/${e.id}`, { x: e.x + e.width / 2, y: e.y + e.height / 2 });
  for (const [canvas, els] of Object.entries(tl.start)) els.forEach((e) => see(canvas, e));
  for (const s of tl.steps) for (const it of s.items) [...(it.add ?? []), ...(it.change ?? [])].forEach((e) => see(s.canvas, e));
  return out;
}

/** A canvas and its ancestors, nearest first. */
function chainOf(tl: BuildTimeline, c: string): string[] {
  const out = [c];
  for (let p = tl.canvases[c]?.parent?.canvas; p && !out.includes(p); p = tl.canvases[p]?.parent?.canvas) out.push(p);
  return out;
}

/**
 * How long the figure takes from `here` (a place on canvas `a`) to `to` on canvas `b`: up through the canvases below the common one (walk to each
 * one's entrance, a door up), then down (walk to the node that opens the next canvas, a door down), then the last walk to the place.
 * Without geometry each walk is a settle and a door.
 */
function journeyMs(tl: BuildTimeline, a: string, here: string | null, b: string, to: string, walk: NonNullable<PlanOptions["walk"]>, entrance: NonNullable<PlanOptions["entrance"]>): number {
  const ca = chainOf(tl, a);
  const cb = chainOf(tl, b);
  const common = ca.find((c) => cb.includes(c));
  let ms = 0;
  let at = here;
  for (const c of ca.slice(0, common == null ? ca.length : ca.indexOf(common))) {
    const gate = entrance(c);
    ms += (gate ? walk(c, at, gate) : SETTLE_MS) + DOOR_MS;
    at = tl.canvases[c]?.parent?.node ?? null;
  }
  const at0 = common ?? cb[cb.length - 1];
  let cur = common == null ? null : at;
  for (const c of cb.slice(0, common == null ? cb.length : cb.indexOf(common)).reverse()) {
    const parent = tl.canvases[c]?.parent;
    const from = parent?.canvas ?? at0;
    ms += (parent && cur ? walk(from, cur, parent.node) : SETTLE_MS) + DOOR_MS;
    cur = entrance(c);
  }
  return ms + (cur ? walk(b, cur, to) : SETTLE_MS);
}

export function planBuild(tl: BuildTimeline, opts: PlanOptions = {}): Plan {
  const at = centres(tl);
  const walk =
    opts.walk ??
    ((canvas: string, from: string | null, to: string) => {
      const a = from ? at.get(`${canvas}/${from}`) : undefined;
      const b = at.get(`${canvas}/${to}`);
      return a && b ? SETTLE_MS + ((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * DETOUR) / WALK_PX_MS : SETTLE_MS;
    });
  const entrance = opts.entrance ?? (() => null);
  const beats: Beat[] = [];
  const where = new Map<string, { canvas: string; place: string | null }>();
  const actors = new Map<string, ActorInfo>();
  let t = OPENING_MS;
  for (const s of tl.steps) {
    const key = actorKey(s.actor);
    if (!actors.has(key)) actors.set(key, { key, agent: s.actor.kind === "you" ? (opts.author ? "author" : "you") : s.actor.agent, name: s.actor.kind === "you" ? (opts.author ? "作者" : "你") : s.actor.name });
    const from = where.get(key);
    for (const it of nearestFirst(s.items, from?.canvas === s.canvas ? from.place : null, (id) => at.get(`${s.canvas}/${id}`))) {
      const prev = beats[beats.length - 1];
      // links and the like change nothing on the canvas: one beat for a run of them (on one canvas: a beat's changes are that canvas's), no walking
      if (it.quiet && prev?.quiet && prev.actor === key && prev.canvas === s.canvas) {
        prev.say = tick(prev, it);
        prev.change.push(...(it.change ?? []));
        prev.step = s.i;
        continue;
      }
      const here = where.get(key);
      const to = it.quiet ? null : it.place;
      let ms = 0;
      if (to && here) ms = here.canvas !== s.canvas ? journeyMs(tl, here.canvas, here.place, s.canvas, to, walk, entrance) : here.place === to ? 0 : walk(s.canvas, here.place, to);
      const start = t;
      const land = start + ms + LAND_LEAD_MS;
      const end = land + DWELL[it.quiet ? "tick" : it.kind];
      beats.push({ i: beats.length, step: s.i, canvas: s.canvas, actor: key, kind: it.quiet ? "tick" : it.kind, say: it.say, place: to, quiet: it.quiet, start, land, end, add: [...(it.add ?? [])], change: [...(it.change ?? [])], remove: [...(it.remove ?? [])], ...(it.child ? { child: it.child } : {}) });
      if (to) where.set(key, { canvas: s.canvas, place: to });
      else if (!here) where.set(key, { canvas: s.canvas, place: null });
      t = end;
    }
  }
  return { beats, length: t + OPENING_MS, actors: [...actors.values()] };
}

/**
 * A change that draws many things draws them all at once; the order they are visited in is ours to choose: from where the figure stands, each time
 * the nearest one still to do — for runs of nodes, and of arrows, that keep their order relative to the other kinds.
 */
function nearestFirst(items: readonly BuildItem[], start: string | null, centre: (id: string) => { x: number; y: number } | undefined): BuildItem[] {
  const out: BuildItem[] = [];
  let here = start ? centre(start) : undefined;
  for (let i = 0; i < items.length; ) {
    let j = i + 1;
    while (j < items.length && items[j].kind === items[i].kind && !items[j].quiet && !items[i].quiet) j++;
    const run = items.slice(i, j);
    if ((items[i].kind === "add-node" || items[i].kind === "add-arrows") && run.length > 2) {
      const left = [...run];
      while (left.length) {
        let best = 0;
        if (here) {
          let d = Infinity;
          left.forEach((it, k) => {
            const c = it.place ? centre(it.place) : undefined;
            const dd = c ? Math.abs(c.x - here!.x) + Math.abs(c.y - here!.y) : Infinity;
            if (dd < d) [best, d] = [k, dd];
          });
        }
        const [pick] = left.splice(best, 1);
        out.push(pick);
        here = (pick.place ? centre(pick.place) : undefined) ?? here;
      }
    } else out.push(...run);
    i = j;
    if (run.length <= 2) here = (out[out.length - 1]?.place ? centre(out[out.length - 1].place!) : undefined) ?? here;
  }
  return out;
}

/** The sentence for a run of quiet beats: the one sentence, or how many. */
function tick(prev: Beat, it: BuildItem): string {
  const n = prev.change.length + (it.change?.length ?? 1);
  return it.kind === "link" && (prev.kind === "tick" || prev.kind === "link") ? `把 ${n} 个节点关联到代码` : `调整了 ${n} 处`;
}

/** Every canvas as it is after the last step: the geometry the walking is measured on (nothing is ever where it was not at the end, bar what was deleted). */
export function finalScenes(tl: BuildTimeline): Map<string, El[]> {
  const out = new Map<string, El[]>();
  for (const canvas of Object.keys(tl.canvases)) {
    const cur = new Map<string, El>((tl.start[canvas] ?? []).map((e) => [e.id, e]));
    for (const st of tl.steps) {
      if (st.canvas !== canvas) continue;
      for (const it of st.items) {
        for (const e of [...(it.add ?? []), ...(it.change ?? [])]) cur.set(e.id, e);
        for (const id of it.remove ?? []) cur.delete(id);
      }
    }
    out.set(canvas, zOrder(cur.values()));
  }
  return out;
}

/**
 * Every element of every canvas as it was last seen — also what is deleted later: the places the figures walk to. A figure goes to a node
 * before the node is drawn (it draws it when it gets there), so the geometry the walking is planned on has to know it from the start.
 */
export function everScenes(tl: BuildTimeline): Map<string, El[]> {
  const out = new Map<string, El[]>();
  for (const canvas of Object.keys(tl.canvases)) {
    const cur = new Map<string, El>((tl.start[canvas] ?? []).map((e) => [e.id, e]));
    for (const st of tl.steps) if (st.canvas === canvas) for (const it of st.items) for (const e of [...(it.add ?? []), ...(it.change ?? [])]) cur.set(e.id, e);
    out.set(canvas, zOrder(cur.values()));
  }
  return out;
}

// ——— what the canvas looks like at a moment ———

/** Elements bottom to top by Excalidraw's fractional index (the order they were given in when there is none). */
const zOrder = (els: Iterable<El>): El[] => [...els].sort((a, b) => Number(a.index == null) - Number(b.index == null) || String(a.index ?? "").localeCompare(String(b.index ?? "")));

/** Every canvas as it was before the first beat and after each one that changed it. */
export class Scenes {
  private snapshots = new Map<string, El[][]>();
  private lands = new Map<string, number[]>();
  constructor(tl: BuildTimeline, plan: Plan) {
    for (const canvas of Object.keys(tl.canvases)) {
      const cur = new Map<string, El>((tl.start[canvas] ?? []).map((e) => [e.id, e]));
      const snaps = [zOrder(cur.values())];
      const lands: number[] = [];
      for (const b of plan.beats) {
        if (b.canvas !== canvas) continue;
        for (const e of [...b.add, ...b.change]) cur.set(e.id, e);
        for (const id of b.remove) cur.delete(id);
        snaps.push(zOrder(cur.values()));
        lands.push(b.land);
      }
      this.snapshots.set(canvas, snaps);
      this.lands.set(canvas, lands);
    }
  }
  /** The elements of a canvas at play time `t`: what has landed by then. */
  at(canvas: string, t: number): El[] {
    const lands = this.lands.get(canvas) ?? [];
    let k = 0;
    while (k < lands.length && lands[k] <= t) k++;
    return this.snapshots.get(canvas)?.[k] ?? [];
  }
  /** How many changes to a canvas have landed by `t` (its scene version). */
  count(canvas: string, t: number): number {
    const lands = this.lands.get(canvas) ?? [];
    let k = 0;
    while (k < lands.length && lands[k] <= t) k++;
    return k;
  }
}

// ——— the figures ———

/** The code-link pattern the replay gives every node so the figure's places resolve like files do (../workstation/geometry.ts `locate`). */
export const pathFor = (canvas: string, node: string) => `build/${canvas}/${node}`;

const NODE_TYPES = new Set(["rectangle", "ellipse", "diamond", "frame"]);
/** A canvas's elements as the replay's overlay reads them: each node stands for a "file", so the figure can go to it (and into its sub-diagram). */
export function withPlaces(canvas: string, els: readonly El[]): El[] {
  return els.map((e) => (NODE_TYPES.has(e.type) && !(e as { containerId?: string | null }).containerId ? ({ ...e, customData: { ...(e.customData ?? {}), codePaths: [pathFor(canvas, e.id)] } } as El) : e));
}

/** One run per actor: every beat is a segment of "writing" at its node, with the words it says. */
export function runsOf(plan: Plan, epoch: number): WorkRun[] {
  return plan.actors.map((a) => {
    const segs: RunSeg[] = plan.beats
      .filter((b) => b.actor === a.key)
      .map((b) => ({ kind: b.quiet ? "think" : "write", start: epoch + b.start, end: epoch + b.end, label: b.say, say: b.say, ...(b.place && !b.quiet ? { path: pathFor(b.canvas, b.place) } : {}) }));
    return { id: `build:${a.key}`, agent: a.agent, name: a.name, segs, receipts: [], running: false, lastAt: epoch + plan.length, children: [] };
  });
}

/** The first beat of step `step` of the timeline (a comment's moment), or the last one when the timeline is shorter now. */
export function beatOfStep(plan: Plan, step: number): Beat | undefined {
  return plan.beats.find((b) => b.step >= step) ?? plan.beats[plan.beats.length - 1];
}

/** The beat going on at play time `t` (the first before the opening, the last after the end). */
export function beatAt(plan: Plan, t: number): Beat | undefined {
  let cur = plan.beats[0];
  for (const b of plan.beats) {
    if (b.start > t) break;
    cur = b;
  }
  return cur;
}

/** The speeds the player offers, and the slowest of them that plays the whole build in about `target` ms (the way a person would wish to see it first). */
export const SPEEDS = [1, 2, 4, 8, 16];
export const defaultSpeed = (length: number, target = 90_000): number => SPEEDS.find((s) => length / s <= target) ?? SPEEDS[SPEEDS.length - 1];
