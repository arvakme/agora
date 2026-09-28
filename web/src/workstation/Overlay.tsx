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
import { IconHistory } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { clipPath } from "../canvas/chrome";
import { overlaps, type Box } from "../canvas/clearance";
import { viewport, type Viewport } from "../canvas/viewport";
import { useNested } from "../nested/store";
import { ui } from "../session/ui";
import { clock, prefersReducedMotion, useReplay } from "./clock";
import { pickBubbles, slots } from "./crowd";
import { FigureNode } from "./figureNode";
import { figurePositions, focus, useFocus } from "./focus";
import { frame } from "./frame";
import { buildGeometry, type Geometry } from "./geometry";
import { conflictAt, OUTSIDE, stateAt, writeConflicts, type Ctx, type RunState, type WriteConflict } from "./place";
import { Glide, makeSprings, solve, type Springs } from "./rig";
import { RunAvatar } from "./RunAvatar";
import { useRuns, type Runs } from "./runs/store";
import { RECEIPT_NAMES, type FlatRun } from "./runs/types";
import "./workstation.css";

const SNAP_MS = 250;
/** Screen px between figures standing side by side. */
const SLOT_PX = 40;
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
  rings: { place: string; tone: "write" | "need" }[];
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
      return { id: x.f.run.id, depth: x.f.depth, need: need(x.f), writing: writing(x.f), order: order.get(x.f.run.id)!, idle: st.pose === "idle", working: !!st.seg && st.seg.kind !== "think" };
    }),
  );
  if (selected && drawn.has(selected) && !bubbles.includes(selected)) bubbles.push(selected);
  const tethers = figs.filter((x) => x.f.parent && drawn.has(x.f.parent.id) && (x.f.run.doneAt == null || t < x.f.run.doneAt)).map((x) => ({ child: x.f.run.id, parent: x.f.parent!.id }));
  return { t, figs, bubbles, rings: ringsOf(present, states, conflicts, t), tethers, chips: [], states, byId, folded, tray: figs.some((x) => x.place === OUTSIDE) };
}

function ringsOf(list: FlatRun[], states: Map<string, RunState>, conflicts: WriteConflict[], t: number): Snap["rings"] {
  const by = new Map<string, "write" | "need">();
  for (const f of list) {
    const st = states.get(f.run.id)!;
    if (st.at === OUTSIDE || st.w < 1) continue;
    if (st.seg?.kind === "wait" || conflictAt(conflicts, f.run.id, t)) by.set(st.at, "need");
    else if (st.seg?.kind === "write" && by.get(st.at) !== "need") by.set(st.at, "write");
  }
  return [...by].map(([place, tone]) => ({ place, tone }));
}

/** What a worker's bubble says (the prototype's wording). `key` changes when the words do (cross-fade). */
function bubbleBody(f: FlatRun, st: RunState, t: number, geom: Geometry, conflicts: WriteConflict[], byId: Map<string, FlatRun>, folded: number): { kind: string; key: string; body: ReactNode } {
  const run = f.run;
  const g = st.seg;
  const par = f.parent;
  const back = !!par && run.doneAt != null && t >= run.doneAt;
  const el = g ? <span className="el">{secs(t - g.start)}</span> : null;
  const place = (p: string) => (p === OUTSIDE ? "图外" : (geom.labels.get(p) ?? "节点"));
  let kind: string = st.pose === "walk" ? "walk" : st.pose === "handoff" || st.pose === "unknown" ? st.pose : g ? g.kind : "idle";
  let body: ReactNode;
  if (kind === "walk" && back) body = <><span className="v">走回</span><span>{par!.name}</span><span className="el">交结果</span></>;
  else if (kind === "walk") body = <><span className="v">走去</span><span>{place(st.at)}</span>{g?.path && <span className="el">要{g.kind === "write" ? "写" : "读"} {base(g.path)}</span>}</>;
  else if (kind === "handoff") body = <><span className="v">交给 {par?.name}</span><span className="el">{run.via === "seedmux" ? "声明完成 ≠ 验收" : "结果回到父会话"}</span></>;
  else if (kind === "unknown") body = <span className="el">只有回执，看不到它在做什么</span>;
  else if (kind === "idle") body = <><span className="v">空闲</span><span className="el">这一轮做完了</span></>;
  else if (kind === "wait")
    body = (
      <>
        <span className="v">等你回复</span>
        {g?.question && <span className="q">{g.question}</span>}
        <button className="reply" onClick={(e) => (e.stopPropagation(), openRun(f))}>去回复</button>
      </>
    );
  else if (kind === "think") body = <><span className="v">{par && !g ? (st.receipt === "dispatched" ? "等它接单" : "确认任务") : "思考"}</span>{el}</>;
  else if (kind === "delegate") {
    const c = g?.child ? byId.get(g.child)?.run : undefined;
    body = <><span className="v">派</span><span>{c ? `${c.name}：${c.task ?? ""}` : g?.label.replace(/^派 /, "")}</span>{c && <span className="el">{c.via === "seedmux" ? "经 Seedmux" : "Task 工具"}</span>}</>;
  } else if (kind === "exec") body = <><span className="v">{g?.verifies ? "验收 · " : ""}跑</span><span className="f">{g?.cmd ?? g?.label}</span>{el}</>;
  else body = <><span className="v">{g?.verifies ? "验收 · " : ""}{kind === "write" ? "写" : "读"}</span><span className="f">{g?.path ? base(g.path) : ""}</span>{el}</>;
  const c = conflictAt(conflicts, run.id, t);
  if (c && g) {
    kind = "conflict";
    const other = byId.get(c.runs.find((x) => x !== run.id)!)?.run;
    body = <>{body}<span className="warn">{other?.name ?? "另一个 agent"} 也在改</span></>;
  }
  return {
    kind,
    key: `${kind}|${g?.start ?? st.at}|${st.receipt ?? ""}`,
    body: (
      <>
        <RunAvatar agent={run.agent} size={par ? 18 : 20} />
        {/* 「Codex · Pi 派的 · 写 … · 运行中」 */}
        {par ? <><b className="who">{run.name}</b><span className="par">· {par.name} 派的 ·</span></> : <b className="who">{run.name}</b>}
        {body}
        {st.portal && <span className="portal" title={`在子图「${st.portal.label}」里`}>↘ 子图 · {st.portal.label}</span>}
        {par && st.receipt && <span className="rc" data-r={st.receipt}>{RECEIPT_NAMES[st.receipt]}</span>}
        {folded > 0 && <span className="kbadge" title={`它又派了 ${folded} 个子代理（更深一层不画在图上，见时间线）`}>+{folded}</span>}
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
  const offs = useRef(new Map<string, Glide>());
  const tethers = useRef(new Map<string, SVGPathElement>());
  const heads = useRef(new Map<string, { x: number; y: number }>());
  const bubbleEls = useRef(new Map<string, HTMLElement>());
  /** Where each bubble should sit relative to its figure's head (decided ≤ 4 Hz)… */
  const bubbleOff = useRef(new Map<string, { dx: number; dy: number }>());
  /** …and where it is on its way there: a Hermite glide per axis, so a move or a flip starts
   * gently, keeps its speed if retargeted mid-way, and settles at rest. */
  const bubbleCur = useRef(new Map<string, { x: Glide; y: Glide }>());
  const chipEls = useRef(new Map<string, HTMLElement>());
  const trayEl = useRef<HTMLDivElement>(null);
  const bannerTime = useRef<HTMLElement>(null);
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
      if (still && !fading && Math.floor(t / 1000) === lastSec && s === drawnSnap && vkOf(v) === lastV) return;
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
        // Side by side at a node: the slot offset glides, so an arrival or a departure never jumps.
        let off = offs.current.get(run.id);
        if (!off) offs.current.set(run.id, (off = new Glide()));
        const want = x.slot * SLOT_PX * k;
        const dx = still || fresh || reset ? off.reset(want, now / 1000) : off.step(now / 1000, want);
        let wx = j.root.x + dx;
        let wy = j.root.y;
        let alpha = st.fade;
        if (still) {
          const xf = crossfade(moving, run.id, wx, wy, now);
          wx = xf.x;
          wy = xf.y;
          alpha *= xf.a;
        }
        const kk = k * sub;
        n.place(wx, wy, kk, alpha, false);
        n.draw(j, now, still);
        heads.current.set(run.id, { x: wx + j.hx * kk, y: wy + j.hy * kk });
        alphas.set(run.id, alpha / Math.max(0.001, st.fade));
        positions.set(run.id, { x: wx, y: wy });
      }
      for (const tt of s.tethers) {
        const p = tethers.current.get(tt.child);
        const a0 = heads.current.get(tt.child);
        const b0 = heads.current.get(tt.parent);
        if (!p || !a0 || !b0) continue;
        p.setAttribute("d", `M${px(a0.x)} ${px(a0.y)}Q${px((a0.x + b0.x) / 2)} ${px(Math.min(a0.y, b0.y) - 34 * k)} ${px(b0.x)} ${px(b0.y)}`);
      }
      // HTML pieces follow in screen coordinates, at sub-pixel positions.
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
        let sx = (h.x + v.scrollX) * v.zoom + bx;
        let sy = (h.y + v.scrollY) * v.zoom + by;
        if (still) {
          const xf = crossfade(bubbleMoving, id, sx, sy, now);
          sx = xf.x;
          sy = xf.y;
          alphas.set(id, Math.min(alphas.get(id) ?? 1, xf.a));
        }
        el.style.transform = `translate3d(${px(sx)}px, ${px(sy)}px, 0)`;
        if (still) {
          const a = alphas.get(id) ?? 1;
          const op = a >= 0.999 ? "" : a.toFixed(3);
          if (el.style.opacity !== op) el.style.opacity = op;
        }
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
    const sizes = new Map<string, { w: number; h: number }>();
    for (const id of snap.bubbles) {
      const el = bubbleEls.current.get(id)?.firstElementChild as HTMLElement | null | undefined;
      if (el) sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight });
    }
    frame.flush(); // heads for this snapshot (a new figure has none yet)
    const cell = 96;
    const grid = new Map<string, Box[]>();
    const cells = (r: Box, f: (key: string) => void) => {
      for (let i = Math.floor(r.x / cell); i <= Math.floor((r.x + r.w) / cell); i++) for (let j = Math.floor(r.y / cell); j <= Math.floor((r.y + r.h) / cell); j++) f(`${i},${j}`);
    };
    for (const b of geom.boxes.values()) {
      const r = { x: (b.x + v.scrollX) * v.zoom - 2, y: (b.y + v.scrollY) * v.zoom - 2, w: b.w * v.zoom + 4, h: b.h * v.zoom + 4 };
      if (r.x > v.width || r.y > v.height || r.x + r.w < 0 || r.y + r.h < 0) continue;
      cells(r, (key) => grid.set(key, [...(grid.get(key) ?? []), r]));
    }
    const hits = (r: Box) => {
      let hit = false;
      cells(r, (key) => (hit ||= (grid.get(key) ?? []).some((b) => overlaps(r, b))));
      return hit;
    };
    const placed: Box[] = [...chrome];
    const next = new Map<string, { dx: number; dy: number }>();
    for (const id of snap.bubbles) {
      const el = bubbleEls.current.get(id)?.firstElementChild as HTMLElement | null | undefined;
      const h = heads.current.get(id);
      const size = sizes.get(id);
      if (!el || !h || !size) continue;
      const hx = (h.x + v.scrollX) * v.zoom;
      const hy = (h.y + v.scrollY) * v.zoom;
      const { w, h: hh } = size;
      const inView = (x: number, y: number) => x >= 8 && x + w <= v.width - 8 && y >= 8 && y + hh <= v.height - 8;
      const ok = (x: number, y: number) => inView(x, y) && !hits({ x, y, w, h: hh }) && !placed.some((p) => overlaps(p, { x, y, w, h: hh }, 2));
      const cands: [number, number, string | null][] = [
        [hx - 20, hy - hh - 14, "d"],
        [hx - w + 28, hy - hh - 14, "dr"],
      ];
      for (let up = 1; up <= 4; up++) cands.push([hx - 20, hy - hh - 14 - up * 30, null], [hx - w + 28, hy - hh - 14 - up * 30, null]);
      // No room above (the canvas's top, its toolbar, other bubbles): under the node instead.
      const place = snap.figs.find((x) => x.f.run.id === id)?.place;
      const nb = place ? geom.boxOf(place) : undefined;
      if (nb) {
        const bottom = (nb.y + nb.h + v.scrollY) * v.zoom + 10;
        for (let i = 0; i < 4; i++) cands.push([hx - 20, bottom + i * 30, null], [hx - w + 28, bottom + i * 30, null]);
      }
      // Nothing is clear: the spot that covers the least.
      const cost = ([x, y]: [number, number, string | null]) => {
        const r = { x, y, w, h: hh };
        let c = inView(x, y) ? 0 : 1e6;
        for (const p of placed) if (overlaps(p, r)) c += (Math.min(p.x + p.w, x + w) - Math.max(p.x, x)) * (Math.min(p.y + p.h, y + hh) - Math.max(p.y, y));
        return c + (hits(r) ? 500 : 0);
      };
      const pick = cands.find(([x, y]) => ok(x, y)) ?? [...cands].sort((p, q) => cost(p) - cost(q))[0];
      next.set(id, { dx: pick[0] - hx, dy: pick[1] - hy });
      placed.push({ x: pick[0], y: pick[1], w, h: hh });
      if (pick[2]) el.dataset.tail = pick[2];
      else delete el.dataset.tail;
    }
    // keep the last offset of bubbles on their way out
    for (const [id, o] of bubbleOff.current) if (!next.has(id) && bubbleEls.current.has(id)) next.set(id, o);
    bubbleOff.current = next;
    for (const id of bubbleCur.current.keys()) if (!bubbleEls.current.has(id)) bubbleCur.current.delete(id);
    frame.flush();
  }, [snap, chrome]);

  const t = snap.t;
  // What each bubble says, remembered so a leaving bubble keeps its words while it fades.
  const bodies = useRef(new Map<string, { kind: string; key: string; body: ReactNode; sub: boolean }>());
  const live = snap.bubbles.flatMap((id) => {
    const f = snap.byId.get(id);
    const st = snap.states.get(id);
    if (!f || !st) return [];
    const b = bubbleBody(f, st, t, geom, conflicts, snap.byId, snap.folded.get(id) ?? 0);
    bodies.current.set(id, { ...b, sub: f.depth > 0 });
    return [{ key: id }];
  });
  const bubbles = useExiting(live, BUBBLE_EXIT_MS);
  const rings = useExiting(snap.rings.map((r) => ({ ...r, key: r.place })), RING_EXIT_MS);
  return (
    <div className="ws-layer" ref={rootEl} style={{ clipPath: clip }}>
      <svg className="ws-svg" aria-hidden={!figuresOn}>
        <g ref={svgWorld}>
          <g className="ws-rings">
            {rings.map((r) => {
              const b = geom.boxOf(r.place);
              return b ? <rect key={r.place} x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={12} data-tone={r.tone} data-exit={r.exiting || undefined} vectorEffect="non-scaling-stroke" /> : null;
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
