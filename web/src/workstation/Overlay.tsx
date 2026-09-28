// 工位视图 on the canvas (web/docs/workstation.md): every agent run is a small worker standing on the
// node whose code it reads or writes — the figure IS the pointer. Its bubble says what it does;
// a node gets a 1.5px purple stroke only while someone writes there, a warm one while someone
// there waits on you or two runs write the same file. With the view off, each agent is a compact
// presence chip on its node instead. Idle agents leave after a minute. Tuned for one main agent
// with 3–6 sub-agents (smaller figures with the dispatcher's mark, a dashed tether while working).
//
// Frame-rate design (§性能):
//   - structure (which figures, bubbles, chips, rings) is rebuilt a few times a second at most
//     (`snapshot`, on data / clock events and a 4 Hz timer), never per frame;
//   - one rAF job (./frame.ts) moves what exists: one world transform for pan and zoom, and each
//     figure's joints via setAttribute; bubbles and chips follow by `transform`;
//   - node boxes, docks and the clip region are recomputed only when the scene or the panels change;
//   - bubble placement (avoid nodes and each other) runs with the snapshot, on a grid index.
// Motion (§动效): nothing snaps. Figures fade in and out; slot changes, bubble moves and flips glide
// (springs integrated on wall-clock time); bubbles fade + rise in and fade out; node strokes fade
// and change colour over 300 ms; everything is placed at sub-pixel positions. Springs reset only on
// a real jump in time (clock.gen: seek, scrub, back to live).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCode, IconCpu, IconEye, IconHistory, IconMessage, IconPath, IconSend, IconTerminal } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { clipPath } from "../canvas/chrome";
import type { Box } from "../canvas/clearance";
import { viewport, type Viewport } from "../canvas/viewport";
import { useNested } from "../nested/store";
import { ui } from "../session/ui";
import { clock, prefersReducedMotion, useReplay } from "./clock";
import { placeBubbles, protoSpot, type BubbleIn } from "./bubbles";
import { pickBubbles, slots } from "./crowd";
import { FigureNode } from "./figureNode";
import { figurePositions, focus, useFocus } from "./focus";
import { frame } from "./frame";
import { buildGeometry, type Geometry } from "./geometry";
import { canvasWhere, conflictAt, OUTSIDE, stateAt, writeConflicts, type Ctx, type RunState, type WriteConflict } from "./place";
import { Glide, makeSprings, solve, type Springs } from "./rig";
import { RunAvatar } from "./RunAvatar";
import { useRuns, type Runs } from "./runs/store";
import { RECEIPT_NAMES, type FlatRun } from "./runs/types";
import "./workstation.css";

const SNAP_MS = 250;
const BUBBLE_EXIT_MS = 120;
const RING_EXIT_MS = 300;
const pad2 = (n: number) => String(n).padStart(2, "0");
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒` : `${Math.round(ms / 1000)} 秒`);
const base = (p: string) => p.split("/").pop() || p;
const vkOf = (v: Viewport) => `${v.scrollX}|${v.scrollY}|${v.zoom}|${v.width}|${v.height}`;
const px = (n: number) => n.toFixed(2);
export const hhmmss = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

type Fig = { f: FlatRun; place: string; slot: number };
type Snap = {
  t: number;
  figs: Fig[];
  bubbles: string[];
  rings: { place: string; tone: RingTone }[];
  tethers: { child: string; parent: string }[];
  chips: { place: string; ids: string[] }[];
  states: Map<string, RunState>;
  byId: Map<string, FlatRun>;
  /** Deeper sub-agents folded into the +N over their depth-1 ancestor. */
  folded: Map<string, number>;
  tray: boolean;
};
const EMPTY: Snap = { t: 0, figs: [], bubbles: [], rings: [], tethers: [], chips: [], states: new Map(), byId: new Map(), folded: new Map(), tray: false };

/** Structure at time t: who is on the canvas, where, who gets a bubble, which nodes get a stroke. Pure. */
export function snapshot(runs: Runs, t: number, ctx: Ctx, conflicts: WriteConflict[], figuresOn: boolean, selected: string | null): Snap {
  const states = new Map<string, RunState>();
  const present: FlatRun[] = [];
  const byId = new Map(runs.flat.map((f) => [f.run.id, f]));
  const folded = new Map<string, number>();
  for (const f of runs.flat) {
    const st = stateAt(f.run, t, ctx);
    states.set(f.run.id, st);
    if (!st.present) continue;
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
  const tethers = figs.filter((x) => x.f.parent && drawn.has(x.f.parent.id) && (x.f.run.doneAt == null || t < x.f.run.doneAt)).map((x) => ({ child: x.f.run.id, parent: x.f.parent!.id }));
  return { t, figs, bubbles, rings: ringsOf(present, states, conflicts, t), tethers, chips: [], states, byId, folded, tray: figs.some((x) => x.place === OUTSIDE) };
}

/** The prototype's node rings: solid purple while someone writes there, warm while someone there
 * waits on you, dashed purple while someone reads, a quiet grey for other work; a two-agent write
 * conflict gets a wider warm ring. */
export type RingTone = "write" | "wait" | "read" | "busy" | "conflict" | "sel" | "hover";
function ringsOf(list: FlatRun[], states: Map<string, RunState>, conflicts: WriteConflict[], t: number): Snap["rings"] {
  const ks = new Map<string, string[]>();
  const clash = new Set<string>();
  for (const f of list) {
    const st = states.get(f.run.id)!;
    if (st.at === OUTSIDE || st.pose === "idle" || st.pose === "walk" || !st.seg) continue;
    ks.set(st.at, [...(ks.get(st.at) ?? []), st.seg.kind]);
    if (conflictAt(conflicts, f.run.id, t)) clash.add(st.at);
  }
  const out: Snap["rings"] = [];
  for (const [place, k] of ks) {
    if (clash.has(place)) out.push({ place, tone: "conflict" });
    else out.push({ place, tone: k.includes("write") ? "write" : k.includes("wait") ? "wait" : k.includes("read") ? "read" : "busy" });
  }
  return out;
}

const KIND_ICON: Record<string, typeof IconEye> = { read: IconEye, write: IconCode, exec: IconTerminal, think: IconCpu, wait: IconMessage, idle: IconCheck, walk: IconPath, delegate: IconSend, handoff: IconSend };
/** The one word a collapsed bubble (a chip at the figure) keeps. */
const CHIP_VERB: Record<string, string> = { read: "读", write: "写", exec: "跑", think: "想", wait: "等你", idle: "闲", walk: "走", delegate: "派", handoff: "交", unknown: "?", conflict: "写" };

/** What a worker's bubble says (the prototype's wording and verb icons). `key` changes when the words do (cross-fade). */
function bubbleBody(f: FlatRun, st: RunState, t: number, geom: Geometry, conflicts: WriteConflict[], byId: Map<string, FlatRun>, folded: number, quiet = 0): { kind: string; key: string; body: ReactNode; chip: ReactNode; verb: string } {
  const run = f.run;
  const g = st.seg;
  const par = f.parent;
  const back = !!par && run.doneAt != null && t >= run.doneAt;
  const el = g ? <span className="el">{secs(t - g.start)}</span> : null;
  const place = (p: string) => (p === OUTSIDE ? "图外" : (geom.labels.get(p) ?? "节点"));
  let kind: string = st.pose === "walk" ? "walk" : st.pose === "handoff" || st.pose === "unknown" ? st.pose : g ? g.kind : "idle";
  const Ic = KIND_ICON[kind];
  const icon = Ic ? <Ic size={14} /> : null;
  let body: ReactNode;
  if (kind === "walk" && back) body = <>{icon}<span className="v">走回</span><span>{par!.name}</span><span className="el">交结果</span></>;
  else if (kind === "walk") body = <>{icon}<span className="v">走去</span><span>{place(st.at)}</span>{g?.path && <span className="el">要{g.kind === "write" ? "写" : "读"} {base(g.path)}</span>}</>;
  else if (kind === "handoff") body = <>{icon}<span className="v">交给 {par?.name}</span><span className="el">{run.via === "seedmux" ? "声明完成 ≠ 验收" : "结果回到父会话"}</span></>;
  else if (kind === "unknown") body = <span className="el">只有回执，看不到它在做什么</span>;
  else if (kind === "idle") body = <>{icon}<span className="v">空闲</span><span className="el">这一轮做完了</span></>;
  else if (kind === "wait")
    body = (
      <>
        {icon}
        <span className="v">等你回复</span>
        {g?.question && <span className="q">{g.question}</span>}
        <button className="reply" onClick={(e) => (e.stopPropagation(), openRun(f))}>去回复</button>
      </>
    );
  else if (kind === "think") body = <>{icon}<span className="v">{par && !g ? (st.receipt === "dispatched" ? "等它接单" : "确认任务") : "思考"}</span>{el}</>;
  else if (kind === "delegate") {
    const c = g?.child ? byId.get(g.child)?.run : undefined;
    body = <>{icon}<span className="v">派</span><span>{c ? `${c.name}：${c.task ?? ""}` : g?.label.replace(/^派 /, "")}</span>{c && <span className="el">{c.via === "seedmux" ? "经 Seedmux" : c.via === "task" ? "Task 工具" : "原生子代理"}</span>}</>;
  } else if (kind === "exec") body = <>{icon}<span className="v">{g?.verifies ? "验收 · " : ""}跑</span><span className="f">{g?.cmd ?? g?.label}</span>{el}</>;
  else body = <>{icon}<span className="v">{g?.verifies ? "验收 · " : ""}{kind === "write" ? "写" : "读"}</span><span className="f">{g?.path ?? ""}</span>{el}</>;
  const c = conflictAt(conflicts, run.id, t);
  if (c && g) {
    kind = "conflict";
    const other = byId.get(c.runs.find((x) => x !== run.id)!)?.run;
    body = <>{body}<span className="warn">{other?.name ?? "另一个 agent"} 也在改</span></>;
  }
  const verb = CHIP_VERB[kind] ?? "…";
  return {
    kind,
    key: `${kind}|${g?.start ?? st.at}|${st.receipt ?? ""}`,
    verb,
    chip: <>{icon}<span className="v">{verb}</span></>,
    body: (
      <>
        <RunAvatar agent={run.agent} size={par ? 18 : 20} />
        {/* 「Codex Pi 派的 读 users.py 运行中」 */}
        {par ? <><b className="who">{run.name}</b><span className="par">{par.name} 派的</span></> : <b className="who">{run.name}</b>}
        {body}
        {st.portal && <span className="portal" title={`在子图「${st.portal.label}」里`}>↘ 子图 · {st.portal.label}</span>}
        {par && st.receipt && <span className="rc" data-r={st.receipt}>{RECEIPT_NAMES[st.receipt]}</span>}
        {run.children.map((k) => {
          const acc = k.receipts.find((r) => r.accepted);
          return acc && t >= acc.at && t < acc.at + 2500 ? <span key={k.id} className="rc" data-r="accepted">{k.name} 验收通过</span> : null;
        })}
        {folded > 0 && <span className="kbadge" title={`它又派了 ${folded} 个子代理（更深一层不画在图上，见时间线）`}>+{folded}</span>}
        {quiet > 0 && <span className="kbadge" data-quiet title={`${quiet} 个子代理的气泡收起了（这里挤不下；悬停小人或看时间线）`}>+{quiet}</span>}
      </>
    ),
  };
}

function openRun(f: FlatRun) {
  const sid = f.root.sessionId;
  if (sid) ui.openSession(sid);
}

/** Keep items that just left for `ms` (marked exiting), so they can fade out instead of vanishing. */
function useExiting<T extends { key: string }>(items: T[], ms: number): (T & { exiting?: boolean })[] {
  const gone = useRef(new Map<string, { item: T; until: number }>());
  const prev = useRef<T[]>([]);
  const [, bump] = useState(0);
  const now = Date.now();
  const keys = new Set(items.map((i) => i.key));
  for (const p of prev.current) if (!keys.has(p.key) && !gone.current.has(p.key)) gone.current.set(p.key, { item: p, until: now + ms });
  for (const k of keys) gone.current.delete(k);
  for (const [k, g] of gone.current) if (g.until <= now) gone.current.delete(k);
  prev.current = items;
  useEffect(() => {
    if (!gone.current.size) return;
    const t = setTimeout(() => bump((n) => n + 1), ms + 10);
    return () => clearTimeout(t);
  });
  return [...items, ...[...gone.current.values()].map((g) => ({ ...g.item, exiting: true }))];
}

type Props = { view: CanvasViewState; chrome: Box[]; figuresOn: boolean };

export function WorkstationOverlay({ view, chrome, figuresOn }: Props) {
  const runs = useRuns();
  const nst = useNested();
  const replay = useReplay();
  const fo = useFocus();
  const reduced = prefersReducedMotion();
  const geom = useMemo(() => buildGeometry(view.id, view.elements, view.map, nst.scenes, (id) => nst.titles[id]), [view.id, view.version, nst.scenes, nst.titles]);
  const ctx = useMemo<Ctx>(() => ({ locate: geom.locate, dock: geom.dock, route: geom.route, reduced, run: (id) => runs.byId.get(id) }), [geom, runs, reduced]);
  const conflicts = useMemo(() => writeConflicts(runs.flat.map((f) => f.run)), [runs]);
  useEffect(() => {
    canvasWhere.set(view.id, { ctx, label: (p) => (p === OUTSIDE ? "图外" : (geom.labels.get(p) ?? "节点")) });
  }, [view.id, ctx, geom]);
  const [snap, setSnap] = useState<Snap>(EMPTY);
  const a = view.appState;
  const clip = useMemo(() => clipPath({ x: 0, y: 0, w: a.width, h: a.height }, chrome), [a.width, a.height, chrome]);

  // ── structure: a few times a second at most ──
  const inputs = useRef({ runs, ctx, conflicts, figuresOn, fo });
  inputs.current = { runs, ctx, conflicts, figuresOn, fo };
  const rebuild = useRef(() => {});
  useEffect(() => {
    let last = 0;
    let pending = 0;
    const compute = () => {
      last = performance.now();
      pending = 0;
      const i = inputs.current;
      setSnap(snapshot(i.runs, clock.time(), i.ctx, i.conflicts, i.figuresOn, i.fo.selected));
    };
    const kick = () => {
      if (pending) return;
      pending = window.setTimeout(compute, Math.max(0, SNAP_MS - (performance.now() - last)));
    };
    rebuild.current = kick;
    kick();
    const timer = window.setInterval(() => document.visibilityState === "visible" && kick(), SNAP_MS);
    const offC = clock.subscribe(kick);
    return () => (clearInterval(timer), clearTimeout(pending), offC());
  }, []);
  // data or settings changed: rebuild (same rate limit)
  useEffect(() => rebuild.current(), [runs, ctx, conflicts, figuresOn, fo.selected]);

  // ── imperative nodes: figures and tethers, created per snapshot, moved per frame ──
  const rootEl = useRef<HTMLDivElement>(null);
  const svgWorld = useRef<SVGGElement>(null);
  const figLayer = useRef<SVGGElement>(null);
  const tetherLayer = useRef<SVGGElement>(null);
  const nodes = useRef(new Map<string, FigureNode>());
  const springs = useRef(new Map<string, Springs>());
  const offs = useRef(new Map<string, { x: Glide; y: Glide }>());
  const tethers = useRef(new Map<string, SVGPathElement>());
  /** Each drawn figure's head (world), its radius and whether a ! / ? mark sits over it, and its scale. */
  const heads = useRef(new Map<string, { x: number; y: number; r: number; mark: boolean; k: number; sc: number; walking: boolean; root: { x: number; y: number } }>());
  const bubbleEls = useRef(new Map<string, HTMLElement>());
  /** Where each bubble should sit relative to its figure's head (decided ≤ 4 Hz)… */
  const bubbleOff = useRef(new Map<string, { dx: number; dy: number }>());
  /** The last placement of each bubble (tail, stem, chip), to keep it where it is while that stays clear. */
  const lastPlace = useRef(new Map<string, { tail: "d" | "l" | "r" | null; tailX: number; stem: number; chip: boolean }>());
  /** …and where it is on its way there: a Hermite glide per axis, so a move or a flip starts
   * gently, keeps its speed if retargeted mid-way, and settles at rest. */
  const bubbleCur = useRef(new Map<string, { x: Glide; y: Glide }>());
  /** Measured size and placement priority of each bubble (from the placement pass), and how visible
   * it is while it waits for a higher-priority bubble to move out of its way (0–1, per frame). */
  const bubbleSize = useRef(new Map<string, { w: number; h: number }>());
  const bubbleRank = useRef(new Map<string, number>());
  const bubbleVis = useRef(new Map<string, number>());
  /** Sub-agent bubbles folded for lack of room, counted as +N on the nearest shown ancestor's bubble. */
  const [foldCounts, setFoldCounts] = useState<Map<string, number>>(() => new Map());
  const foldKey = useRef<{ key: string; counts: Map<string, number> }>({ key: "", counts: new Map() });
  const foldPass = useRef<{ snap: Snap | null; n: number }>({ snap: null, n: 0 });
  const chipEls = useRef(new Map<string, HTMLElement>());
  const trayEl = useRef<HTMLDivElement>(null);
  const bannerTime = useRef<HTMLElement>(null);
  /** Something new was rendered (a bubble, a chip): draw on the next frame even when reduced motion only repaints once a second. */
  const dirty = useRef(true);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useLayoutEffect(() => {
    const layer = figLayer.current;
    if (!layer) return;
    const want = new Set(snap.figs.map((x) => x.f.run.id));
    for (const [id, n] of nodes.current)
      if (!want.has(id)) {
        n.g.remove();
        nodes.current.delete(id);
        springs.current.delete(id);
        offs.current.delete(id);
      }
    for (const x of snap.figs) {
      const id = x.f.run.id;
      if (nodes.current.has(id)) continue;
      const n = new FigureNode(id, x.f.run.agent, { parentAgent: x.f.parent?.agent, label: x.f.run.name });
      nodes.current.set(id, n);
      layer.appendChild(n.g);
    }
    const tl = tetherLayer.current!;
    const wantT = new Set(snap.tethers.map((x) => x.child));
    for (const [id, p] of tethers.current)
      if (!wantT.has(id)) {
        p.remove();
        tethers.current.delete(id);
      }
    for (const x of snap.tethers)
      if (!tethers.current.has(x.child)) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("class", "ws-tether");
        tl.appendChild(p);
        tethers.current.set(x.child, p);
      }
  }, [snap]);
  useEffect(
    () => () => {
      for (const n of nodes.current.values()) n.g.remove();
      nodes.current.clear();
      figurePositions.drop(view.id);
    },
    [],
  );

  // ── the frame job ──
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const confRef = useRef(conflicts);
  confRef.current = conflicts;
  useEffect(() => {
    let lastV = "";
    let lastSec = -1;
    let drawnSnap: Snap | null = null;
    let lastNow = 0;
    let lastGen = clock.gen();
    const positions = figurePositions.of(view.id);
    // Reduced motion: a figure that moves does not walk — it fades out where it was and fades in
    // where it goes (a cross-fade, never a hard cut). Its bubble fades with it.
    const moving = new Map<string, { x: number; y: number; out: number; in: number }>();
    const bubbleMoving = new Map<string, { x: number; y: number; out: number; in: number }>();
    /** Reduced motion: where to draw something that wants to be at (x, y), and how visible — a
     * move fades out in place, jumps while invisible, and fades in (never a hard cut). */
    const crossfade = (map: typeof moving, id: string, x: number, y: number, now: number) => {
      let m = map.get(id);
      if (!m) map.set(id, (m = { x, y, out: 0, in: now }));
      if (Math.abs(m.x - x) > 0.5 || Math.abs(m.y - y) > 0.5) {
        if (!m.out) m.out = now;
        const u = (now - m.out) / FADE_OUT;
        if (u < 1) return { x: m.x, y: m.y, a: 1 - u };
        m.x = x;
        m.y = y;
        m.out = 0;
        m.in = now;
        return { x, y, a: 0 };
      }
      return { x, y, a: Math.min(1, (now - m.in) / FADE_IN) };
    };
    const FADE_OUT = 120;
    const FADE_IN = 160;
    return frame.add((now) => {
      // A pane in the background (another tab of its group) draws nothing.
      if (rootEl.current?.closest('[data-hidden="true"]')) return;
      const v = viewport.get(view.id);
      const s = snapRef.current;
      const g = geomRef.current;
      const c = ctxRef.current;
      if (!v) return;
      const still = c.reduced;
      const t = clock.time(now);
      // A real jump in time (seek, scrub, back to live) or a long pause (background tab): reset
      // the springs to the exact pose. Otherwise everything blends on wall-clock time.
      const dt = lastNow ? (now - lastNow) / 1000 : 0;
      lastNow = now;
      const reset = clock.gen() !== lastGen || dt > 1;
      lastGen = clock.gen();
      // Reduced motion: repaint once a second (and when the view or the snapshot changes, or while a cross-fade runs).
      const fading = [...moving.values(), ...bubbleMoving.values()].some((m) => m.out > 0 || now - m.in < FADE_IN);
      if (still && !fading && !dirty.current && Math.floor(t / 1000) === lastSec && s === drawnSnap && vkOf(v) === lastV) return;
      dirty.current = false;
      lastSec = Math.floor(t / 1000);
      drawnSnap = s;
      const vk = vkOf(v);
      if (vk !== lastV) {
        lastV = vk;
        svgWorld.current?.setAttribute("transform", `matrix(${v.zoom} 0 0 ${v.zoom} ${v.scrollX * v.zoom} ${v.scrollY * v.zoom})`);
      }
      // Figures keep a readable size: at least their own size on screen, a little larger when zoomed in.
      const fsc = Math.max(1, Math.min(1.6, v.zoom * 1.2));
      const k = fsc / v.zoom;
      const step = Math.min(dt, 0.05);
      heads.current.clear();
      const counts = new Map<string, number>();
      for (const x of s.figs) counts.set(x.place, Math.max(counts.get(x.place) ?? 0, x.slot + 1));
      const alphas = new Map<string, number>();
      for (const x of s.figs) {
        const n = nodes.current.get(x.f.run.id);
        if (!n) continue;
        const run = x.f.run;
        const st = stateAt(run, t, c);
        if (!st.present) {
          n.place(0, 0, k, 0, false);
          continue;
        }
        let sp = springs.current.get(run.id);
        if (!sp) springs.current.set(run.id, (sp = makeSprings()));
        const conflict = conflictAt(confRef.current, run.id, t);
        const bump = conflict && t - conflict.start < 800 ? Math.sin(Math.PI * Math.min(1, (t - conflict.start) / 800)) : 0;
        const fresh = sp.t === null;
        const j = solve({ t, wall: now, dt: step, reset, pose: st.pose, since: st.since, dock: g.dock(st.at), walk: st.walk, still, conflict: !!conflict && !!st.seg, bump, unknownReceipt: st.receipt === "unknown", coarse: !!run.coarse, readingWhileWalking: st.seg?.kind === "read" }, sp);
        const sub = x.f.depth > 0 ? 0.8 : 1;
        // Side by side at a node: each figure has its own free spot (geometry.spots: along the top
        // edge, else beside or under the node, clear of text and icons); the offset from the walk's
        // dock glides, so an arrival or a departure never jumps.
        let off = offs.current.get(run.id);
        if (!off) offs.current.set(run.id, (off = { x: new Glide(), y: new Glide() }));
        const d0 = g.dock(x.place);
        const spot = g.spots(x.place, k, counts.get(x.place) ?? 1)[x.slot] ?? d0;
        const ns = now / 1000;
        const jumpOff = still || fresh || reset;
        const dx = jumpOff ? off.x.reset(spot.x - d0.x, ns) : off.x.step(ns, spot.x - d0.x);
        const dy = jumpOff ? off.y.reset(spot.y - d0.y, ns) : off.y.step(ns, spot.y - d0.y);
        let wx = j.root.x + dx;
        let wy = j.root.y + dy;
        let alpha = st.fade;
        if (still) {
          const xf = crossfade(moving, run.id, wx, wy, now);
          wx = xf.x;
          wy = xf.y;
          alpha *= xf.a;
        }
        const kk = k * sub;
        n.place(wx, wy, kk, alpha, false, st.pose === "idle");
        n.draw(j, now, still);
        heads.current.set(run.id, { x: wx + j.hx * kk, y: wy + j.hy * kk, r: 8.6 * kk, mark: !!j.mark, k: kk, sc: fsc, walking: j.walking, root: { x: wx, y: wy } });
        alphas.set(run.id, alpha / Math.max(0.001, st.fade));
        positions.set(run.id, { x: wx, y: wy });
      }
      for (const tt of s.tethers) {
        const p = tethers.current.get(tt.child);
        const a0 = heads.current.get(tt.child);
        const b0 = heads.current.get(tt.parent);
        if (!p || !a0 || !b0) continue;
        p.setAttribute("d", `M${px(a0.x)} ${px(a0.y)}Q${px((a0.x + b0.x) / 2)} ${px(Math.min(a0.y, b0.y) - 30 / v.zoom)} ${px(b0.x)} ${px(b0.y)}`);
      }
      // HTML pieces follow in screen coordinates, at sub-pixel positions.
      const drawnB: { id: string; el: HTMLElement; x: number; y: number }[] = [];
      for (const [id, el] of bubbleEls.current) {
        const h = heads.current.get(id);
        const o = bubbleOff.current.get(id);
        if (!h || !o) {
          el.style.visibility = "hidden";
          continue;
        }
        if (el.style.visibility) el.style.visibility = "";
        let cur = bubbleCur.current.get(id);
        if (!cur) bubbleCur.current.set(id, (cur = { x: new Glide(), y: new Glide() }));
        const ns = now / 1000;
        const bx = still || reset ? cur.x.reset(o.dx, ns) : cur.x.step(ns, o.dx);
        const by = still || reset ? cur.y.reset(o.dy, ns) : cur.y.step(ns, o.dy);
        // anchored to the feet (as in the prototype), not the head: a turn or a nod never shakes it
        let sx = (h.root.x + v.scrollX) * v.zoom + bx;
        let sy = (h.root.y + v.scrollY) * v.zoom + by;
        if (still) {
          const xf = crossfade(bubbleMoving, id, sx, sy, now);
          sx = xf.x;
          sy = xf.y;
          alphas.set(id, Math.min(alphas.get(id) ?? 1, xf.a));
        }
        el.style.transform = `translate3d(${px(sx)}px, ${px(sy)}px, 0)`;
        drawnB.push({ id, el, x: sx, y: sy });
      }
      // Between placements (≤ 4 Hz) a bubble follows a walking figure or glides to its new spot; if
      // it would touch a higher-priority bubble on the way, it fades out quickly until clear.
      drawnB.sort((a, b) => (bubbleRank.current.get(a.id) ?? 99) - (bubbleRank.current.get(b.id) ?? 99));
      const shown: Box[] = [];
      for (const d of drawnB) {
        const inner = d.el.firstElementChild as HTMLElement | null;
        // live size (the words change while it waits); layout is clean here, so this reads cheaply
        const sz = inner ? { w: inner.offsetWidth, h: inner.offsetHeight } : bubbleSize.current.get(d.id);
        const r = sz && !d.el.hasAttribute("data-folded") ? { x: d.x, y: d.y, w: sz.w, h: sz.h } : null;
        const near = (m: number) => !!r && shown.some((p) => p.x < r.x + r.w + m && r.x < p.x + p.w + m && p.y < r.y + r.h + m && r.y < p.y + p.h + m);
        const prev = bubbleVis.current.get(d.id) ?? 0;
        // touching: gone this frame; within 2 px: fading fast; clear: back in 120 ms
        const vis = !r || near(0) ? 0 : reset || still ? (near(2) ? 0 : 1) : Math.max(0, Math.min(1, prev + (near(2) ? -step / 0.06 : step / 0.12)));
        bubbleVis.current.set(d.id, vis);
        if (r && vis > 0 && !d.el.hasAttribute("data-folded")) shown.push(r);
        const a = (still ? (alphas.get(d.id) ?? 1) : 1) * vis;
        const op = a >= 0.999 ? "" : a.toFixed(3);
        if (d.el.style.opacity !== op) d.el.style.opacity = op;
      }
      for (const [place, el] of chipEls.current) {
        const b = g.boxOf(place);
        if (!b) continue;
        el.style.transform = `translate3d(${px((b.x + v.scrollX) * v.zoom)}px, ${px((b.y + v.scrollY) * v.zoom - 30)}px, 0)`;
      }
      if (trayEl.current && s.tray) {
        const b = g.tray;
        trayEl.current.style.transform = `translate3d(${px((b.x + v.scrollX) * v.zoom)}px, ${px((b.y + v.scrollY) * v.zoom)}px, 0)`;
        trayEl.current.style.width = `${px(b.w * v.zoom)}px`;
      }
      if (bannerTime.current) {
        const txt = hhmmss(t);
        if (bannerTime.current.textContent !== txt) bannerTime.current.textContent = txt;
      }
      // Playing into "now" ends the replay.
      const r = clock.get();
      if (r?.playing && t >= r.until) clock.live();
    });
  }, [view.id]);

  // ── bubble placement: with each snapshot, against nodes (grid index) and each other ──
  // Reads first (all bubble sizes in one layout), then decides; the frame loop does the writing.
  useLayoutEffect(() => {
    const v = viewport.get(view.id);
    if (!v) return;
    // Measure every bubble in full and its chip, in one layout read. A chip keeps its full words
    // laid out (hidden, out of flow), so nothing has to be toggled to measure either size.
    const sizes = new Map<string, { w: number; h: number }>();
    const chipSizes = new Map<string, { w: number; h: number }>();
    const inner = (id: string) => bubbleEls.current.get(id)?.firstElementChild as HTMLElement | null | undefined;
    for (const id of snap.bubbles) {
      const el = inner(id);
      if (!el) continue;
      const sub = el.hasAttribute("data-sub");
      const body = el.querySelector<HTMLElement>(".ws-bub-in");
      const c = el.querySelector<HTMLElement>(".ws-bub-chip");
      const extra = el.querySelector<HTMLElement>(".ws-acts");
      // padding 4 + 10 (a sub-agent's 3 + 8), min height 28 (24), as in .ws-bub
      const bw = (body?.offsetWidth ?? 0) + (extra?.offsetWidth ? extra.offsetWidth + 6 : 0);
      sizes.set(id, { w: Math.ceil(bw + (sub ? 11 : 14)), h: Math.max(sub ? 24 : 28, (body?.offsetHeight ?? 0) + (sub ? 4 : 6)) });
      chipSizes.set(id, { w: (c?.offsetWidth ?? 26) + 14, h: 22 });
    }
    frame.flush(); // heads for this snapshot (a new figure has none yet)
    const nodes: Box[] = [];
    for (const b of geom.obstacles) {
      const r = { x: (b.x + v.scrollX) * v.zoom - 2, y: (b.y + v.scrollY) * v.zoom - 2, w: b.w * v.zoom + 4, h: b.h * v.zoom + 4 };
      if (r.x > v.width || r.y > v.height || r.x + r.w < 0 || r.y + r.h < 0) continue;
      nodes.push(r);
    }
    if (snap.tray) nodes.push({ x: (geom.tray.x + v.scrollX) * v.zoom, y: (geom.tray.y + v.scrollY) * v.zoom, w: geom.tray.w * v.zoom, h: geom.tray.h * v.zoom });
    // Priority: whoever needs you, then the main agent, then sub-agents (writers first, as picked).
    const need = (id: string) => {
      const k = snap.states.get(id)?.seg?.kind;
      return k === "wait" || !!conflictAt(conflicts, id, snap.t);
    };
    const rank = (id: string) => (need(id) ? 0 : (snap.byId.get(id)?.depth ?? 1) === 0 ? 1 : 2);
    const list: BubbleIn[] = [];
    const roots = new Map<string, { x: number; y: number }>();
    const scr = (x: number, y: number) => ({ x: (x + v.scrollX) * v.zoom, y: (y + v.scrollY) * v.zoom });
    // The prototype stacks the bubbles of figures standing at one place (not walking), in slot order.
    const stackAt = new Map<string, string[]>();
    for (const x of [...snap.figs].sort((a, b) => a.slot - b.slot)) {
      const h = heads.current.get(x.f.run.id);
      if (!snap.bubbles.includes(x.f.run.id) || !h || h.walking) continue;
      stackAt.set(x.place, [...(stackAt.get(x.place) ?? []), x.f.run.id]);
    }
    for (const id of [...snap.bubbles].sort((a, b) => rank(a) - rank(b))) {
      const h = heads.current.get(id);
      const size = sizes.get(id);
      if (!h || !size) continue;
      const hs = scr(h.x, h.y);
      const rs = scr(h.root.x, h.root.y);
      roots.set(id, rs);
      const u = h.k * v.zoom; // screen px per figure unit
      const place = snap.figs.find((x) => x.f.run.id === id)?.place;
      const group = place ? stackAt.get(place) : undefined;
      const first = place ? geom.spots(place, h.sc / v.zoom, 1)[0] : undefined;
      const stack = group && group.length > 1 && group.includes(id) && first ? { i: group.indexOf(id), left: scr(first.x - 16, first.y).x } : undefined;
      list.push({
        proto: protoSpot(rs, h.sc, { walking: h.walking, stack }),
        id,
        x: hs.x,
        y: hs.y,
        r: h.r * v.zoom,
        lift: h.mark ? 9 * u : 0,
        ...size,
        chip: chipSizes.get(id),
        foldable: rank(id) === 2 && id !== fo.selected,
        keep: id === fo.selected,
        // a walking figure passes by: other bubbles don't dodge it (they would hop as it goes)
        body: h.walking ? undefined : { x: rs.x - 12 * u, y: rs.y - 50 * u, w: 26 * u, h: 50 * u },
        prev: (() => {
          const o = bubbleOff.current.get(id);
          const pl = lastPlace.current.get(id);
          return o && pl && !pl.chip ? { x: rs.x + o.dx, y: rs.y + o.dy, tail: pl.tail, tailX: pl.tailX, stem: pl.stem } : undefined;
        })(),
      });
    }
    const { at, folded } = placeBubbles(list, { width: v.width, height: v.height, nodes, avoid: chrome });
    bubbleSize.current = sizes;
    bubbleRank.current = new Map(list.map((b, i) => [b.id, i]));
    const next = new Map<string, { dx: number; dy: number }>();
    for (const b of list) {
      const wrap = bubbleEls.current.get(b.id);
      const el = wrap?.firstElementChild as HTMLElement | null | undefined;
      const p = at.get(b.id);
      if (!wrap || !el) continue;
      if (!p) {
        // folded: hidden where it was, counted on its dispatcher's bubble
        wrap.dataset.folded = "";
        const o = bubbleOff.current.get(b.id);
        if (o) next.set(b.id, o);
        continue;
      }
      if (wrap.hasAttribute("data-folded")) {
        // unfolding: start invisible, the frame loop fades it in once it is clear
        wrap.style.opacity = "0";
        bubbleVis.current.set(b.id, 0);
      }
      delete wrap.dataset.folded;
      lastPlace.current.set(b.id, p);
      const rt = roots.get(b.id)!;
      next.set(b.id, { dx: p.x - rt.x, dy: p.y - rt.y });
      if (p.chip) el.dataset.chip = "";
      else delete el.dataset.chip;
      if (p.tail) el.dataset.tail = p.tail;
      else delete el.dataset.tail;
      el.style.setProperty("--tail-x", `${p.tailX.toFixed(1)}px`);
      el.style.setProperty("--stem", `${p.stem.toFixed(1)}px`);
    }
    // +N on the nearest shown ancestor's bubble
    const counts = new Map<string, number>();
    for (const id of folded) {
      let p = snap.byId.get(id)?.parent;
      while (p && !at.has(p.id)) p = snap.byId.get(p.id)?.parent;
      if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
    const key = [...counts].sort().join(",");
    if (key !== foldKey.current.key) {
      // the badge changes a bubble's width: render it, then place once more (bounded per snapshot)
      foldKey.current = { key, counts };
      if (foldPass.current.snap !== snap || foldPass.current.n < 2) {
        foldPass.current = { snap, n: foldPass.current.snap === snap ? foldPass.current.n + 1 : 1 };
        setFoldCounts(counts);
      }
    }
    // keep the last offset of bubbles on their way out
    for (const [id, o] of bubbleOff.current) if (!next.has(id) && bubbleEls.current.has(id)) next.set(id, o);
    bubbleOff.current = next;
    for (const id of bubbleCur.current.keys()) if (!bubbleEls.current.has(id)) bubbleCur.current.delete(id);
    frame.flush();
  }, [snap, chrome, foldCounts]);
  // Any other commit can change a bubble's words (its width): settle positions and visibility before
  // the browser can paint it.
  useLayoutEffect(() => {
    dirty.current = true;
    frame.flush();
  });

  const t = snap.t;
  // What each bubble says, remembered so a leaving bubble keeps its words while it fades.
  const bodies = useRef(new Map<string, { kind: string; key: string; body: ReactNode; chip: ReactNode; verb: string; sub: boolean }>());
  const live = snap.bubbles.flatMap((id) => {
    const f = snap.byId.get(id);
    const st = snap.states.get(id);
    if (!f || !st) return [];
    const b = bubbleBody(f, st, t, geom, conflicts, snap.byId, snap.folded.get(id) ?? 0, foldCounts.get(id) ?? 0);
    bodies.current.set(id, { ...b, sub: f.depth > 0 });
    return [{ key: id }];
  });
  const bubbles = useExiting(live, BUBBLE_EXIT_MS);
  // the lane segment picked or under the pointer rings its node, as in the prototype
  const segPlace = (r: { run: string; i: number } | null) => {
    const g = r ? runs.byId.get(r.run)?.segs[r.i] : undefined;
    return g?.path ? (geom.locate(g.path)?.place ?? OUTSIDE) : null;
  };
  const extra: Snap["rings"] = [];
  const hp = segPlace(fo.segHover);
  const sp = segPlace(fo.segSel);
  if (hp) extra.push({ place: hp, tone: "hover" });
  if (sp) extra.push({ place: sp, tone: "sel" });
  const rings = useExiting([...snap.rings, ...extra].map((r) => ({ ...r, key: `${r.place}|${r.tone === "sel" || r.tone === "hover" ? r.tone : "busy"}` })), RING_EXIT_MS);
  return (
    <div className="ws-layer" ref={rootEl} style={{ clipPath: clip }}>
      <svg className="ws-svg" aria-hidden={!figuresOn}>
        <g ref={svgWorld}>
          <g className="ws-rings">
            {rings.map((r) => {
              const b = geom.boxOf(r.place);
              const wide = r.tone === "conflict" || r.tone === "sel" || r.tone === "hover" || r.place === OUTSIDE;
              const d = wide ? (r.place === OUTSIDE ? 6 : 7) : 4;
              return b ? <rect key={r.key} x={b.x - d} y={b.y - d} width={b.w + 2 * d} height={b.h + 2 * d} rx={wide ? 14 : 12} data-tone={r.tone} data-exit={r.exiting || undefined} vectorEffect="non-scaling-stroke" /> : null;
            })}
          </g>
          <g ref={tetherLayer} className="ws-tethers" />
          <g
            ref={figLayer}
            className="ws-figs"
            onPointerDown={(e) => {
              const id = (e.target as Element).closest("[data-run]")?.getAttribute("data-run");
              if (!id) return;
              e.stopPropagation();
              focus.select(fo.selected === id ? null : id);
            }}
            onDoubleClick={(e) => {
              const id = (e.target as Element).closest("[data-run]")?.getAttribute("data-run");
              const f = id ? snap.byId.get(id) : undefined;
              if (f) (e.stopPropagation(), openRun(f));
            }}
            onPointerOver={(e) => focus.hover((e.target as Element).closest("[data-run]")?.getAttribute("data-run") ?? null)}
            onPointerLeave={() => focus.hover(null)}
          />
        </g>
      </svg>
      {snap.tray && (
        <div className="ws-tray" ref={trayEl}>
          <b>图外</b>
          <span>这张图没关联的文件，例如 docs/</span>
        </div>
      )}
      {bubbles.map(({ key: id, exiting }) => {
        const b = bodies.current.get(id);
        const f = snap.byId.get(id);
        if (!b) return null;
        const sel = fo.selected === id;
        return (
          <div
            key={id}
            className="ws-bub-pos"
            style={{ visibility: "hidden" }}
            ref={(el) => {
              if (el) bubbleEls.current.set(id, el);
              else bubbleEls.current.delete(id);
            }}
          >
            <div
              className="ws-bub"
              data-k={b.kind}
              data-sub={b.sub || undefined}
              data-sel={sel || undefined}
              data-exit={exiting || undefined}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => focus.select(sel ? null : id)}
              onDoubleClick={() => f && openRun(f)}
              onPointerEnter={() => focus.hover(id)}
              onPointerLeave={() => focus.hover(null)}
            >
              <span className="ws-bub-in" key={b.key}>{b.body}</span>
              <span className="ws-bub-chip" key={`c${b.key}`}>{b.chip}</span>
              {sel && f?.root.sessionId && !exiting && (
                <span className="ws-acts" data-open>
                  <button onClick={(e) => (e.stopPropagation(), openRun(f))}>打开会话</button>
                </span>
              )}
            </div>
          </div>
        );
      })}
      {snap.chips.map((c) => {
        const lead = snap.byId.get(c.ids[0])!;
        const st = snap.states.get(c.ids[0])!;
        const k = st.seg?.kind === "wait" ? "wait" : st.seg?.kind === "write" ? "write" : st.pose === "idle" ? "idle" : "busy";
        const verb = st.seg?.kind === "wait" ? "等你回复" : st.seg?.kind === "write" ? "写" : st.seg?.kind === "read" ? "读" : st.seg?.kind === "exec" ? "跑" : st.pose === "idle" ? "空闲" : "思考";
        return (
          <button
            key={c.place}
            className="ws-pchip"
            data-k={k}
            ref={(el) => {
              if (el) chipEls.current.set(c.place, el);
              else chipEls.current.delete(c.place);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => openRun(lead)}
            title={c.ids.map((id) => snap.byId.get(id)?.run.name).join("、")}
          >
            <RunAvatar agent={lead.run.agent} size={18} />
            <b>{lead.run.name}</b>
            <span>{verb}</span>
            {st.seg?.path && (verb === "写" || verb === "读") && <span className="f">{base(st.seg.path)}</span>}
            {c.ids.length > 1 && <em>+{c.ids.length - 1}</em>}
          </button>
        );
      })}
      {replay && (
        <div className="ws-banner" role="status">
          <IconHistory size={14} />
          正在回放 <b ref={bannerTime}>{hhmmss(t)}</b>
          <button className="btn sm primary" onClick={() => clock.live()}>回到实时</button>
        </div>
      )}
    </div>
  );
}
