// The timeline under the canvas (web/docs/workstation.md §时间线) — the 工位视图 prototype's timeline
// (workstation-proto renderTimeline / dynHTML), ported: the same markup, class names and CSS.
//   - compact (the default): a header (title, state pill, play / step / speed, hint, 图例, expand,
//     close) and one 30 px lane per run, sub-agents indented under their dispatcher with a thin
//     receipt band; labelled segments, walk bars, dispatch / hand-back connectors, collapsed idle
//     gaps (zig-zag, real length in words), a conflict band, the playhead knob with its time.
//   - full: taller lanes with a 「在 API 服务」 row under each, receipt bands with words, the legend
//     row, and the detail of the picked segment in a right column (compact: a card over the canvas).
//   - ✕ minimises it to the 34 px strip (workbench-focus states b–d); ⤢ on the strip brings it back.
// Structure is rebuilt at most 4 times a second (useTick); the playhead, its knob and the strip's
// canvas move in the one frame loop by transform; only the lanes in view are rendered.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconBack, IconClose, IconCode, IconCpu, IconEnter, IconEye, IconHistory, IconMessage, IconPause, IconPlay, IconSend, IconTarget, IconTerminal } from "../app/icons";
import { openTrajectory, ui } from "../session/ui";
import { advance, buildAxis, hhmmss, ticks, type Axis } from "./axis";
import { clock, prefersReducedMotion as reducedMotion, replayTime, useReplay, useTick } from "./clock";
import { motion } from "motion/react";
import { focus, useFocus, type SegRef } from "./focus";
import { frame } from "./frame";
import { canvasWhere, OUTSIDE, planFor, stateAt, writeConflicts, type Ctx } from "./place";
import { RunAvatar } from "./RunAvatar";
import { useRuns } from "./runs/store";
import { FINAL, RECEIPT_NAMES, receiptAt, receiptView, type WorkRun, type FlatRun, type RunSeg } from "./runs/types";

const MINI_COLORS: Record<string, string> = { write: "--accent-fill", read: "--accent-soft", exec: "--series-3", think: "--line-strong", wait: "--caution-dot", delegate: "--accent", gap: "--line-strong" };
let miniPalette: { theme: string; c: Record<string, string> } | null = null;
/** The minimised strip: up to three main agents as thin rows, collapsed idle stretches hatched. `prev` + `u` blend a rebuilt axis in. */
function drawMini(cv: HTMLCanvasElement, runs: WorkRun[], A: Axis, prev: Axis | null, u: number, now: number) {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const theme = document.documentElement.dataset.resolved ?? "";
  if (!miniPalette || miniPalette.theme !== theme) {
    const cs = getComputedStyle(cv);
    miniPalette = { theme, c: Object.fromEntries(Object.entries(MINI_COLORS).map(([k, v]) => [k, cs.getPropertyValue(v).trim() || "#999"])) };
  }
  const c = miniPalette.c;
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const sx = w / A.width;
  const at = (X: Axis, t: number) => (t <= X.end ? X.toPx(t) : X.toPx(X.end) + (t - X.end) * X.pps);
  const X = (t: number) => (u >= 1 || !prev ? at(A, t) : at(prev, t) + (at(A, t) - at(prev, t)) * u) * sx;
  const n = runs.length;
  runs.forEach((r, i) => {
    const y = (i * h) / n + 1;
    const rh = h / n - 2;
    for (const s of r.segs) {
      if (s.start >= now) break;
      const x0 = X(s.start);
      const x1 = X(Math.min(s.end, now));
      g.fillStyle = c[s.kind] ?? c.think;
      g.fillRect(x0, y, Math.max(1, x1 - x0 - 0.5), rh);
    }
  });
  g.fillStyle = c.gap;
  for (const p of A.pieces) {
    if (p.kind === "act") continue;
    const x0 = X(p.a + 1);
    const x1 = X(p.b - 1);
    for (let x = x0; x < x1; x += 4) g.fillRect(x, 0, 1, h);
  }
}

type Size = "min" | "compact" | "full";
/** The prototype's lane metrics (PX()): lane, location row, sub lane, receipt band, ruler. */
const PX = (size: Size) => (size === "full" ? { lane: 32, loc: 18, sub: 24, rc: 16, ruler: 22 } : { lane: 30, loc: 0, sub: 20, rc: 7, ruler: 18 });
/** The prototype's axis: a stretch with nobody working for more than 8 s collapses to 88 px. */
const AXIS = { gapMs: 8_000, gapPx: 88 };
const SPEEDS = [1, 2, 4];
/** When the timeline last changed height (lanes added, expand / collapse): the canvas above then
 * keeps its top edge instead of re-centring, so the diagram and the figures don't slide. */
export const timelineResize = { at: -Infinity };
const WARM = "回放比实时晚这时没人在干活拖到最右端或按回到实时播放会跳过空闲这之后已经发生拖回来看正在回放暂停从这里上一步下一步0123456789:·秒分小时";
const KIND_NAME: Record<string, string> = { read: "读文件", write: "写文件", exec: "执行命令", think: "思考", wait: "等你回复", delegate: "派子代理" };
const KIND_ICON: Record<string, typeof IconEye> = { read: IconEye, write: IconCode, exec: IconTerminal, think: IconCpu, wait: IconMessage, delegate: IconSend };
const dur = (ms: number) => {
  const s = ms / 1000;
  return s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, "0")} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
};
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒` : `${Math.round(ms / 1000)} 秒`);
const base = (p: string) => p.split("/").pop() || p;
const fullName = (f: FlatRun) => (f.parent ? `${f.run.name}（${f.parent.name} 派）` : f.run.name);

/** What a run is doing at t, in a few words (lane names, the strip's state). */
export function nowText(run: WorkRun, t: number, placeOf?: (path: string) => string | undefined): { k: string; text: string } {
  const g = run.segs.find((s) => s.start <= t && t < s.end);
  if (run.parentId) {
    const r = receiptAt(run, t);
    return { k: r ?? "idle", text: g ? g.label : r ? RECEIPT_NAMES[r] : "" };
  }
  if (!g) return { k: "idle", text: "空闲" };
  const where = g.path && placeOf ? placeOf(g.path) : undefined;
  return { k: g.kind, text: `${g.kind === "wait" ? "等你回复" : g.label}${where ? ` · ${where}` : ""}` };
}

type Row = { f: FlatRun; y: number; h: number; mid: number; sub: boolean };

/** Renders `node` again only when `k` changes (lane names: same words, no re-render at 4 Hz). */
const Keyed = memo(({ node }: { node: ReactNode; k: string }) => <>{node}</>, (a, b) => a.k === b.k);

/** A run's walks up to t (the plans the figures follow), cached until another call starts. */
const walkCache = new WeakMap<WorkRun, { key: string; ctx: Ctx; walks: { t0: number; t1: number; to: string }[] }>();
function walksOf(run: WorkRun, t: number, ctx: Ctx) {
  const started = run.segs.filter((g) => g.start <= t).length;
  const key = `${started}|${run.doneAt != null && t >= run.doneAt}`;
  const hit = walkCache.get(run);
  if (hit && hit.key === key && hit.ctx === ctx && hit.walks.every((w) => w.t1 <= t)) return hit.walks;
  const walks = stateAt(run, t, ctx).moves.map((m) => {
    const p = planFor(m, ctx);
    return { t0: p.t0, t1: p.t1, to: m.to };
  });
  walkCache.set(run, { key, ctx, walks });
  return walks;
}

/** The prototype's zig-zag in a collapsed stretch. */
function Zig({ h }: { h: number }) {
  const z = (o: number) => {
    let d = `M${o} 0`;
    for (let y = 0; y < h; y += 6) d += ` L${o + 3} ${y + 3} L${o} ${y + 6}`;
    return d;
  };
  return (
    <svg className="zz" width="14" height={h} viewBox={`0 0 14 ${h}`} aria-hidden>
      <path d={z(2)} fill="none" stroke="var(--fg-faint)" strokeWidth="1.1" />
      <path d={z(8)} fill="none" stroke="var(--fg-faint)" strokeWidth="1.1" />
    </svg>
  );
}


/**
 * A lane's finished segments. They only move when the axis rescales, so between rescales a
 * rebuild re-renders just the running call (18 agents × hundreds of calls stay cheap).
 */
const Finished = memo(
  function Finished({ run, n, axis, top, h, selI, hovI }: { run: WorkRun; n: number; axis: Axis; axisKey: string; top: number; h: number; selI: number; hovI: number; last: number }) {
    return (
      <>
        {run.segs.slice(0, n).map((g, i) => {
          const x0 = axis.toPx(g.start);
          const w = axis.toPx(g.end) - x0;
          return (
            <span key={i} className="sg" data-seg={i} data-run={run.id} data-k={g.kind} data-sel={selI === i || undefined} data-hover={hovI === i || undefined} style={{ left: x0, width: Math.max(0, w - 1), top, height: h }}>
              {w > 34 && <span>{g.label}</span>}
            </span>
          );
        })}
      </>
    );
  },
  (a, b) => a.run.id === b.run.id && a.n === b.n && a.last === b.last && a.axisKey === b.axisKey && a.top === b.top && a.h === b.h && a.selI === b.selI && a.hovI === b.hovI,
);

export function Timeline({ canvasId, empty, onLocate }: { canvasId?: string; empty?: boolean; onLocate?: (runId: string) => void }) {
  const runs = useRuns();
  const replay = useReplay();
  const fo = useFocus();
  const [size, setSize] = useState<Size>("compact");
  const [legend, setLegend] = useState(false);
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [tip, setTip] = useState<{ ref: SegRef; x: number; y: number } | null>(null);
  const [spd, setSpd] = useState(1);
  // Lanes and the axis are rebuilt at most 4 times a second.
  const now = useTick(250, true);
  const t = replay ? replayTime(replay, now) : now;
  const track = useRef<HTMLDivElement | null>(null);
  const mini = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [tw, setTw] = useState(600);
  const [mw, setMw] = useState(300);
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const ro = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((es) => {
            for (const e of es) {
              if (e.target === track.current) setTw(Math.round(e.contentRect.width));
              if (e.target === mini.current) setMw(Math.round(e.contentRect.width));
            }
          }),
    [],
  );
  useEffect(() => () => ro?.disconnect(), [ro]);
  const observe = (r: { current: HTMLDivElement | null }) => (el: HTMLDivElement | null) => {
    if (r.current && r.current !== el) ro?.unobserve(r.current);
    r.current = el;
    if (el) ro?.observe(el);
  };
  const trackRef = useMemo(() => observe(track), []);
  const miniRef = useMemo(() => observe(mini), []);
  // Size changes animate the height (the lanes' height is measured).
  const [fullH, setFullH] = useState(240);
  const [animating, setAnimating] = useState(false);
  const innerRO = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((es) => {
            timelineResize.at = performance.now();
            setFullH(Math.ceil(es[0].contentRect.height));
          }),
    [],
  );
  const innerRef = useMemo(() => {
    let cur: HTMLDivElement | null = null;
    return (el: HTMLDivElement | null) => {
      if (cur) innerRO?.unobserve(cur);
      cur = el;
      if (el) innerRO?.observe(el);
    };
  }, [innerRO]);
  useEffect(() => () => innerRO?.disconnect(), [innerRO]);

  const flat = runs.flat;
  const intervals = useMemo(() => flat.flatMap((f) => [...f.run.segs.map((s) => [s.start, s.end] as const), ...f.run.receipts.map((r) => [r.at, r.at + 500] as const)]), [flat]);
  const liveNow = Math.floor(now / 250) * 250;
  // The axis runs a little past now (2 % of the span, 0.5–6 s) and rescales only when now gets
  // there, so between rescales finished segments keep their pixels and are not re-rendered.
  const headroom = useRef(0);
  const firstAt = useMemo(() => intervals.reduce((m, i) => Math.min(m, i[0]), Infinity), [intervals]);
  const first = Number.isFinite(firstAt) ? firstAt : liveNow;
  const slack = Math.max(500, Math.min(6000, (liveNow - first) * 0.02));
  if (liveNow >= headroom.current || headroom.current - liveNow > 2 * slack + 500) headroom.current = liveNow + slack;
  const axisEnd = headroom.current;
  const axis = useMemo(() => buildAxis(intervals, axisEnd, Math.max(100, tw), AXIS), [intervals, axisEnd, tw]);
  const axisKey = `${axis.width}|${axis.pieces.map((p) => `${p.kind}${p.a}-${p.b}`).join(",")}`;
  const maxis = useMemo(() => buildAxis(intervals, liveNow, Math.max(60, mw), { gapPx: 14 }), [intervals, liveNow, mw]);
  const conflicts = useMemo(() => writeConflicts(flat.map((f) => f.run)), [flat]);
  const where = canvasId ? canvasWhere.get(canvasId) : undefined;
  const placeOfPath = (p: string) => (where ? where.label(where.ctx.locate(p)?.place ?? OUTSIDE) : undefined);
  const P = PX(size);

  // Rows: top-level runs; their sub-agents under them unless folded; deeper ones fold into the parent.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = P.ruler;
    for (const f of flat) {
      if (f.depth >= 2) continue;
      if (f.depth === 1 && fold[f.root.id]) continue;
      if (f.depth === 1 && (f.run.spawnAt == null || f.run.spawnAt > liveNow)) continue;
      const h = f.depth ? P.sub + P.rc : P.lane + P.loc;
      out.push({ f, y, h, mid: y + (f.depth ? P.sub / 2 : P.lane / 2), sub: f.depth > 0 });
      y += h;
    }
    return out;
  }, [flat, fold, liveNow, P.ruler, P.sub, P.rc, P.lane, P.loc]);
  const height = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : P.ruler + P.lane;

  // ── playhead: the frame loop moves it by transform ──
  const ph = useRef<HTMLSpanElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const mph = useRef<HTMLSpanElement>(null);
  const future = useRef<HTMLSpanElement>(null);
  const shown = useRef({ x: -1, mx: -1 });
  const axRef = useRef({ axis, maxis, prevM: null as Axis | null, from: null as { x: number; mx: number } | null, at: 0 });
  if (axRef.current.axis !== axis || axRef.current.maxis !== maxis) axRef.current = { axis, maxis, prevM: axRef.current.maxis, from: shown.current.x >= 0 ? { ...shown.current } : null, at: performance.now() };
  const miniCanvas = useRef<HTMLCanvasElement>(null);
  const sectionEl = useRef<HTMLElement>(null);
  const miniRuns = useRef<WorkRun[]>([]);
  useEffect(
    () =>
      frame.add((n) => {
        if (sectionEl.current?.closest('[data-hidden="true"]')) return;
        const tt = clock.time(n);
        const { axis: A, maxis: M, from, at: since } = axRef.current;
        const lin = from ? Math.min(1, (performance.now() - since) / 300) : 1;
        const u = lin * lin * (3 - 2 * lin);
        const at = (X: Axis, time: number) => Math.min(X.width - 1, time <= X.end ? X.toPx(time) : X.toPx(X.end) + (time - X.end) * X.pps);
        const blend = (X: Axis, x0: number | undefined, time: number) => (u >= 1 || x0 == null ? at(X, time) : x0 + (at(X, time) - x0) * u);
        const x = blend(A, from?.x, Math.min(tt, n));
        shown.current.x = x;
        if (ph.current) ph.current.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        if (future.current) future.current.style.left = `${x.toFixed(2)}px`;
        if (knob.current) {
          const txt = clock.get() ? hhmmss(tt) : "现在";
          const span = knob.current.lastChild as Text | null;
          if (span && span.textContent !== txt) span.textContent = txt;
          knob.current.toggleAttribute("data-replay", !!clock.get());
        }
        const mx = blend(M, from?.mx, Math.min(tt, n));
        shown.current.mx = mx;
        if (mph.current) mph.current.style.transform = `translate3d(${mx.toFixed(2)}px, 0, 0)`;
        const cv = miniCanvas.current;
        if (cv) drawMini(cv, miniRuns.current, M, axRef.current.prevM, u, n);
      }),
    [],
  );

  // ── scrubbing and picking a segment ──
  const drag = useRef<{ x: number; moved: boolean; el: HTMLElement; A: Axis; seg: HTMLElement | null } | null>(null);
  const gaps = (A: Axis) => A.pieces.filter((p) => p.kind === "gap").map((p) => ({ a: p.a, b: p.b }));
  const timeAt = (el: HTMLElement, A: Axis, cx: number) => {
    const r = el.getBoundingClientRect();
    return A.fromPx(Math.max(0, Math.min(A.width, ((cx - r.left) / r.width) * A.width)));
  };
  const seek = (at: number, A: Axis) => {
    if (at >= Date.now() - 250) return clock.live();
    clock.seek(Math.max(A.start, at), Date.now(), gaps(A));
  };
  const scrub = (A: Axis) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, moved: false, el: e.currentTarget, A, seg: (e.target as HTMLElement).closest<HTMLElement>("[data-seg]") };
      setTip(null);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) {
        const sg = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
        const ref = sg ? { run: sg.dataset.run!, i: Number(sg.dataset.seg) } : null;
        focus.hoverSeg(ref);
        setTip(ref && sg ? { ref, x: e.clientX, y: sg.getBoundingClientRect().top } : null);
        return;
      }
      if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
      if (d.moved) {
        focus.selectSeg(null);
        setTip(null);
        seek(timeAt(d.el, d.A, e.clientX), d.A);
      }
    },
    onPointerLeave: () => {
      focus.hoverSeg(null);
      setTip(null);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d || d.moved) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const sg = el?.closest<HTMLElement>("[data-seg]") ?? d.seg;
      if (sg) return pickSeg(sg.dataset.run!, Number(sg.dataset.seg));
      focus.selectSeg(null);
      seek(timeAt(d.el, d.A, e.clientX), d.A);
    },
  });
  /** The prototype's select(): pick the segment (detail card, node ring) and jump to its middle. */
  const pickSeg = (runId: string, i: number) => {
    const g = runs.byId.get(runId)?.segs[i];
    if (!g) return;
    focus.selectSeg({ run: runId, i });
    seek(Math.min(g.start + (g.end - g.start) / 2, Date.now() - 300), axis);
  };
  const openSeg = (runId: string, g: RunSeg) => {
    const root = runs.flat.find((x) => x.run.id === runId)?.root;
    if (!root?.sessionId) return;
    ui.openSession(root.sessionId);
    if (g.turn) setTimeout(() => openTrajectory(root.sessionId!, g.turn!), 120);
  };
  const stepEvent = (dir: 1 | -1) => {
    const bounds = [...new Set(flat.flatMap((f) => f.run.segs.filter((g) => g.kind !== "think").map((g) => g.start)))].filter((x) => x < Date.now()).sort((a, b) => a - b);
    const next = dir > 0 ? bounds.find((b) => b > t + 50) : [...bounds].reverse().find((b) => b < t - 50);
    if (next == null) return dir > 0 ? clock.live() : undefined;
    seek(next + 50, axis);
  };
  const play = () => {
    const from = replay ? (axis.gapAt(t) ? (axis.gapAt(t)!.kind === "tail" ? axis.start : axis.gapAt(t)!.b) : t) : axis.start;
    clock.play(from >= Date.now() - 300 ? axis.start : from, Date.now(), replay?.speed ?? spd, gaps(axis));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.shiftKey ? 5000 : 1000) * (e.key === "ArrowLeft" ? -1 : 1);
      seek(Math.max(axis.start, t + step), axis);
    } else if (e.key === "[") stepEvent(-1);
    else if (e.key === "]") stepEvent(1);
    else if (e.key === " ") {
      e.preventDefault();
      if (replay?.playing) clock.pause();
      else play();
    } else if (e.key === "Escape") {
      focus.selectSeg(null);
      clock.live();
    }
  };

  if (empty || !runs.flat.length) return null;

  const tops = runs.flat.filter((f) => f.depth === 0);
  miniRuns.current = tops.slice(0, 3).map((f) => f.run);
  const kidsOf = (id: string) => runs.flat.filter((x) => x.depth === 1 && x.parent?.id === id);
  const tail = axis.pieces.at(-1)?.kind === "tail" ? axis.pieces.at(-1)! : null;

  // ── the prototype's state pill ──
  const stateBox = replay ? (
    <span className="state" data-mode="replay">
      <IconHistory size={14} />回放 <b>{hhmmss(t)}</b>
      <span className="sub">· {axis.gapAt(t) ? "这时没人在干活" : `比实时晚 ${dur(now - t)}`}</span>
    </span>
  ) : (
    <span className="state" data-mode="live">
      <i />实时 <b style={{ fontWeight: 500 }}>{hhmmss(now)}</b>
      <span className="sub">· {tail ? `都空闲了 ${dur(now - tail.a)}` : "跟随最新动作"}</span>
    </span>
  );

  // ── minimised: the 34 px strip ──
  if (size === "min") {
    const waiting = tops.filter((f) => f.run.segs.some((g) => g.kind === "wait" && g.start <= now && now < g.end));
    const busy = tops.filter((f) => f.run.running || f.run.segs.some((g) => g.start <= now && now < g.end));
    let state: { k: string; node: ReactNode };
    if (waiting.length) state = { k: "wait", node: <><i className="dot-c" /><b>{waiting[0].run.name}</b>在等你回复</> };
    else if (busy.length === 1) {
      const n = nowText(busy[0].run, now, placeOfPath);
      state = { k: n.k, node: <><i className="live" /><b>{busy[0].run.name}</b>{n.text}</> };
    } else if (busy.length > 1) state = { k: "busy", node: <><i className="live" />{busy.length} 个会话在干活</> };
    else state = { k: "idle", node: <>都空闲</> };
    const subs = runs.flat.filter((f) => f.depth > 0).length;
    return (
      <section className="ws-tl" ref={sectionEl} data-size="min" aria-label="工位时间线">
        <div className="ws-bar">
          <button className="ttl" onClick={() => setSize("compact")} title="展开时间线">
            <IconHistory size={14} />
            工位
          </button>
          <span className="stt" data-k={state.k}>{replay ? <><b className="rp">回放 {hhmmss(t)}</b>比实时晚 {dur(now - t)}</> : state.node}</span>
          <div className="mini" ref={miniRef} {...scrub(maxis)} title="拖动回看任意时刻" role="slider" aria-label="回放位置" aria-valuemin={maxis.start} aria-valuemax={maxis.end} aria-valuenow={Math.round(t)} aria-valuetext={hhmmss(t)} tabIndex={0} onKeyDown={onKey}>
            <canvas ref={miniCanvas} className="mini-cv" aria-hidden />
            <span className="mph" ref={mph} data-replay={replay ? "" : undefined} />
          </div>
          <span className="ws-cnt" title={tops.map((f) => f.run.name).join("、")}>
            <span className="stack">{tops.slice(0, 3).map((f) => <RunAvatar key={f.run.id} agent={f.run.agent} size={18} />)}</span>
            {tops.length} 个会话{subs ? ` · ${subs} 个子代理` : ""}
            {waiting.length > 0 && <span className="need"><i className="dot-c" />{waiting.length} 等你</span>}
          </span>
          <button className="icon-btn sm muted" onClick={() => setSize("compact")} aria-label="展开时间线" title="展开时间线"><IconEnter size={14} /></button>
        </div>
      </section>
    );
  }

  // Positions by transform (sub-pixel); widths grow — both glide between the 4 Hz rebuilds (CSS).
  // Placed by `left`, not transform: a transform per segment gives each its own paint chunk (a 3D
  // one its own layer), which made every frame's layerize pay for thousands of segments.
  const X = (A: Axis, a: number, b: number, minus = 1) => ({ left: A.toPx(a), width: Math.max(0, A.toPx(b) - A.toPx(a) - minus) });
  const tx = (x: number) => ({ left: x });
  const visible = rows.filter((r) => r.y + r.h >= scroll.top - 40 && r.y <= scroll.top + scroll.h + 40);
  const full = size === "full";
  const sel = fo.segSel;
  const selSeg = sel ? runs.byId.get(sel.run)?.segs[sel.i] : undefined;
  const selF = sel ? runs.flat.find((x) => x.run.id === sel.run) : undefined;

  const laneName = (r: Row) => {
    const run = r.f.run;
    if (r.sub) {
      const rc = receiptAt(run, t);
      const chip = rc ? <span className="rc" data-r={rc}>{RECEIPT_NAMES[rc]}</span> : null;
      return (
        <Keyed key={run.id} k={`${r.y}|${r.h}|${rc}|${full}|${run.task}|${run.name}`} node={
        <button className="lname sub" style={{ top: r.y, height: r.h }} onClick={() => onLocate?.(run.id)} onPointerEnter={() => focus.hover(run.id)} onPointerLeave={() => focus.hover(null)} title={`${run.task ?? ""} · ${run.via === "seedmux" ? "Seedmux worker" : "原生子代理"}`}>
          <RunAvatar agent={run.agent} size={18} parent={r.f.parent?.agent} />
          <span className="t">
            <b>{fullName(r.f)}</b>
            <span className="now" data-k={rc ?? "idle"}>{full ? <>{run.task} {chip}</> : chip}</span>
          </span>
        </button>} />
      );
    }
    const g = run.segs.find((s) => s.start <= t && t < s.end);
    const k = g ? g.kind : "idle";
    const text = g ? (k === "wait" ? "等你回复" : g.label) : "空闲";
    const place = g?.path ? placeOfPath(g.path) : undefined;
    const nk = kidsOf(run.id).filter((x) => x.run.spawnAt != null && x.run.spawnAt < liveNow).length;
    return (
      <Keyed key={run.id} k={`${r.y}|${r.h}|${k}|${text}|${place}|${nk}|${!!fold[run.id]}|${run.name}`} node={
      <div className="lname" role="button" tabIndex={0} style={{ top: r.y, height: r.h }} onClick={() => onLocate?.(run.id)} onPointerEnter={() => focus.hover(run.id)} onPointerLeave={() => focus.hover(null)} title="在画布上找到它">
        <RunAvatar agent={run.agent} size={22} />
        <span className="t">
          <b>
            {run.name}
            {nk > 0 && (
              <span className="fold" role="button" aria-expanded={!fold[run.id]} title={`${fold[run.id] ? "展开" : "收起"}子代理`} onClick={(e) => (e.stopPropagation(), setFold((o) => ({ ...o, [run.id]: !o[run.id] })))}>
                {fold[run.id] ? "▸" : "▾"} {nk}
              </span>
            )}
          </b>
          <span className="now" data-k={k}>{text}{place ? ` · ${place}` : ""}</span>
        </span>
        {r.f.root.sessionId && (
          <span className="lacts">
            <button onClick={(e) => (e.stopPropagation(), ui.openSession(r.f.root.sessionId!))}>打开会话</button>
          </span>
        )}
      </div>} />
    );
  };

  const lane = (r: Row) => {
    const run = r.f.run;
    const segTop = r.sub ? 3 : 5;
    const segH = r.sub ? P.sub - 6 : P.lane - 10;
    const out: ReactNode[] = [];
    let n = 0;
    while (n < run.segs.length && run.segs[n].end <= liveNow) n++;
    const selI = sel?.run === run.id ? sel.i : -1;
    const hovI = fo.segHover?.run === run.id ? fo.segHover.i : -1;
    out.push(<Finished key="f" run={run} n={n} last={n ? run.segs[n - 1].end : 0} axis={axis} axisKey={axisKey} top={segTop} h={segH} selI={selI} hovI={hovI} />);
    run.segs.forEach((g, i) => {
      if (i < n || g.start >= liveNow) return;
      const e = Math.min(g.end, liveNow);
      const w = axis.toPx(e) - axis.toPx(g.start);
      const isSel = sel?.run === run.id && sel.i === i;
      const isHov = fo.segHover?.run === run.id && fo.segHover.i === i;
      out.push(
        <span key={`s${i}`} className="sg" data-seg={i} data-run={run.id} data-k={g.kind} data-sel={isSel || undefined} data-hover={isHov || undefined} data-running={g.end > liveNow || undefined} style={{ ...X(axis, g.start, e), top: segTop, height: segH }}>
          {w > 34 && <span>{g.label}</span>}
        </span>,
      );
    });
    // walk bars: where the worker walked to another node (from the same plans the figures use)
    if (where && !where.ctx.reduced)
      for (const [j, w] of walksOf(run, liveNow, where.ctx).entries())
        out.push(<span key={`w${j}`} className="walk" style={X(axis, w.t0, Math.min(w.t1, liveNow), 0)} title={`走到 ${where.label(w.to)} · ${secs(w.t1 - w.t0)}`} />);
    if (r.sub) {
      // receipts: what the dispatcher was told, in its words
      const rc = run.receipts.filter((x) => x.at < liveNow);
      rc.forEach((x, i) => {
        const v = receiptView(run, x);
        const end = i + 1 < rc.length ? rc[i + 1].at : FINAL.has(v) || v === "accepted" ? Math.min(liveNow, x.at + 1200) : liveNow;
        const w = axis.toPx(end) - axis.toPx(x.at);
        out.push(<span key={`r${i}`} className="rcb" data-r={v} style={{ ...X(axis, x.at, end), top: P.sub, height: P.rc - 2 }} title={`${RECEIPT_NAMES[v]} · ${hhmmss(x.at)}`}>{full && w > 40 ? RECEIPT_NAMES[v] : ""}</span>);
      });
    } else if (full && where) {
      // where the worker was: answers "why is it standing there"
      const spans: [string, number, number][] = [];
      let cur: string | null = null;
      let from = run.segs[0]?.start ?? liveNow;
      for (const g of run.segs) {
        if (g.start >= liveNow) break;
        if (!g.path) continue;
        const p = where.ctx.locate(g.path)?.place ?? OUTSIDE;
        if (cur == null) cur = p;
        else if (p !== cur) {
          spans.push([cur, from, g.start]);
          cur = p;
          from = g.start;
        }
      }
      if (cur != null) spans.push([cur, from, liveNow]);
      const selPlace = selSeg?.path && sel?.run === run.id ? (where.ctx.locate(selSeg.path)?.place ?? OUTSIDE) : null;
      spans.forEach(([p, a, b], i) => {
        const w = axis.toPx(b) - axis.toPx(a);
        out.push(<span key={`l${i}`} className="loc" data-out={p === OUTSIDE || undefined} data-hl={selPlace === p || undefined} style={{ ...X(axis, a, b, 2), top: P.lane }} title={`在 ${where.label(p)}`}>{w > 30 ? `在 ${where.label(p)}` : ""}</span>);
      });
    }
    if (!r.sub && fold[run.id])
      for (const k of kidsOf(run.id)) {
        if (k.run.spawnAt == null || k.run.spawnAt >= liveNow) continue;
        out.push(<span key={`k${k.run.id}`} className="kidmark" style={tx(axis.toPx(k.run.spawnAt))} title={`${hhmmss(k.run.spawnAt)} 派出 ${fullName(k)}：${k.run.task ?? ""}`} />);
        if (k.run.doneAt != null && k.run.doneAt < liveNow) out.push(<span key={`kb${k.run.id}`} className="kidmark back" style={tx(axis.toPx(k.run.doneAt))} title={`${hhmmss(k.run.doneAt)} ${fullName(k)} 交回`} />);
      }
    return (
      <div key={run.id} className={r.sub ? "lane sub" : "lane"} style={{ top: r.y, height: r.h }}>
        {out}
      </div>
    );
  };

  const tipCard = (() => {
    if (!tip) return null;
    const f = runs.flat.find((x) => x.run.id === tip.ref.run);
    const g = f?.run.segs[tip.ref.i];
    if (!f || !g) return null;
    const what = g.path ? <span className="mono">{g.path}</span> : g.cmd ? <span className="mono">{g.cmd}</span> : g.question ?? g.label;
    const end = Math.min(g.end, now);
    return (
      <div className="tip" role="tooltip" style={{ left: Math.max(8, Math.min(innerWidth - 328, tip.x - 160)), top: tip.y - 8, transform: "translateY(-100%)" }}>
        <h4><RunAvatar agent={f.run.agent} size={16} />{f.run.name} · {KIND_NAME[g.kind] ?? g.kind}</h4>
        <div style={{ marginBottom: 6 }}>{what}</div>
        <dl>
          <dt>在</dt><dd>{g.path ? (placeOfPath(g.path) ?? "—") : where ? where.label(stateAt(f.run, g.start + 10, where.ctx).at) : "—"}</dd>
          <dt>时间</dt><dd>{hhmmss(g.start)}–{hhmmss(end)} · {secs(end - g.start)}</dd>
          {g.turn != null && <><dt>轮次</dt><dd>第 {g.turn} 轮</dd></>}
        </dl>
        <div className="foot">点击：跳到这一刻，看具体改了什么</div>
      </div>
    );
  })();

  const detail = (() => {
    if (!sel || !selSeg || !selF) return full ? <div className="dt-meta" style={{ paddingTop: 8 }}>点时间线上的一段，这里显示那一步做了什么；画布上对应的节点会框出来。</div> : null;
    const g = selSeg;
    const f = selF;
    const Ic = KIND_ICON[g.kind];
    const place = g.path ? placeOfPath(g.path) : where ? where.label(stateAt(f.run, g.start + 10, where.ctx).at) : undefined;
    const c = conflicts.find((x) => x.runs.includes(f.run.id) && x.path === g.path && x.start < g.end && g.start < x.end);
    const other = c ? runs.flat.find((x) => x.run.id === c.runs.find((id) => id !== f.run.id)) : undefined;
    const child = g.child ? runs.byId.get(g.child) : undefined;
    let body: ReactNode = null;
    if (g.kind === "exec" && g.cmd) body = <div className="diff">$ {g.cmd}</div>;
    else if (g.kind === "wait") body = <div className="diff prose">{f.run.name} 问：{g.question ?? "—"}</div>;
    else if (g.kind === "delegate" && child)
      body = (
        <div className="diff prose">
          {child.name}：{child.task}
          <br />
          回执：
          {child.receipts.filter((x) => x.at < now).map((x, i) => (
            <span key={i}>{i ? " → " : ""}<span className="rc" data-r={receiptView(child, x)}>{RECEIPT_NAMES[receiptView(child, x)]}</span> {hhmmss(x.at)}</span>
          ))}
        </div>
      );
    return (
      <>
        <div className="dt-head">
          <RunAvatar agent={f.run.agent} size={22} />
          <b>{fullName(f)}</b>
          <span className="dt-meta">{f.parent ? f.run.task : g.turn ? `第 ${g.turn} 轮` : ""}</span>
          <span className="grow" />
          <button className="ibtn" aria-label="关闭详情" onClick={() => focus.selectSeg(null)}><IconClose size={14} /></button>
        </div>
        <div className="dt-what">
          {Ic && <Ic size={14} />}
          {g.verifies ? "验收 · " : ""}
          {KIND_NAME[g.kind] ?? g.kind}
          {g.path ? <span className="mono" style={{ fontWeight: 400 }}>{g.path}</span> : g.cmd ? <span className="mono" style={{ fontWeight: 400 }}>{g.cmd}</span> : null}
        </div>
        <div className="dt-meta">{place ? `在 ${place} · ` : ""}{hhmmss(g.start)}–{hhmmss(g.end)} · {secs(g.end - g.start)}</div>
        {f.parent && <div className="dt-meta" style={{ marginTop: 4 }}>由 {fullName(f)} 完成（{f.run.via === "seedmux" ? "Seedmux worker" : "原生子代理"}），计入 {f.parent.name} 会话的进度</div>}
        {c && other && <div className="dt-meta" style={{ color: "var(--caution)", marginTop: 4 }}>和 {fullName(other)} 在 {hhmmss(c.start)}–{hhmmss(c.end)} 同时写这个文件</div>}
        {body}
        <div className="dt-actions">
          <button className="btn sm" onClick={() => openSeg(f.run.id, g)}><IconMessage size={14} />在会话里看</button>
          {g.path && <button className="btn sm quiet" onClick={() => onLocate?.(f.run.id)}><IconTarget size={14} />定位节点</button>}
        </div>
      </>
    );
  })();

  const hint = replay ? "拖到最右端或按 Esc 回到实时 · 播放会跳过空闲" : "点一段看那一步做了什么 · 拖动回看任意时刻";
  return (
    <section className="ws-tl" ref={sectionEl} data-size={size} data-legend={legend || undefined} data-replay={replay ? "" : undefined} aria-label="工位时间线">
      <motion.div
        className="ws-tl-anim"
        data-animating={animating || undefined}
        initial={false}
        animate={{ height: fullH }}
        transition={reducedMotion() ? { duration: 0 } : { duration: 0.34, ease: [0.45, 0, 0.55, 1] }}
        onAnimationStart={() => ((timelineResize.at = performance.now()), setAnimating(true))}
        onUpdate={() => void (timelineResize.at = performance.now())}
        onAnimationComplete={() => ((timelineResize.at = performance.now()), setAnimating(false))}
      >
        <div ref={innerRef}>
          <header className="tl-head">
            <button className="tl-title" onClick={() => setSize(full ? "compact" : "full")} title={`${full ? "收起" : "展开"}时间线`}>
              <IconHistory size={16} />
              工位时间线
            </button>
            {stateBox}
            <button className="ibtn" onClick={() => (replay?.playing ? clock.pause() : play())} aria-label={replay?.playing ? "暂停回放" : replay ? "从这里播放" : "从头回放"} title={`${replay?.playing ? "暂停" : replay ? "从这里播放" : "从头回放"}（空格）`}>
              {replay?.playing ? <IconPause size={16} /> : <IconPlay size={16} />}
            </button>
            <button className="ibtn" onClick={() => stepEvent(-1)} aria-label="上一步" title="上一步（[）"><IconBack size={16} /></button>
            <button className="ibtn" onClick={() => stepEvent(1)} aria-label="下一步" title="下一步（]）"><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><IconBack size={16} /></span></button>
            <div className="segc speed" role="group" aria-label="回放速度">
              {SPEEDS.map((s) => (
                <button key={s} aria-pressed={(replay?.speed ?? spd) === s} onClick={() => (setSpd(s), replay && clock.speed(s))}>{s}×</button>
              ))}
            </div>
            {replay && <button className="btn primary" onClick={() => clock.live()}>回到实时</button>}
            <span className="tl-hint">{hint}</span>
            {!full && <button className="btn quiet" aria-pressed={legend} onClick={() => setLegend((v) => !v)}>图例</button>}
            <button className="ibtn" onClick={() => setSize(full ? "compact" : "full")} aria-pressed={full} aria-label={full ? "收起时间线" : "展开成全宽"} title={full ? "收起" : "展开成全宽"}><IconEnter size={16} /></button>
            <button className="ibtn" onClick={() => setSize("min")} aria-label="收成细条" title="收成细条"><IconClose size={16} /></button>
          </header>
          <div className="tl-body" ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
            <div className="names" style={{ height }}>{visible.map(laneName)}</div>
            <div className="track" ref={trackRef} style={{ height }} {...scrub(axis)} tabIndex={0} role="slider" aria-label="回放位置" aria-valuemin={axis.start} aria-valuemax={axis.end} aria-valuenow={Math.round(t)} aria-valuetext={`${hhmmss(t)}${replay ? " 回放" : " 实时"}`} onKeyDown={onKey}>
              <div className="ruler" style={{ height: P.ruler }}>
                {ticks(axis).map((k) => (
                  <span key={k.t} className={k.major ? "tick maj" : "tick"} style={tx(k.x)}>{k.label && <span>{k.label}</span>}</span>
                ))}
                {axis.pieces.filter((p) => p.kind !== "act").map((p) => <span key={`b${p.a}`} className="rbreak" style={{ ...tx(p.x0), width: p.x1 - p.x0 }} />)}
              </div>
              {axis.pieces.filter((p) => p.kind !== "act").map((p) => (
                <span key={p.a} className="gap" data-kind={p.kind} data-at={replay && axis.gapAt(t) === p ? "" : undefined} style={{ ...tx(p.x0), width: p.x1 - p.x0, top: P.ruler, height: height - P.ruler }} title={`${hhmmss(p.a)}–${hhmmss(p.b)} 没有会话在干活（${dur(p.b - p.a)}），已压缩显示`}>
                  <Zig h={height - P.ruler} />
                  <span className="gl">{p.kind === "tail" ? "空闲中" : "空闲"}<br />{dur(p.b - p.a)}</span>
                </span>
              ))}
              {conflicts.filter((c) => c.start < liveNow).map((c, i) => (
                <span key={`c${i}`} className="cband" style={{ ...X(axis, c.start, Math.min(c.end, liveNow), 0), top: P.ruler, bottom: 0 }}><span>冲突 {base(c.path)}</span></span>
              ))}
              {visible.map(lane)}
              {visible
                .filter((r) => r.sub && r.f.run.spawnAt != null)
                .map((r) => {
                  const pr = rows.find((x) => x.f.run.id === r.f.parent?.id);
                  if (!pr) return null;
                  const k = r.f.run;
                  const back = k.doneAt != null && k.doneAt < liveNow && !k.coarse ? (where && !where.ctx.reduced ? (stateAt(k, liveNow, where.ctx).moves.filter((m) => m.ret).map((m) => planFor(m, where.ctx).t1)[0] ?? k.doneAt) : k.doneAt) : null;
                  return (
                    <span key={`cn${k.id}`}>
                      <span className="conn down" style={{ ...tx(axis.toPx(k.spawnAt!)), top: pr.mid, height: r.mid - pr.mid }} title={`${hhmmss(k.spawnAt!)} ${pr.f.run.name} 派出（${k.via === "seedmux" ? "Seedmux" : "Task"}）`} />
                      {back != null && back < liveNow && <span className="conn up" style={{ ...tx(axis.toPx(back)), top: pr.mid, height: r.mid - pr.mid }} title={`${hhmmss(back)} 交回给 ${pr.f.run.name}`} />}
                    </span>
                  );
                })}
              {replay && (
                <span className="future" ref={future} style={{ top: P.ruler }}>
                  <span>这之后已经发生，拖回来看</span>
                </span>
              )}
              <span className="nowline" style={{ ...tx(axis.toPx(liveNow)), top: P.ruler }} />
              <span className="ph" ref={ph} data-replay={replay ? "" : undefined}>
                <span className="knob" ref={knob}>
                  <i />
                  {replay ? hhmmss(t) : "现在"}
                </span>
              </span>
            </div>
            {full && <div className="detail">{detail}</div>}
          </div>
          <div className="legend">
            <span><i data-k="read" />读文件</span>
            <span><i data-k="write" />写文件</span>
            <span><i data-k="exec" />执行命令</span>
            <span><i data-k="think" />思考</span>
            <span><i data-k="delegate" />派子代理</span>
            <span><i data-k="walk" />走到另一个节点</span>
            <span><i data-k="wait" />等你回复</span>
            <span><i data-k="conflict" />两个会话改同一文件</span>
            <span><i data-k="gap" />空闲（已压缩）</span>
            <span style={{ color: "var(--fg-subtle)" }}>键盘：← → 1 秒，[ ] 上/下一步，空格 播放，Esc 回到实时</span>
          </div>
        </div>
      </motion.div>
      {/* the words replay brings in, laid out once up front: the first scrub never waits on new glyphs */}
      <span className="ws-warm" aria-hidden>{WARM}</span>
      {!full && detail && <div className="detail-pop">{detail}</div>}
      {tipCard}
    </section>
  );
}

/** For tests: the replay position after playing (see axis.advance). */
export const _advance = advance;
