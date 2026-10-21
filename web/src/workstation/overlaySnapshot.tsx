// The structure half of the 工位视图 overlay (./Overlay.tsx): `snapshot` decides which figures,
// bubbles, rings, tethers and chips exist at a time t (a few times a second at most, never per frame),
// plus the small SVG shapes and bubble text it is built from. Pure apart from the door-trip cache.
import { type ReactNode } from "react";
import { IconCheck, IconCode, IconCpu, IconEye, IconMessage, IconPath, IconSend, IconTerminal } from "../app/icons";
import { type Viewport } from "../canvas/viewport";
import { ui } from "../session/ui";
import { pickBubbles, slots } from "./crowd";
import { type Geometry } from "./geometry";
import { hatchesAt, ladderShape, LADDER_HALF, type Hatch, type Peek } from "./hatch";
import { conflictAt, OUTSIDE, stateAt, type Ctx, type RunState, type Side, type WriteConflict } from "./place";
import { planDoor, type Pt, type Trip } from "./rig";
import type { Leg } from "./route";
import { RunAvatar } from "./RunAvatar";
import { pathLabel } from "./runs/nodePath";
import { type Runs } from "./runs/store";
import { receiptText, type FlatRun } from "./runs/types";
import { DISPATCH } from "./runs/derive";
import { lang, tr } from "../i18n";
import { latestTurnWindow, pointAt, spanOf, traceAt, type Trace, type TurnWindow } from "./trace";
import "./workstation.css";

export const SNAP_MS = 250;
export const BUBBLE_EXIT_MS = 120;
export const RING_EXIT_MS = 300;
export const pad2 = (n: number) => String(n).padStart(2, "0");
export const secs = (ms: number) => {
  const v = ms < 10_000 ? (ms / 1000).toFixed(1).replace(/\.0$/, "") : String(Math.round(ms / 1000));
  return tr(`${v} 秒`, `${v}s`);
};
export const OFF = tr("图外", "Off the diagram");
export const NODE = tr("节点", "node");
export const base = (p: string) => p.split("/").pop() || p;
export const vkOf = (v: Viewport) => `${v.scrollX}|${v.scrollY}|${v.zoom}|${v.width}|${v.height}`;
export const px = (n: number) => n.toFixed(2);
export const hhmmss = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export type Fig = { f: FlatRun; place: string; slot: number };
export type Snap = {
  t: number;
  figs: Fig[];
  bubbles: string[];
  /** Node rings, with the runs that make each (a trace dims the rings of the others). */
  rings: { place: string; tone: RingTone; ids: string[] }[];
  tethers: { child: string; parent: string }[];
  chips: { place: string; ids: string[] }[];
  states: Map<string, RunState>;
  byId: Map<string, FlatRun>;
  /** Deeper sub-agents folded into the +N over their depth-1 ancestor. */
  folded: Map<string, number>;
  tray: boolean;
  /** Trips being walked (or about to be, or just done): their bridges and ladders are drawn. */
  trips: { key: string; run: string; trip: Trip; sel: boolean }[];
  /** 追踪: the traced run's way on this canvas (./trace.ts), when one is traced. */
  trace: Trace | null;
  /** The ladders and holes to draw at doors (./hatch.ts), and whose head looks out of each hole. */
  hatches: Hatch[];
  peeks: Peek[];
};
export const EMPTY: Snap = { t: 0, figs: [], bubbles: [], rings: [], tethers: [], chips: [], states: new Map(), byId: new Map(), folded: new Map(), tray: false, trips: [], trace: null, hatches: [], peeks: [] };
/** 追踪: the others dim to this; a trace's line draws itself in over DRAW_MS as it starts, and fades out over TRACE_EXIT_MS as it ends. */
export const DIM = 0.3;
export const DRAW_MS = 650;
export const TRACE_EXIT_MS = 200;
/** The traced run and its sub-agents (all depths): who stays as it is while the others dim. Null when nothing (known) is traced. */
export function keepOf(runs: Runs, traced: string | null): Set<string> | null {
  if (!traced || !runs.byId.has(traced)) return null;
  const byId = new Map(runs.flat.map((f) => [f.run.id, f]));
  const keep = new Set([traced]);
  for (const f of runs.flat)
    for (let p = f.parent; p; p = byId.get(p.id)?.parent ?? null)
      if (p.id === traced) {
        keep.add(f.run.id);
        break;
      }
  return keep;
}
/** A way's line: its legs, walked `d` world px of them. */
export function partial(legs: readonly Leg[], d: number): string {
  if (!legs.length || d <= 0.05) return "";
  let s = `M${px(legs[0].a.x)} ${px(legs[0].a.y)}`;
  let left = d;
  for (const l of legs) {
    const n = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    if (left <= n) {
      const p = pointAt([l], left);
      return `${s}L${px(p.x)} ${px(p.y)}`;
    }
    s += `L${px(l.b.x)} ${px(l.b.y)}`;
    left -= n;
  }
  return s;
}
/** A sub-agent's errand: dashed curves through the places it had reached, out on one side and back on
 * the other; `mid`: halfway along the first one (where its avatar sits, clear of the nodes). */
export function errand(pts: readonly Pt[]): { d: string; mid: Pt | null } {
  if (pts.length < 2) return { d: "", mid: null };
  const bend = -0.22;
  const ctl = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2 - (b.y - a.y) * bend, y: (a.y + b.y) / 2 + (b.x - a.x) * bend });
  let d = `M${px(pts[0].x)} ${px(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const c = ctl(pts[i - 1], pts[i]);
    d += `Q${px(c.x)} ${px(c.y)} ${px(pts[i].x)} ${px(pts[i].y)}`;
  }
  const c = ctl(pts[0], pts[1]);
  return { d, mid: { x: 0.25 * pts[0].x + 0.5 * c.x + 0.25 * pts[1].x, y: 0.25 * pts[0].y + 0.5 * c.y + 0.25 * pts[1].y } };
}
/** A trip's bridges and ladders fade in over TRIP_IN_MS as it starts and out over TRIP_OUT_MS after it ends. */
export const TRIP_IN_MS = 200;
export const TRIP_OUT_MS = 300;
/** The snapshot builds a trip's drawing this long before it starts (it is rebuilt only every SNAP_MS). */
export const TRIP_AHEAD_MS = 400;
export const tripAlpha = (p: Trip, t: number) => Math.max(0, Math.min(1, (t - p.t0) / TRIP_IN_MS, 1 - (t - p.t1) / TRIP_OUT_MS));

/**
 * Structure at time t: who is on the canvas, where, who gets a bubble, which nodes get a stroke. Pure.
 * `traced`: the run being traced (it keeps a bubble; its way is worked out here unless `route` is
 * false; `now`: what has happened by — in a replay the stops after t up to now show, not yet reached).
 * `only`: draw just these runs (../buildreplay).
 */
export function snapshot(runs: Runs, t: number, ctx: Ctx, conflicts: WriteConflict[], figuresOn: boolean, selected: string | null, o: { traced?: string | null; followed?: string | null; turn?: TurnWindow | null; only?: (runId: string) => boolean; route?: boolean; now?: number } = {}): Snap {
  const states = new Map<string, RunState>();
  const present: FlatRun[] = [];
  const byId = new Map(runs.flat.map((f) => [f.run.id, f]));
  const folded = new Map<string, number>();
  for (const f of runs.flat) {
    const st = stateAt(f.run, t, ctx);
    states.set(f.run.id, st);
    if (o.only && !o.only(f.run.id)) continue;
    // looks ahead one snapshot: a figure that is about to be present is built now, so the first 250 ms of a door's animation are not lost
    if (!st.present && !stateAt(f.run, t + SNAP_MS, ctx).present) continue;
    if (f.depth >= 2) {
      // One level of sub-agents is drawn; deeper ones fold into a +N over their depth-1 ancestor.
      let p: FlatRun | undefined = f;
      while (p && p.depth > 1) p = p.parent ? byId.get(p.parent.id) : undefined;
      if (p) folded.set(p.run.id, (folded.get(p.run.id) ?? 0) + 1);
      continue;
    }
    present.push(f);
  }
  const need = (f: FlatRun) => states.get(f.run.id)!.seg?.kind === "wait" || !!conflictAt(conflicts, f.run.id, t);
  const writing = (f: FlatRun) => states.get(f.run.id)!.seg?.kind === "write";
  const order = new Map(runs.flat.map((f, i) => [f.run.id, i]));
  if (!figuresOn) {
    // Compact presence: one chip per node, the agent that needs you (or writes) first, "+N" for the rest.
    const at = new Map<string, FlatRun[]>();
    for (const f of present) if (f.depth === 0) at.set(states.get(f.run.id)!.at, [...(at.get(states.get(f.run.id)!.at) ?? []), f]);
    const chips = [...at].map(([place, list]) => ({ place, ids: list.sort((a, b) => Number(need(b)) - Number(need(a)) || Number(writing(b)) - Number(writing(a)) || order.get(a.run.id)! - order.get(b.run.id)!).map((f) => f.run.id) }));
    return { ...EMPTY, t, chips, rings: ringsOf(present.filter((f) => f.depth === 0), states, conflicts, t), states, byId };
  }
  // Two sessions at one node (rare: one main agent at a time) stand side by side; a sub-agent next to its dispatcher.
  const slot = slots(present.map((f) => ({ id: f.run.id, place: states.get(f.run.id)!.at, order: order.get(f.run.id)! })));
  const figs: Fig[] = present.map((f) => ({ f, place: states.get(f.run.id)!.at, slot: slot.get(f.run.id) ?? 0 }));
  const drawn = new Set(figs.map((x) => x.f.run.id));
  const bubbles = pickBubbles(
    figs.map((x) => {
      const st = states.get(x.f.run.id)!;
      return { id: x.f.run.id, depth: x.f.depth, need: need(x.f), writing: writing(x.f), order: order.get(x.f.run.id)!, idle: st.pose === "idle", working: st.pose !== "idle" };
    }),
  );
  if (selected && drawn.has(selected) && !bubbles.includes(selected)) bubbles.push(selected);
  if (o.traced && drawn.has(o.traced) && !bubbles.includes(o.traced)) bubbles.push(o.traced);
  const tethers = figs.filter((x) => x.f.parent && drawn.has(x.f.parent.id) && (x.f.run.doneAt == null || t < x.f.run.doneAt)).map((x) => ({ child: x.f.run.id, parent: x.f.parent!.id }));
  // the trips a drawn figure is on, just finished, or starts before the next snapshot
  const trips: Snap["trips"] = [];
  for (const x of figs) {
    const seen = new Set<Trip>();
    for (const u of [t - TRIP_OUT_MS, t, t + TRIP_AHEAD_MS]) {
      const p = stateAt(x.f.run, u, ctx).trip;
      if (!p || seen.has(p) || (!p.bridges.length && !p.ladders.length && !p.glides.length && !p.hops.length) || t < p.t0 - TRIP_AHEAD_MS || t > p.t1 + TRIP_OUT_MS) continue;
      seen.add(p);
      trips.push({ key: `${x.f.run.id}|${p.t0}`, run: x.f.run.id, trip: p, sel: x.f.run.id === selected || x.f.run.id === o.traced });
    }
  }
  const tr = o.traced && o.route !== false ? byId.get(o.traced) : undefined;
  // 按轮追踪: the stretch is one turn of the run (the chosen one, else its current or latest); a run without turn numbers keeps the stretch of work t is in
  const win = tr ? (o.turn ?? latestTurnWindow(tr.run)) : null;
  const trace = tr ? traceAt(tr.run, t, ctx, o.now ?? Infinity, win ? spanOf(win, o.now ?? Date.now()) : undefined) : null;
  // the tray shows while someone stands there or looks at it, and for a traced way through it
  const tray = figs.some((x) => x.place === OUTSIDE || states.get(x.f.run.id)!.glance?.place === OUTSIDE) || !!trace?.stops.some((s) => s.place === OUTSIDE) || !!trace?.subs.some((s) => s.stops.some((x) => x.done && x.place === OUTSIDE));
  // the ladders at doors, and the head that looks out of each hole (only those drawn on this canvas: depth ≤ 1)
  const { hatches, peeks } = hatchesAt(runs.flat.filter((f) => f.depth < 2 && (!o.only || o.only(f.run.id))).map((f) => f.run.id), (id, u) => stateAt(byId.get(id)!.run, u, ctx), t, { traced: o.traced, followed: o.followed });
  return { t, figs, bubbles, rings: ringsOf(present, states, conflicts, t), tethers, chips: [], states, byId, folded, tray, trips, trace, hatches, peeks };
}

/** The prototype's node rings: solid purple while someone writes there, warm while someone there
 * waits on you, dashed purple while someone reads (or glances at it from elsewhere), a quiet grey for
 * other work; a two-agent write conflict gets a wider warm ring. */
export type RingTone = "write" | "wait" | "read" | "busy" | "conflict" | "sel" | "hover";
export function ringsOf(list: FlatRun[], states: Map<string, RunState>, conflicts: WriteConflict[], t: number): Snap["rings"] {
  const ks = new Map<string, string[]>();
  const who = new Map<string, string[]>();
  const clash = new Set<string>();
  for (const f of list) {
    const st = states.get(f.run.id)!;
    // (the tray gets a ring only when glanced at: standing there, its own look says so)
    const at = st.glance?.place ?? st.at;
    if ((at === OUTSIDE && !st.glance) || st.pose === "idle" || st.pose === "walk" || !st.seg) continue;
    ks.set(at, [...(ks.get(at) ?? []), st.seg.kind]);
    who.set(at, [...(who.get(at) ?? []), f.run.id]);
    if (conflictAt(conflicts, f.run.id, t)) clash.add(at);
  }
  const out: Snap["rings"] = [];
  for (const [place, k] of ks) {
    const ids = who.get(place)!;
    if (clash.has(place)) out.push({ place, tone: "conflict", ids });
    else out.push({ place, tone: k.includes("write") ? "write" : k.includes("wait") ? "wait" : k.includes("read") ? "read" : "busy", ids });
  }
  return out;
}

/** A trip's bridges (a dashed line at the leg's height, a small post at each end) and ladders (two
 * rails, rungs where hands and feet hold), world coordinates; a scaffold's fainter and dashed. Graphite,
 * or purple for the selected figure's. A hop (§5 跳过去) builds nothing: its arc is only a faint dotted trail. */
export function TripShape({ trip: p, sel }: { trip: Trip; sel: boolean }) {
  const ink = (temp: boolean) => (sel ? "var(--accent)" : temp ? "var(--fg-faint)" : "var(--fg-muted)");
  const post = 5 * p.k;
  const half = 2.6 * p.k;
  return (
    <>
      {p.glides.map((g, i) => (
        // the arrow it glides along, lit faintly under the capsule (§5 沿箭头滑行)
        <path key={`g${i}`} d={g.pts.map((q, j) => `${j ? "L" : "M"}${px(q.x)} ${px(q.y)}`).join("")} fill="none" stroke="var(--accent)" strokeOpacity={sel ? 0.55 : 0.3} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ))}
      {p.hops.map((h, i) => (
        // the arc it hops along, a faint dotted trail (nothing is built)
        <path key={`h${i}`} d={h.pts.map((q, j) => `${j ? "L" : "M"}${px(q.x)} ${px(q.y)}`).join("")} fill="none" stroke={sel ? "var(--accent)" : "var(--fg-faint)"} strokeOpacity={sel ? 0.45 : 0.3} strokeWidth={1.2} strokeDasharray="1 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      {p.bridges.map((b, i) => (
        <g key={`b${i}`} fill="none" stroke={ink(b.temp)} strokeLinecap="round">
          <path d={`M${px(b.a.x)} ${px(b.a.y)}H${px(b.b.x)}`} strokeWidth={1.2} strokeDasharray={b.temp ? "2 4" : "5 3"} vectorEffect="non-scaling-stroke" />
          <path d={`M${px(b.a.x)} ${px(b.a.y)}v${px(-post)}M${px(b.b.x)} ${px(b.b.y)}v${px(-post)}`} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {p.ladders.map((l, i) => (
        <g key={`l${i}`} fill="none" stroke={ink(l.temp)} strokeLinecap="round">
          <path d={`M${px(l.x - half)} ${px(l.top)}V${px(l.bottom)}M${px(l.x + half)} ${px(l.top)}V${px(l.bottom)}`} strokeWidth={1.2} strokeDasharray={l.temp ? "2 3" : undefined} vectorEffect="non-scaling-stroke" />
          <path d={l.rungs.map((y) => `M${px(l.x - half)} ${px(y)}H${px(l.x + half)}`).join("")} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </>
  );
}

/** A door's ladder as it is drawn (./hatch.ts `ladderShape`), in figure units with the floor at the origin: two rails and the rungs, and where the ladder goes down through a
 * node's top edge a dark slot for the hole; where it hangs from above (the sub-diagram's canvas) a short bar where it comes in. Placed by the frame job. */
export function HatchShape({ side }: { side: Side }) {
  const l = ladderShape(side === "below" ? 1 : -1);
  const w = LADDER_HALF;
  // the hole (a dark slot in the node's top edge) stays while someone is down there; the ladder's rails and rungs only while it is climbed (./hatch.ts `hatchVisAt`)
  return (
    <g fill="none" stroke="var(--fg-muted)" strokeLinecap="round">
      <g className="ws-hatch-ladder" opacity={0}>
        <path d={`M${-w} ${px(l.top)}V0M${w} ${px(l.top)}V0`} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        <path d={l.rungs.map((y) => `M${-w} ${px(y)}H${w}`).join("")} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {side === "below" ? null : <path d={`M${-w - 4} ${px(l.top)}H${w + 4}`} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
      </g>
      {side === "below" && <rect className="ws-hatch-hole" x={-w - 3} y={-1.2} width={2 * w + 6} height={2.4} rx={1.2} fill="var(--fig-ink)" stroke="none" />}
    </g>
  );
}

/** The trip through a door for a figure at k (./rig.ts `planDoor`), kept: the frame job asks for it every frame. */
export const doorTrips = new Map<string, Trip>();
export function doorTrip(k: number, dir: 1 | -1, leaving: boolean, f: 1 | -1): Trip {
  const key = `${k.toFixed(3)}|${dir}|${leaving ? 1 : 0}|${f}`;
  let t = doorTrips.get(key);
  if (!t) {
    if (doorTrips.size > 400) doorTrips.clear();
    doorTrips.set(key, (t = planDoor(k, dir, leaving, f)));
  }
  return t;
}

export const KIND_ICON: Record<string, typeof IconEye> = { read: IconEye, write: IconCode, exec: IconTerminal, think: IconCpu, wait: IconMessage, idle: IconCheck, walk: IconPath, delegate: IconSend, handoff: IconSend };
/** The one word a collapsed bubble (a chip at the figure) keeps. */
export const CHIP_VERB: Record<string, string> =
  lang() === "en"
    ? { read: "Read", write: "Write", exec: "Run", think: "Think", wait: "Waiting", idle: "Idle", walk: "Walk", delegate: "Dispatch", handoff: "Hand off", unknown: "?", conflict: "Write" }
    : { read: "读", write: "写", exec: "跑", think: "想", wait: "等你", idle: "闲", walk: "走", delegate: "派", handoff: "交", unknown: "?", conflict: "写" };

/** What a worker's bubble says (the prototype's wording and verb icons). `key` changes when the words do (cross-fade). */
export function bubbleBody(f: FlatRun, st: RunState, t: number, geom: Geometry, conflicts: WriteConflict[], byId: Map<string, FlatRun>, folded: number, quiet = 0): { kind: string; key: string; body: ReactNode; chip: ReactNode; verb: string } {
  const run = f.run;
  const g = st.seg;
  const par = f.parent;
  const back = !!par && run.doneAt != null && t >= run.doneAt;
  const el = g ? <span className="el">{secs(t - g.start)}</span> : null;
  const place = (p: string) => (p === OUTSIDE ? OFF : (geom.labels.get(p) ?? NODE));
  // A sub-agent between two commands (or sent and not yet taken) is thinking, not idle: only one that is over is.
  let kind: string = st.pose === "walk" ? "walk" : st.pose === "handoff" || st.pose === "unknown" ? st.pose : g ? g.kind : st.pose === "think" ? "think" : "idle";
  const Ic = KIND_ICON[kind];
  const icon = Ic ? <Ic size={14} /> : null;
  let body: ReactNode;
  if (kind === "walk" && back) body = <>{icon}<span className="v">{tr("走回", "Back to")}</span><span>{par!.name}</span><span className="el">{tr("交结果", "with the result")}</span></>;
  else if (kind === "walk") body = <>{icon}<span className="v">{tr("走去", "Going to")}</span><span>{place(st.at)}</span>{g?.say ? <span className="el">{tr(`要${g.say}`, g.say)}</span> : g?.path && <span className="el">{tr(`要${g.kind === "write" ? "写" : g.kind === "exec" ? "跑" : "读"} ${base(g.path)}`, `to ${g.kind === "write" ? "write" : g.kind === "exec" ? "run" : "read"} ${base(g.path)}`)}</span>}</>;
  else if (kind === "handoff") body = <>{icon}<span className="v">{tr(`交给 ${par?.name}`, `Handing to ${par?.name}`)}</span><span className="el">{tr("结果回到父会话", "result goes to the parent session")}</span></>;
  else if (kind === "unknown") body = <span className="el">{tr("只有回执，看不到它在做什么", "Receipts only — can't see what it's doing")}</span>;
  else if (kind === "idle" && par && st.receipt && st.receipt !== "returned" && st.receipt !== "accepted") body = <span className="v">{receiptText(run, st.receipt)}</span>; // stopped without handing back, cut off, failed: no tick, it did not finish well
  else if (kind === "idle" && par) body = <>{icon}<span className="v">{tr("已交回", "Handed back")}</span><span className="el">{tr(`结果回到 ${par.name}`, `result is with ${par.name}`)}</span></>; // handed back: not "idle"
  else if (kind === "idle") body = <>{icon}<span className="v">{tr("空闲", "Idle")}</span><span className="el">{tr("这一轮做完了", "turn done")}</span></>;
  else if (kind === "wait")
    body = (
      <>
        {icon}
        <span className="v">{tr("等你回复", "Waiting for you")}</span>
        {g?.question && <span className="q">{g.question}</span>}
        <button className="reply" onClick={(e) => (e.stopPropagation(), openRun(f))}>{tr("去回复", "Reply")}</button>
      </>
    );
  else if (g?.say && (kind === "write" || kind === "think")) body = <>{icon}<span className="f">{g.say}</span></>; // a stretch with its own words (the build replay, ../buildreplay/plan.ts)
  else if (kind === "think") body = <>{icon}<span className="v">{par && !g && st.receipt === "dispatched" ? tr(`等 ${run.name} 接手`, `Waiting for ${run.name} to start`) : tr("思考", "Thinking")}</span>{el}</>;
  else if (kind === "delegate") {
    const c = g?.child ? byId.get(g.child)?.run : undefined;
    body = <>{icon}<span className="v">{DISPATCH}</span><span>{c ? `${c.name}${tr("：", ": ")}${c.task ?? ""}` : g?.label.startsWith(`${DISPATCH} `) ? g.label.slice(DISPATCH.length + 1) : g?.label}</span>{c && <span className="el">{c.via === "task" ? tr("Task 工具", "Task tool") : c.via === "dispatch" ? tr("Agora 派发", "Agora dispatch") : tr("原生子代理", "native sub-agent")}</span>}</>;
  } else if (kind === "exec") body = <>{icon}<span className="v">{g?.verifies ? tr("验收 · ", "Verify · ") : ""}{tr("跑", "Running")}</span><span className="f">{g?.cmd ?? g?.label}</span>{el}</>;
  else body = <>{icon}<span className="v">{g?.verifies ? tr("验收 · ", "Verify · ") : ""}{kind === "write" ? tr("写", "Writing") : tr("读", "Reading")}</span><span className="f">{pathLabel(g?.path) || g?.say || ""}</span>{el}</>;
  const c = conflictAt(conflicts, run.id, t);
  if (c && g) {
    kind = "conflict";
    const other = byId.get(c.runs.find((x) => x !== run.id)!)?.run;
    body = <>{body}<span className="warn">{tr(`${other?.name ?? "另一个 agent"} 也在改`, `${other?.name ?? "another agent"} is editing it too`)}</span></>;
  }
  const verb = kind === "idle" && par ? (st.receipt === "returned" || st.receipt === "accepted" ? tr("交回", "Back") : tr("停", "Stopped")) : (CHIP_VERB[kind] ?? "…");
  return {
    kind,
    key: `${kind}|${g?.start ?? st.at}|${st.receipt ?? ""}`,
    verb,
    chip: <>{icon}<span className="v">{verb}</span></>,
    body: (
      <>
        <RunAvatar agent={run.agent} size={par ? 18 : 20} />
        {/* 「Codex Pi 派的 读 users.py 运行中」 */}
        {par ? <><b className="who">{run.name}</b><span className="par">{tr(`${par.name} 派的`, `from ${par.name}`)}</span></> : <b className="who">{run.name}</b>}
        {body}
        {st.portal && <span className="portal" title={tr(`在子图「${st.portal.label}」里`, `In sub-diagram “${st.portal.label}”`)}>↘ {tr("子图", "Sub-diagram")} · {st.portal.label}</span>}
        {par && st.receipt && <span className="rc" data-r={st.receipt}>{receiptText(run, st.receipt)}</span>}
        {run.children.map((k) => {
          const acc = k.receipts.find((r) => r.accepted);
          return acc && t >= acc.at && t < acc.at + 2500 ? <span key={k.id} className="rc" data-r="accepted">{tr(`${k.name} 验收通过`, `${k.name} accepted`)}</span> : null;
        })}
        {folded > 0 && <span className="kbadge" title={tr(`它又派了 ${folded} 个子代理（更深一层不画在图上，见时间线）`, `It dispatched ${folded} more ${folded === 1 ? "sub-agent" : "sub-agents"} (the deeper level isn't drawn on the diagram; see the timeline)`)}>+{folded}</span>}
        {quiet > 0 && <span className="kbadge" data-quiet title={tr(`${quiet} 个子代理的气泡收起了（这里挤不下；悬停小人或看时间线）`, `${quiet} ${quiet === 1 ? "sub-agent's bubble is" : "sub-agents' bubbles are"} folded (no room here; hover the avatar or see the timeline)`)}>+{quiet}</span>}
      </>
    ),
  };
}

export function openRun(f: FlatRun) {
  const sid = f.root.sessionId;
  if (sid) ui.openSession(sid);
}

/** Keep items that just left for `ms` (marked exiting), so they can fade out instead of vanishing. */
