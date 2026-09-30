// How much of a replay is walking, and how much of that walking is for nothing (web/docs/share-build-replay.md §9). Pure: it reads a plan.
import { centres, REACH_PX, type Beat, type Plan } from "./plan";
import type { BuildTimeline } from "./types";

/**
 * A trip is a beat the figure walked to (it set off from another place). It is **for nothing** when
 * - `near`: what it went for (the node the thing is at) was within reach (`REACH_PX`) of where it stood — it could have drawn it from there; or
 * - `back`: it goes back to within reach of where it stood two trips before, after a trip away — it wandered A → B → A.
 * The rest is `needed`: the next thing was out of reach and had not been near before.
 */
export type TripKind = "needed" | "near" | "back";
export type Trip = { beat: number; canvas: string; kind: TripKind; ms: number; dist: number };
export type WalkStats = {
  trips: Trip[];
  /** Cuts (brief mode): trips too long to walk, and how far they jumped (world px). */
  cuts: { count: number; px: number };
  /** Everything counted in ms of walking, in world px between the nodes (same canvas), and the number of trips, by kind. */
  ms: Record<TripKind | "all", number>;
  px: Record<TripKind | "all", number>;
  count: Record<TripKind | "all", number>;
  /** The share of walking time that is for nothing (near + back). */
  uselessShare: number;
  /** Play time of the whole replay at 1× (ms), and how much of it is walking. */
  length: number;
};

export function walkStats(plan: Plan, tl: BuildTimeline, reach = REACH_PX): WalkStats {
  const at = centres(tl);
  const centre = (canvas: string, id: string) => at.get(`${canvas}/${id}`);
  const trips: Trip[] = [];
  const cuts = plan.beats.filter((b) => b.hop);
  const last = new Map<string, Beat[]>(); // per actor: the trips it made
  for (const b of plan.beats) {
    if (b.walkMs <= 0 || b.hop || b.reach || !b.at || !b.from || b.fromCanvas !== b.canvas) continue;
    const mine = last.get(b.actor) ?? [];
    const to = centre(b.canvas, b.at);
    const twoAgo = mine.length >= 1 ? mine[mine.length - 1] : undefined; // the trip before this one began at the place two trips back
    const back = twoAgo?.from && to && twoAgo.fromCanvas === b.canvas ? centre(b.canvas, twoAgo.from) : undefined;
    const thing = b.place ? centre(b.canvas, b.place) : undefined;
    const stood = centre(b.canvas, b.from);
    const kind: TripKind = thing && stood && Math.hypot(thing.x - stood.x, thing.y - stood.y) <= reach ? "near" : back && to && Math.hypot(back.x - to.x, back.y - to.y) <= reach ? "back" : "needed";
    trips.push({ beat: b.i, canvas: b.canvas, kind, ms: b.walkMs, dist: b.dist });
    mine.push(b);
    last.set(b.actor, mine);
  }
  const zero = () => ({ all: 0, needed: 0, near: 0, back: 0 });
  const ms = zero();
  const px = zero();
  const count = zero();
  for (const t of trips) for (const k of [t.kind, "all"] as const) [ms[k], px[k], count[k]] = [ms[k] + t.ms, px[k] + t.dist, count[k] + 1];
  return { trips, cuts: { count: cuts.length, px: cuts.reduce((n, b) => n + b.dist, 0) }, ms, px, count, uselessShare: ms.all ? (ms.near + ms.back) / ms.all : 0, length: plan.length };
}
