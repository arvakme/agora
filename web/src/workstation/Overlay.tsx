// 工位视图 on the canvas (web/docs/workstation.md): every agent run is a small worker standing on the
// node whose code it reads or writes — the figure IS the pointer. Its bubble says what it does;
// a node gets a 1.5px purple stroke only while someone writes there, a warm one while someone
// there waits on you or two runs write the same file. With the view off, each agent is a compact
// presence chip on its node instead. Idle agents leave after a minute.
//
// Frame-rate design (§性能):
//   - structure (which figures, bubbles, chips, rings) is rebuilt a few times a second at most
//     (`snapshot`, on data / clock events and a 4 Hz timer), never per frame;
//   - one rAF job (./frame.ts) moves what exists: one world transform for pan and zoom, and each
//     figure's joints via setAttribute; bubbles and chips follow by `transform`;
//   - node boxes, docks and the clip region are recomputed only when the scene or the panels change;
//   - bubble placement (avoid nodes and each other) runs with the snapshot, on a grid index.
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
import { makeSprings, Spring, solve, type Springs } from "./rig";
import { RunAvatar } from "./RunAvatar";
import { useRuns, type Runs } from "./runs/store";
import { RECEIPT_NAMES, type FlatRun } from "./runs/types";
import "./workstation.css";

const SNAP_MS = 250;
/** Screen px between figures standing side by side. */
const SLOT_PX = 40;
const pad2 = (n: number) => String(n).padStart(2, "0");
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒` : `${Math.round(ms / 1000)} 秒`);
const base = (p: string) => p.split("/").pop() || p;
const vkOf = (v: Viewport) => `${v.scrollX}|${v.scrollY}|${v.zoom}|${v.width}|${v.height}`;
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
  tray: boolean;
};
const EMPTY: Snap = { t: 0, figs: [], bubbles: [], rings: [], tethers: [], chips: [], states: new Map(), byId: new Map(), tray: false };

/** Structure at time t: who is on the canvas, where, who gets a bubble, which nodes get a stroke. Pure. */
export function snapshot(runs: Runs, t: number, ctx: Ctx, conflicts: WriteConflict[], figuresOn: boolean, selected: string | null): Snap {
  const states = new Map<string, RunState>();
  const present: FlatRun[] = [];
  for (const f of runs.flat) {
    const st = stateAt(f.run, t, ctx);
    states.set(f.run.id, st);
    if (st.present) present.push(f);
  }
  const need = (f: FlatRun) => states.get(f.run.id)!.seg?.kind === "wait" || !!conflictAt(conflicts, f.run.id, t);
  const writing = (f: FlatRun) => states.get(f.run.id)!.seg?.kind === "write";
  const byId = new Map(runs.flat.map((f) => [f.run.id, f]));
  const order = new Map(runs.flat.map((f, i) => [f.run.id, i]));
  if (!figuresOn) {
    // Compact presence: one chip per node, the agent that needs you (or writes) first, "+N" for the rest.
    const at = new Map<string, FlatRun[]>();
    for (const f of present) if (f.depth === 0) at.set(states.get(f.run.id)!.at, [...(at.get(states.get(f.run.id)!.at) ?? []), f]);
    const chips = [...at].map(([place, list]) => ({ place, ids: list.sort((a, b) => Number(need(b)) - Number(need(a)) || Number(writing(b)) - Number(writing(a)) || order.get(a.run.id)! - order.get(b.run.id)!).map((f) => f.run.id) }));
    return { ...EMPTY, t, chips, rings: ringsOf(present.filter((f) => f.depth === 0), states, conflicts, t), states, byId };
  }
  const slot = slots(present.map((f) => ({ id: f.run.id, place: states.get(f.run.id)!.at, order: order.get(f.run.id)! })));
  const figs: Fig[] = present.map((f) => ({ f, place: states.get(f.run.id)!.at, slot: slot.get(f.run.id) ?? 0 }));
  const drawn = new Set(figs.map((x) => x.f.run.id));
  const bubbles = pickBubbles(figs.map((x) => ({ id: x.f.run.id, depth: x.f.depth, need: need(x.f), writing: writing(x.f), order: order.get(x.f.run.id)!, idle: states.get(x.f.run.id)!.pose === "idle" })));
  if (selected && drawn.has(selected) && !bubbles.includes(selected)) bubbles.push(selected);
  const tethers = figs.filter((x) => x.f.parent && drawn.has(x.f.parent.id) && (x.f.run.doneAt == null || t < x.f.run.doneAt)).map((x) => ({ child: x.f.run.id, parent: x.f.parent!.id }));
  return { t, figs, bubbles, rings: ringsOf(present, states, conflicts, t), tethers, chips: [], states, byId, tray: figs.some((x) => x.place === OUTSIDE) };
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

/** What a worker's bubble says (the prototype's wording). */
function bubbleBody(f: FlatRun, st: RunState, t: number, geom: Geometry, conflicts: WriteConflict[], byId: Map<string, FlatRun>): { kind: string; body: ReactNode } {
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
    body: (
      <>
        <RunAvatar agent={run.agent} size={par ? 18 : 20} />
        {par ? <><b className="who">{run.name}</b><span className="par">{par.name} 派的</span></> : <b className="who">{run.name}</b>}
        {body}
        {st.portal && <span className="portal" title={`在子图「${st.portal.label}」里`}>↘ 子图 · {st.portal.label}</span>}
        {par && st.receipt && <span className="rc" data-r={st.receipt}>{RECEIPT_NAMES[st.receipt]}</span>}
      </>
    ),
  };
}

function openRun(f: FlatRun) {
  const sid = f.root.sessionId;
  if (sid) ui.openSession(sid);
}

type Props = { view: CanvasViewState; chrome: Box[]; figuresOn: boolean };

export function WorkstationOverlay({ view, chrome, figuresOn }: Props) {
  const runs = useRuns();
  const nst = useNested();
  const replay = useReplay();
  const fo = useFocus();
  const reduced = prefersReducedMotion();
  const geom = useMemo(() => buildGeometry(view.id, view.elements, view.map, nst.scenes, (id) => nst.titles[id]), [view.id, view.version, nst.scenes, nst.titles]);
  const ctx = useMemo<Ctx>(() => ({ locate: geom.locate, dock: geom.dock, reduced, run: (id) => runs.byId.get(id) }), [geom, runs, reduced]);
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
  const svgWorld = useRef<SVGGElement>(null);
  const figLayer = useRef<SVGGElement>(null);
  const tetherLayer = useRef<SVGGElement>(null);
  const nodes = useRef(new Map<string, FigureNode>());
  const springs = useRef(new Map<string, Springs>());
  const offs = useRef(new Map<string, Spring>());
  const tethers = useRef(new Map<string, SVGPathElement>());
  const heads = useRef(new Map<string, { x: number; y: number }>());
  const bubbleEls = useRef(new Map<string, HTMLElement>());
  const bubbleOff = useRef(new Map<string, { dx: number; dy: number }>());
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
    const positions = figurePositions.of(view.id);
    return frame.add((now) => {
      const v = viewport.get(view.id);
      const s = snapRef.current;
      const g = geomRef.current;
      const c = ctxRef.current;
      if (!v) return;
      const still = c.reduced;
      const t = clock.time(now);
      // Reduced motion: repaint once a second (and when the view or the snapshot changes).
      if (still && Math.floor(t / 1000) === lastSec && s === drawnSnap && vkOf(v) === lastV) return;
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
      heads.current.clear();
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
        const j = solve({ t, pose: st.pose, since: st.since, dock: g.dock(st.at), walk: st.walk, still, conflict: !!conflict && !!st.seg, bump, unknownReceipt: st.receipt === "unknown", readingWhileWalking: st.seg?.kind === "read" }, sp);
        const sub = x.f.depth > 0 ? 0.8 : 1;
        // Side by side at a node: the slot offset glides (a spring) so an arrival never jumps.
        let off = offs.current.get(run.id);
        if (!off) offs.current.set(run.id, (off = new Spring(2.4, 0.9, 0)));
        const want = x.slot * SLOT_PX * k;
        const dx = still || fresh ? off.reset(want) : off.step(1 / 60, want);
        const wx = j.root.x + dx;
        const wy = j.root.y;
        const kk = k * sub;
        n.place(wx, wy, kk, st.fade, false);
        n.draw(j, t, still);
        heads.current.set(run.id, { x: wx + j.hx * kk, y: wy + j.hy * kk });
        positions.set(run.id, { x: wx, y: wy });
      }
      for (const tt of s.tethers) {
        const p = tethers.current.get(tt.child);
        const a0 = heads.current.get(tt.child);
        const b0 = heads.current.get(tt.parent);
        if (!p || !a0 || !b0) continue;
        p.setAttribute("d", `M${a0.x.toFixed(1)} ${a0.y.toFixed(1)}Q${((a0.x + b0.x) / 2).toFixed(1)} ${(Math.min(a0.y, b0.y) - 30 * k).toFixed(1)} ${b0.x.toFixed(1)} ${b0.y.toFixed(1)}`);
      }
      // HTML pieces follow in screen coordinates.
      for (const [id, el] of bubbleEls.current) {
        const h = heads.current.get(id);
        const o = bubbleOff.current.get(id);
        if (!h || !o) {
          el.style.visibility = "hidden";
          continue;
        }
        el.style.visibility = "";
        el.style.transform = `translate(${Math.round((h.x + v.scrollX) * v.zoom + o.dx)}px, ${Math.round((h.y + v.scrollY) * v.zoom + o.dy)}px)`;
      }
      for (const [place, el] of chipEls.current) {
        const b = g.boxOf(place);
        if (!b) continue;
        el.style.transform = `translate(${Math.round((b.x + v.scrollX) * v.zoom)}px, ${Math.round((b.y + v.scrollY) * v.zoom) - 30}px)`;
      }
      if (trayEl.current && s.tray) {
        const b = g.tray;
        trayEl.current.style.transform = `translate(${Math.round((b.x + v.scrollX) * v.zoom)}px, ${Math.round((b.y + v.scrollY) * v.zoom)}px)`;
        trayEl.current.style.width = `${Math.round(b.w * v.zoom)}px`;
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
  useLayoutEffect(() => {
    const v = viewport.get(view.id);
    if (!v) return;
    frame.flush(); // heads for this snapshot
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
      const el = bubbleEls.current.get(id);
      const h = heads.current.get(id);
      if (!el || !h) continue;
      const hx = (h.x + v.scrollX) * v.zoom;
      const hy = (h.y + v.scrollY) * v.zoom;
      const w = el.offsetWidth;
      const hh = el.offsetHeight;
      const ok = (x: number, y: number) => x >= 8 && x + w <= v.width - 8 && y >= 8 && !hits({ x, y, w, h: hh }) && !placed.some((p) => overlaps(p, { x, y, w, h: hh }, 2));
      const cands: [number, number, string | null][] = [
        [hx - 20, hy - hh - 14, "d"],
        [hx - w + 28, hy - hh - 14, "dr"],
      ];
      for (let up = 1; up <= 4; up++) cands.push([hx - 20, hy - hh - 14 - up * 30, null], [hx - w + 28, hy - hh - 14 - up * 30, null]);
      const pick = cands.find(([x, y]) => ok(x, y)) ?? cands[0];
      next.set(id, { dx: pick[0] - hx, dy: pick[1] - hy });
      placed.push({ x: pick[0], y: pick[1], w, h: hh });
      if (pick[2]) el.dataset.tail = pick[2];
      else delete el.dataset.tail;
    }
    bubbleOff.current = next;
    frame.flush();
  }, [snap, chrome]);

  const t = snap.t;
  return (
    <div className="ws-layer" style={{ clipPath: clip }}>
      <svg className="ws-svg" aria-hidden={!figuresOn}>
        <g ref={svgWorld}>
          <g className="ws-rings">
            {snap.rings.map((r) => {
              const b = geom.boxOf(r.place);
              return b ? <rect key={r.place} x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={12} data-tone={r.tone} vectorEffect="non-scaling-stroke" /> : null;
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
      {snap.bubbles.map((id) => {
        const f = snap.byId.get(id);
        const st = snap.states.get(id);
        if (!f || !st) return null;
        const { kind, body } = bubbleBody(f, st, t, geom, conflicts, snap.byId);
        const sel = fo.selected === id;
        return (
          <div
            key={id}
            className="ws-bub"
            data-k={kind}
            data-sub={f.depth > 0 || undefined}
            data-sel={sel || undefined}
            ref={(el) => {
              if (el) bubbleEls.current.set(id, el);
              else bubbleEls.current.delete(id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => focus.select(sel ? null : id)}
            onDoubleClick={() => openRun(f)}
            onPointerEnter={() => focus.hover(id)}
            onPointerLeave={() => focus.hover(null)}
          >
            {body}
            {sel && f.root.sessionId && (
              <span className="ws-acts" data-open>
                <button onClick={(e) => (e.stopPropagation(), openRun(f))}>打开会话</button>
              </span>
            )}
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
