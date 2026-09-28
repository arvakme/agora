// Gestures (web/docs/workstation.md §小人): what a worker does on top of its pose — it lands when it is
// dispatched, looks down at the node when it gets there, hands the page over (and its dispatcher takes
// it and nods), waves now and then while it waits (and at the person when they come back), stretches
// and then sits on the node's edge when idle a long while, looks at the pointer, waves back when
// clicked, turns and nods when talked to, glances at the other writer before the recoil, and the
// screen flashes when a file is saved. `gesture` is a pure function of the pose, how long it has been
// in it, the time and a few events; springs (./rig.ts solve; ./figureNode.ts for the head's look) only
// smooth the result.
//
// Timeline events (a dispatch, an arrival, a handover, idle time, a save, a conflict) are measured on
// the timeline, so replaying to a moment gives the same gestures. Loops (the wait wave) and page events
// (attention, a click, talk) run on the animation clock the overlay passes (`wall`, slowed down in a
// slow replay) — never on Date.now(). With reduced motion nothing animates; lasting states (the page
// has changed hands, sitting) still show.
import { agents } from "../session/agents";
import { attention } from "./attention";
import { focus } from "./focus";
import { execResults, type ExecResult } from "./outcome";
import { HANDOFF_MS, IDLE_LEAVE_MS, OUTSIDE, stateAt, type Ctx, type RunState, type WriteConflict } from "./place";
import { RIG, type Pose, type Prop, type Pt } from "./rig";
import type { RunSeg, WorkRun } from "./runs/types";
import { talk } from "./talk";

export type GestureIn = {
  pose: Pose;
  /** ms into the current segment (timeline). */
  since: number;
  /** Timeline time (ms). The timeline events below are on it, so replaying to a moment gives the same gestures. */
  t: number;
  /** Animation time (ms): loops and page events (attention, click, talk) run on it. */
  wall: number;
  /** Reduced motion: nothing animates; lasting states (sitting) still show. */
  still: boolean;
  /** A sub-agent: when it was dispatched (it lands beside its dispatcher). */
  spawnAt?: number | null;
  /** When its last trip ended (it looks down at the node first; a handoff starts then). */
  arrivedAt?: number | null;
  /** A top-level worker with nothing to do: for how long (ms). */
  idleFor?: number | null;
  /** New work after a long rest: when it started (it gets up first). */
  roseAt?: number | null;
  /** When a write just ended (it saves: hands off the keyboard, the screen flashes). */
  savedAt?: number | null;
  /** A command just finished at `at`, and whether it went well (./outcome.ts): the terminal shows it. */
  ran?: { at: number; ok: boolean } | null;
  /** A sub-agent hands something over, from its return at `at`, standing `dx` figure units away along world x. */
  receive?: { at: number; dx: number } | null;
  /** Writing the same file as another since `at`; the other stands `dx` figure units away along world x. */
  conflict?: { at: number; dx: number } | null;
  /** Page events on the animation clock: the page became visible again; clicked; talked to. */
  attentionAt?: number | null;
  clickAt?: number | null;
  talkAt?: number | null;
  /** Under the pointer: where it is (figure space: from the feet, world axes, up is −), or just hovered. */
  hover?: Pt | true | null;
  /** A comment's turn ended (it answered) at this moment on the timeline: it nods once. */
  answeredAt?: number | null;
  /** Nothing to sit on where it stands (the 图外 tray, no node): it stands or stretches, never sits. */
  noSeat?: boolean;
};

/** What gestures add over a pose. Hand targets are from the shoulder, x along the facing (figure units). */
export type Gesture = {
  /** A hand target taking over from the pose's by a weight (0 … 1)… */
  near?: readonly [number, number];
  nearW?: number;
  far?: readonly [number, number];
  farW?: number;
  /** …or an offset added to wherever the hand is going. */
  nearAdd?: readonly [number, number];
  farAdd?: readonly [number, number];
  /** Added to the pose's lean and head tilt (degrees; tilt > 0 looks down). */
  lean?: number;
  tilt?: number;
  /** The hips lowered, figure units (the knees bend). */
  crouch?: number;
  /** Sitting on the node's top edge, by `w` (0 … 1): hips `hip` above it, feet out over it (x along the facing). */
  sit?: { w: number; hip: number; feet: readonly [Pt, Pt] };
  /** Faces this way (world x) for the moment. */
  face?: 1 | -1;
  /** Faces the other way for the moment. */
  turn?: boolean;
  /** What is in its hands, over the pose's (null: nothing). */
  prop?: Prop;
  /** The conflict recoil, 0 … 1 (replaces the overlay's). */
  bump?: number;
  /** Drawing: the whole figure scaled about its feet and raised (a landing). */
  scale?: number;
  lift?: number;
  /** Drawing: the head turned toward this point (figure space). */
  look?: Pt | null;
  /** Drawing: the screen flashing (a save), 0 … 1. */
  flash?: number;
  /** Drawing: the terminal lit with a command's verdict, ✓ or ✗, shown by `a` (0 … 1). */
  result?: { ok: boolean; a: number };
  /** Drawing: a page in the near hand beside whatever prop it has (taking one at its desk), shown by 0 … 1… */
  hold?: number;
  /** …on its way there from `holdFrom` (figure space: the hand that gives it), `holdU` of the way (0 … 1). */
  holdFrom?: Pt;
  holdU?: number;
};

// Timings (ms), from the brief: a landing about 400 ms, a look down about 300 ms, a small wave every
// 6–8 s, a wave at the person about 1.2 s, a stretch at 20 s idle and a seat at 40 s.
const LAND_MS = 400;
const TOUCH_MS = 220;
const LOOK_MS = 300;
const GIVE_MS = 550; // into a handover, the page changes hands…
const PASS_MS = 260; // …passing from one hand to the other
const KEEP_MS = 400; // …and the dispatcher keeps holding it a little after
const WAVE_EVERY = 7000; // ± 500: 6–8 s apart
const WAVE_MS = 1100;
const HELLO_MS = 1200;
const STRETCH_AT = 20_000;
const STRETCH_MS = 1800;
export const SIT_AT = 40_000;
const SIT_MS = 1200;
const STAND_MS = 400;
const TALK_MS = 1400;
const CLASH_LOOK_MS = 600;
const SAVE_MS = 450;
const FLASH_MS = 300;
const RESULT_MS = 1000;
const NOD_MS = 700;

/** Loom's hand positions are for its arm (19.4 long): scaled to ours. */
const ARM = (RIG.upper + RIG.fore) / 19.4;
const L = (x: number, y: number): [number, number] => [x * ARM, y * ARM];
/** Sitting on the node's top edge: hips just above it, thighs out, shins over the edge, hands propped behind. */
const SIT = { hip: 3.2, feet: [{ x: 12, y: 11.5 }, { x: 10, y: 12 }] as const, near: [-1.5, 15.8] as const, far: [-3.2, 15.9] as const };

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const mix = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (x: number) => {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
};
/** 0 → 1 → 0 over [a, d]: up over [a, b], held, down over [c, d]. */
const env = (x: number, a: number, b: number, c: number, d: number) => (x <= a || x >= d ? 0 : x < b ? smooth((x - a) / (b - a)) : x <= c ? 1 : 1 - smooth((x - c) / (d - c)));
/** A sine hump over [a, b]. */
const hump = (x: number, a: number, b: number) => (x <= a || x >= b ? 0 : Math.sin((Math.PI * (x - a)) / (b - a)));

/** A hand target over what is there, by w (layered: the later one on top). */
function hand(G: Gesture, which: "near" | "far", p: readonly [number, number], w: number) {
  if (w <= 0) return;
  const kw = which === "near" ? "nearW" : "farW";
  const prev = G[which];
  const pw = G[kw] ?? 0;
  if (!prev || !pw) {
    G[which] = p;
    G[kw] = w;
    return;
  }
  const W = 1 - (1 - pw) * (1 - w);
  G[which] = [(prev[0] * pw * (1 - w) + p[0] * w) / W, (prev[1] * pw * (1 - w) + p[1] * w) / W];
  G[kw] = W;
}
/** An offset added to a hand. */
function nudge(G: Gesture, which: "near" | "far", dx: number, dy: number) {
  const k = which === "near" ? "nearAdd" : "farAdd";
  const a = G[k] ?? [0, 0];
  G[k] = [a[0] + dx, a[1] + dy];
}
const add = (G: Gesture, k: "lean" | "tilt", v: number) => void (v && (G[k] = (G[k] ?? 0) + v));
function seat(G: Gesture, w: number) {
  G.sit = { w, hip: SIT.hip, feet: SIT.feet };
  hand(G, "near", SIT.near, w);
  hand(G, "far", SIT.far, w);
  add(G, "lean", -6 * w);
  add(G, "tilt", 3 * w);
}

/** A number in [0, 1) from an integer (the wait wave's irregular spacing, the same on every machine). */
function hash(n: number): number {
  let x = Math.imul(n ^ 0x2545f491, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
/** The n-th small wave while waiting starts here on the animation clock: 7 s apart ± 0.5 s. */
const waveStart = (n: number) => n * WAVE_EVERY + (hash(n) - 0.5) * 1000;

/** The gestures at this moment (pure). */
export function gesture(g: GestureIn): Gesture {
  const G: Gesture = {};
  const anim = !g.still;
  const walking = g.pose === "walk";
  const desk = g.pose === "write" || g.pose === "exec";

  // Dispatched: small and a little above the ground, it drops, touches down, bends its knees, stands.
  // (Before its dispatch it is not drawn; it is simply not landed yet: small, up there.)
  if (anim && g.spawnAt != null) {
    const a = Math.max(0, g.t - g.spawnAt);
    if (a < LAND_MS) {
      G.scale = mix(0.55, 1, smooth(a / 200));
      G.lift = a < TOUCH_MS ? 7 * (1 - (a / TOUCH_MS) ** 2) : 0;
      G.crouch = 2.6 * hump(a, TOUCH_MS, LAND_MS);
      const w = 0.7 * hump(a, 0, LAND_MS); // arms out a little for balance
      hand(G, "near", L(5, 12), w);
      hand(G, "far", L(-3, 12), w);
    }
  }

  // Arrived: a look down at the node before the work starts (a sub-agent back to hand over does not stop).
  // The hands stay hanging as they were while walking — only then go to the work.
  if (anim && g.arrivedAt != null && !walking && g.pose !== "handoff") {
    const a = g.t - g.arrivedAt;
    const w = a < 0 ? 0 : 1 - smooth((a - LOOK_MS) / 150);
    if (w > 0) {
      add(G, "tilt", 16 * env(a, 0, 80, LOOK_MS, LOOK_MS + 150));
      hand(G, "near", L(1.5, 18.2), w);
      hand(G, "far", L(-1, 18.4), w);
    }
  }

  // Handing over: it lets go of the page as its dispatcher takes it, then lowers its hands.
  if (g.pose === "handoff" && g.arrivedAt != null) {
    const a = g.t - g.arrivedAt;
    if (a >= GIVE_MS) {
      G.prop = null;
      if (anim) {
        const w = smooth((a - GIVE_MS - 100) / 300);
        hand(G, "near", L(8, 12), w);
        hand(G, "far", L(6, 13), w);
      }
    }
  }
  // Taking it: the dispatcher turns to the sub-agent if it stands behind, reaches out, takes the page, nods.
  if (g.receive && !walking) {
    const a = g.t - g.receive.at;
    if (a >= 0 && a < HANDOFF_MS + KEEP_MS) {
      // at its desk the desk stays up: the page is drawn in its hand beside it
      if (desk) G.hold = g.still ? (a >= GIVE_MS ? 1 : 0) : env(a, GIVE_MS, GIVE_MS + 120, HANDOFF_MS + KEEP_MS - 150, HANDOFF_MS + KEEP_MS);
      else if (a >= GIVE_MS) G.prop = "carry";
      // the page goes from the sub-agent's hand to its own: from where the sub-agent (drawn SUB_SCALE
      // smaller) holds it out, at its chest, into its own hand
      if (anim && a >= GIVE_MS && a < GIVE_MS + PASS_MS) {
        if (!desk) G.hold = env(a, GIVE_MS, GIVE_MS + 60, GIVE_MS + PASS_MS - 40, GIVE_MS + PASS_MS);
        G.holdFrom = { x: g.receive.dx - Math.sign(g.receive.dx) * 10.6, y: -25.7 };
        G.holdU = smooth((a - GIVE_MS) / (PASS_MS - 40));
      }
      if (anim) {
        if (g.receive.dx < -2) G.face = -1;
        hand(G, "near", [clamp(Math.abs(g.receive.dx) * 0.55, 8, 16), 7], env(a, 80, 450, 700, 1000));
        add(G, "tilt", 12 * hump(a, 650, 1050));
      }
    }
  }

  // Waiting for the person: a small wave every 6–8 s; a bigger one at them when they come back.
  if (anim && g.pose === "wait") {
    let n = Math.floor(g.wall / WAVE_EVERY) + 1;
    while (waveStart(n) > g.wall) n--;
    const a = g.wall - waveStart(n);
    if (a < WAVE_MS) nudge(G, "near", 1.8 * Math.sin((2 * Math.PI * a) / 420) * hump(a, 0, WAVE_MS), 0);
    if (g.attentionAt != null) {
      const b = g.wall - g.attentionAt;
      const e = hump(b, 0, HELLO_MS);
      if (e > 0) {
        nudge(G, "near", 5 * Math.sin((2 * Math.PI * b) / 380) * e, -2.5 * e);
        add(G, "tilt", -8 * e);
      }
    }
  }

  // Idle a long while: a stretch at 20 s; from 40 s it sits on the node's top edge.
  if (g.pose === "idle" && g.idleFor != null) {
    const a = g.idleFor;
    if (anim) {
      const w = env(a - STRETCH_AT, 0, 600, 1100, STRETCH_MS);
      if (w > 0) {
        hand(G, "near", L(2.6, -19), w);
        hand(G, "far", L(0.6, -19), w);
        add(G, "lean", -4 * w);
        add(G, "tilt", -12 * w);
      }
    }
    const s = g.still ? (a >= SIT_AT ? 1 : 0) : smooth((a - SIT_AT) / SIT_MS);
    if (s > 0 && !g.noSeat) seat(G, s);
  }
  // New work after that long rest: it gets up first.
  if (g.roseAt != null && g.pose !== "idle" && !g.still && !g.noSeat) {
    const s = 1 - smooth((g.t - g.roseAt) / STAND_MS);
    if (g.t >= g.roseAt && s > 0) seat(G, s);
  }

  // Under the pointer: it looks at it (just hovered, e.g. its lane: it looks up out of the picture).
  if (anim && g.hover) G.look = g.hover === true ? { x: 30, y: -95 } : g.hover;

  // Clicked: it raises a hand and waves back.
  if (anim && g.clickAt != null) {
    const a = g.wall - g.clickAt;
    if (a >= 0 && a < HELLO_MS) {
      hand(G, "near", L(5.6, -17.2), env(a, 0, 220, HELLO_MS - 250, HELLO_MS));
      nudge(G, "near", 3 * Math.sin((2 * Math.PI * a) / 400) * hump(a, 150, HELLO_MS - 100), 0);
    }
  }

  // Talked to: it turns round and nods twice (at its desk it nods without turning away from it).
  if (anim && g.talkAt != null) {
    const a = g.wall - g.talkAt;
    if (a >= 0 && a < TALK_MS) {
      if (!walking && !desk) G.turn = true;
      add(G, "tilt", 12 * (hump(a, 300, 650) + hump(a, 700, 1050)));
    }
  }

  // A comment answered: one nod as the pin gets its check (timeline time, so a replay nods at the same moment).
  if (anim && g.answeredAt != null) add(G, "tilt", 12 * hump(g.t - g.answeredAt, 0, NOD_MS));

  // Two writers on one file: a look at the other, hands off the keys; then the recoil.
  if (g.conflict) {
    const a = g.t - g.conflict.at;
    G.bump = 0;
    if (anim && a >= 0) {
      if (a < CLASH_LOOK_MS) G.look = { x: g.conflict.dx, y: -(RIG.hip + RIG.torso + RIG.head) };
      const w = env(a, 0, 120, CLASH_LOOK_MS, CLASH_LOOK_MS + 150);
      if (w > 0) {
        nudge(G, "near", 0, -1.5 * w);
        nudge(G, "far", 0, -1.5 * w);
      }
      G.bump = hump(a, CLASH_LOOK_MS, CLASH_LOOK_MS + 800);
    }
  }

  // A file written: the hands come off the keyboard and the screen flashes; the desk stays up for it.
  if (anim && g.savedAt != null && !walking) {
    const a = g.t - g.savedAt;
    if (a >= 0 && a < SAVE_MS) {
      if (G.prop === undefined) G.prop = "laptop";
      G.flash = hump(a, 0, FLASH_MS);
      const w = env(a, 0, 100, 250, SAVE_MS);
      nudge(G, "near", -2.2 * w, -2.4 * w);
      nudge(G, "far", -2 * w, -2.2 * w);
      add(G, "lean", -1.5 * w);
    }
  }

  // A command finished: its verdict lights the terminal for about a second (with reduced motion too: it is a state).
  if (g.ran && !walking) {
    const a = g.t - g.ran.at;
    if (a >= 0 && a < RESULT_MS) {
      if (G.prop === undefined) G.prop = "terminal";
      G.result = { ok: g.ran.ok, a: g.still ? 1 : env(a, 0, 120, RESULT_MS - 200, RESULT_MS) };
    }
  }
  return G;
}

// ── The overlay's side: one worker's events this frame ──

/** A top-level run's finished commands and how they went, from its session's transcript on the page
 * (a sub-agent's is not kept there): computed again only when the transcript changes. */
const verdictMemo = new WeakMap<WorkRun, { items: unknown; map: Map<RunSeg, ExecResult> }>();
function verdicts(run: WorkRun): Map<RunSeg, ExecResult> | null {
  const items = run.sessionId ? agents.get().items[run.sessionId] : undefined;
  if (!items) return null;
  let m = verdictMemo.get(run);
  if (!m || m.items !== items) verdictMemo.set(run, (m = { items, map: execResults(run, items) }));
  return m.map;
}

/** Page events seen so far, stamped with the animation time of the first frame that saw them (so they
 * play at the figures' pace). What was already there before the first frame is not an event. */
let page: { attention: unknown; attentionAt: number | null; talk: unknown; talkAt: number | null; selected: string | null; selectedAt: number | null } | null = null;
function pageEvents(wall: number) {
  const a = attention.get();
  const tk = talk.get();
  const sel = focus.get().selected;
  if (!page) page = { attention: a, attentionAt: null, talk: tk, talkAt: null, selected: sel, selectedAt: null };
  if (a !== page.attention) Object.assign(page, { attention: a, attentionAt: a ? wall : null });
  if (tk !== page.talk) Object.assign(page, { talk: tk, talkAt: tk ? wall : null });
  if (sel !== page.selected) Object.assign(page, { selected: sel, selectedAt: sel ? wall : null });
  return page;
}

/**
 * One worker's gestures this frame, from its run and state (as the overlay has them) and the page's
 * events. `k`: world px per figure unit as drawn; `positions`: where each figure stood last frame;
 * `pointer`: the pointer over this figure in figure space (./figureNode.ts keeps it), if any.
 */
export function gestureFor(o: { run: WorkRun; st: RunState; t: number; wall: number; still: boolean; k: number; ctx: Ctx; positions: ReadonlyMap<string, Pt>; conflict: WriteConflict | null; pointer?: Pt | null }): Gesture {
  const { run, st, t } = o;
  const pe = pageEvents(o.wall);
  const me = o.positions.get(run.id);
  const along = (id: string) => {
    const p = o.positions.get(id);
    return me && p ? (p.x - me.x) / o.k : null;
  };
  let idleFor: number | null = null;
  let roseAt: number | null = null;
  if (!run.parentId) {
    let last = -Infinity;
    let before = -Infinity;
    for (const s of run.segs) {
      if (s.start <= t) last = Math.max(last, s.end);
      if (st.seg && s !== st.seg && s.end <= st.seg.start) before = Math.max(before, s.end);
    }
    if (!st.seg && Number.isFinite(last)) idleFor = t - last;
    // got up from a seat: the rest before this work was long enough to sit, not so long that it had left
    if (st.seg && st.seg.start - before >= SIT_AT && st.seg.start - before <= IDLE_LEAVE_MS) roseAt = st.seg.start;
  }
  let savedAt: number | null = null;
  for (let i = run.segs.length - 1; i >= 0; i--) {
    const s = run.segs[i];
    if (s.kind !== "write" || s.end > t) continue;
    if (t - s.end < SAVE_MS) savedAt = s.end;
    break;
  }
  let ran: GestureIn["ran"] = null;
  for (let i = run.segs.length - 1; i >= 0; i--) {
    const s = run.segs[i];
    if (s.kind !== "exec" || s.end > t) continue;
    const r = t - s.end < RESULT_MS ? verdicts(run)?.get(s) : undefined;
    if (r) ran = { at: s.end, ok: r.ok };
    break;
  }
  let receive: GestureIn["receive"] = null;
  for (const c of run.children) {
    const cs = stateAt(c, t, o.ctx);
    const dx = cs.handoff && cs.trip ? along(c.id) : null;
    if (cs.trip && dx != null) receive = { at: cs.trip.t1, dx };
  }
  const other = o.conflict?.runs.find((id) => id !== run.id);
  const cdx = other != null ? along(other) : null;
  return gesture({
    pose: st.pose,
    since: st.since,
    t,
    wall: o.wall,
    still: o.still,
    spawnAt: run.parentId ? (run.spawnAt ?? null) : null,
    arrivedAt: st.trip && t >= st.trip.t1 ? st.trip.t1 : null,
    idleFor,
    roseAt,
    savedAt,
    ran,
    receive,
    conflict: o.conflict && st.seg ? { at: o.conflict.start, dx: cdx ?? 30 } : null,
    attentionAt: pe.attentionAt,
    clickAt: pe.selected === run.id ? pe.selectedAt : null,
    talkAt: (pe.talk as { runId?: string } | null)?.runId === run.id ? pe.talkAt : null,
    hover: focus.get().hovered === run.id ? (o.pointer ?? true) : null,
    answeredAt: st.answered?.end ?? null,
    noSeat: st.at === OUTSIDE,
  });
}
