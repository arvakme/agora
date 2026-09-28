// The timeline under the canvas (web/docs/workstation.md §时间线).
//   - Always a 34px strip (except in an empty project): what is going on in words, a mini activity
//     strip with idle stretches collapsed (drag it to replay), who is around, and ⤢ to expand.
//   - Expanded: one lane per run (sub-agents indented under their dispatcher, with their receipts),
//     adaptive ticks, collapsed idle gaps with the real length in words, dispatch / hand-back
//     connectors. The legend is an ⓘ hover; play and speed appear only in replay.
//   - A lane's name locates that agent: the canvas pans smoothly to its figure, once (following
//     and tracing are v2). Hover offers 打开会话.
// Lanes are rebuilt at most 4 times a second; the playhead moves by transform in the frame loop;
// only the lanes in view are rendered.
import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevron, IconEnter, IconHint, IconHistory, IconNext, IconPause, IconPlay, IconPrev } from "../app/icons";
import { openTrajectory, ui } from "../session/ui";
import { advance, buildAxis, hhmmss, ticks, type Axis } from "./axis";
import { clock, prefersReducedMotion as reducedMotion, replayTime, useReplay, useTick } from "./clock";
import { motion } from "motion/react";
import { focus } from "./focus";
import { frame } from "./frame";
import { RunAvatar } from "./RunAvatar";
import { useRuns } from "./runs/store";
import { FINAL, RECEIPT_NAMES, receiptAt, type AgentRun, type FlatRun, type RunSeg } from "./runs/types";

const MINI_COLORS: Record<string, string> = { write: "--accent-fill", read: "--accent-soft", exec: "--series-3", think: "--line-strong", wait: "--caution-dot", delegate: "--accent", gap: "--line-strong" };
let miniPalette: { theme: string; c: Record<string, string> } | null = null;
/** The strip: up to three main agents as thin rows, collapsed idle stretches hatched. `prev` + `u` blend a rebuilt axis in. */
function drawMini(cv: HTMLCanvasElement, runs: AgentRun[], A: Axis, prev: Axis | null, u: number, now: number) {
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

const LANE = 30;
const SUB = 26;
const RULER = 18;
const SPEEDS = [1, 4, 16];
const KIND_NAME: Record<string, string> = { read: "读文件", write: "写文件", exec: "执行命令", think: "思考", wait: "等你回复", delegate: "派子代理" };
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
};

/** What a run is doing at t, in a few words (lane names, the strip's state). */
export function nowText(run: AgentRun, t: number, placeOf?: (path: string) => string | undefined): { k: string; text: string } {
  const g = run.segs.find((s) => s.start <= t && t < s.end);
  if (run.parentId) {
    const r = receiptAt(run, t);
    return { k: r ?? "idle", text: g ? g.label : r ? RECEIPT_NAMES[r] : "" };
  }
  if (!g) return { k: "idle", text: "空闲" };
  const where = g.path && placeOf ? placeOf(g.path) : undefined;
  return { k: g.kind, text: `${g.kind === "wait" ? "等你回复" : g.label}${where ? ` · ${where}` : ""}` };
}

type Row = { f: FlatRun; y: number; h: number; sub: boolean };

export function Timeline({ empty, placeOf, onLocate }: { empty?: boolean; placeOf?: (path: string) => string | undefined; onLocate?: (runId: string) => void }) {
  const runs = useRuns();
  const replay = useReplay();
  const [open, setOpen] = useState(false);
  const [legend, setLegend] = useState(false);
  const [fold, setFold] = useState<Record<string, boolean>>({});
  // Lanes and the axis are rebuilt at most 4 times a second.
  const now = useTick(250, true);
  const t = replay ? replayTime(replay, now) : now;
  const track = useRef<HTMLDivElement | null>(null);
  const mini = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [tw, setTw] = useState(600);
  const [mw, setMw] = useState(300);
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  // Widths follow the elements whenever they mount (the strip and the lanes come and go).
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
  // Expand / collapse animate the height (the full view's height is measured).
  const [fullH, setFullH] = useState(240);
  // Clip only while the height animates (the legend pops out above the timeline otherwise).
  const [animating, setAnimating] = useState(false);
  const innerRO = useMemo(() => (typeof ResizeObserver === "undefined" ? null : new ResizeObserver((es) => setFullH(Math.ceil(es[0].contentRect.height)))), []);
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
  const axis = useMemo(() => buildAxis(intervals, liveNow, Math.max(100, tw)), [intervals, liveNow, tw]);
  const maxis = useMemo(() => buildAxis(intervals, liveNow, Math.max(60, mw), { gapPx: 14 }), [intervals, liveNow, mw]);

  // Rows: top-level runs; their sub-agents under them unless folded; deeper ones fold into the parent.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = RULER;
    for (const f of flat) {
      if (f.depth >= 2) continue;
      if (f.depth === 1 && fold[f.root.id]) continue;
      if (f.depth === 1 && f.run.spawnAt != null && f.run.spawnAt > liveNow) continue;
      const h = f.depth ? SUB : LANE;
      out.push({ f, y, h, sub: f.depth > 0 });
      y += h;
    }
    return out;
  }, [flat, fold, liveNow]);
  const height = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : RULER + LANE;

  // ── playhead: the frame loop moves it by transform ──
  const ph = useRef<HTMLSpanElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const mph = useRef<HTMLSpanElement>(null);
  const future = useRef<HTMLSpanElement>(null);
  // When an axis is rebuilt with a different shape (a new collapsed gap, a rescale) the playhead
  // blends from the old mapping to the new one over 250 ms — the same glide the segments make.
  const shown = useRef({ x: -1, mx: -1 });
  const axRef = useRef({ axis, maxis, prevM: null as Axis | null, from: null as { x: number; mx: number } | null, at: 0 });
  if (axRef.current.axis !== axis || axRef.current.maxis !== maxis) axRef.current = { axis, maxis, prevM: axRef.current.maxis, from: shown.current.x >= 0 ? { ...shown.current } : null, at: performance.now() };
  // The mini strip is one <canvas> drawn in the frame loop (a few hundred rectangles cost well
  // under a millisecond), so it moves continuously: its segments glide from the old axis to the
  // new one after each 4 Hz rebuild, and the running call grows every frame — no DOM to relayout.
  const miniCanvas = useRef<HTMLCanvasElement>(null);
  const sectionEl = useRef<HTMLElement>(null);
  const miniRuns = useRef<AgentRun[]>([]);
  useEffect(
    () =>
      frame.add((n) => {
        if (sectionEl.current?.closest('[data-hidden="true"]')) return;
        const tt = clock.time(n);
        const { axis: A, maxis: M, from, at: since } = axRef.current;
        const lin = from ? Math.min(1, (performance.now() - since) / 300) : 1;
        const u = lin * lin * (3 - 2 * lin);
        // Between the 4 Hz rebuilds "now" runs past the axis end: extend it at the axis's own
        // scale, so the playhead moves continuously instead of stepping at each rebuild.
        const at = (X: Axis, time: number) => Math.min(X.width - 1, time <= X.end ? X.toPx(time) : X.toPx(X.end) + (time - X.end) * X.pps);
        // from where it was drawn when the axis changed, eased onto the new mapping (no jump, whatever changed)
        const blend = (X: Axis, x0: number | undefined, time: number) => (u >= 1 || x0 == null ? at(X, time) : x0 + (at(X, time) - x0) * u);
        const x = blend(A, from?.x, Math.min(tt, n));
        shown.current.x = x;
        if (ph.current) ph.current.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        if (future.current) {
          future.current.style.left = `${x.toFixed(2)}px`;
        }
        if (knob.current) {
          const txt = clock.get() ? hhmmss(tt) : "现在";
          if (knob.current.textContent !== txt) knob.current.textContent = txt;
        }
        const mx = blend(M, from?.mx, Math.min(tt, n));
        shown.current.mx = mx;
        if (mph.current) mph.current.style.transform = `translate3d(${mx.toFixed(2)}px, 0, 0)`;
        const cv = miniCanvas.current;
        if (cv) drawMini(cv, miniRuns.current, M, axRef.current.prevM, u, n);
      }),
    [],
  );

  // ── scrubbing ──
  const drag = useRef<{ x: number; moved: boolean; el: HTMLElement; A: Axis } | null>(null);
  const gaps = (A: Axis) => A.pieces.filter((p) => p.kind === "gap").map((p) => ({ a: p.a, b: p.b }));
  const timeAt = (el: HTMLElement, A: Axis, cx: number) => {
    const r = el.getBoundingClientRect();
    return A.fromPx(Math.max(0, Math.min(A.width, ((cx - r.left) / r.width) * A.width)));
  };
  const seek = (at: number, A: Axis) => {
    if (at >= Date.now() - 300) return clock.live();
    clock.seek(at, Date.now(), gaps(A));
  };
  const scrub = (A: Axis) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, moved: false, el: e.currentTarget, A };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
      if (d.moved) seek(timeAt(d.el, d.A, e.clientX), d.A);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.moved) return seek(timeAt(d.el, d.A, e.clientX), d.A);
      const sg = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
      if (sg) return pickSeg(sg.dataset.run!, Number(sg.dataset.seg));
      seek(timeAt(d.el, d.A, e.clientX), d.A);
    },
  });
  const pickSeg = (runId: string, i: number) => {
    const f = runs.byId.get(runId);
    const g = f?.segs[i];
    if (!f || !g) return;
    clock.seek(Math.min(g.start + (g.end - g.start) / 2, Date.now() - 300), Date.now(), gaps(axis));
    const root = runs.flat.find((x) => x.run.id === runId)?.root;
    if (root?.sessionId) {
      ui.openSession(root.sessionId);
      if (g.turn) setTimeout(() => openTrajectory(root.sessionId!, g.turn!), 120);
    }
  };
  const stepEvent = (dir: 1 | -1) => {
    const bounds = [...new Set(flat.flatMap((f) => f.run.segs.filter((g) => g.kind !== "think").map((g) => g.start)))].filter((x) => x < Date.now()).sort((a, b) => a - b);
    const next = dir > 0 ? bounds.find((b) => b > t + 50) : [...bounds].reverse().find((b) => b < t - 50);
    if (next == null) return dir > 0 ? clock.live() : undefined;
    clock.seek(next + 50, Date.now(), gaps(axis));
  };
  const play = () => {
    const from = replay ? (axis.gapAt(t) ? axis.gapAt(t)!.b : t) : axis.start;
    clock.play(from >= Date.now() - 300 ? axis.start : from, Date.now(), replay?.speed ?? 1, gaps(axis));
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
    } else if (e.key === "Escape") clock.live();
  };

  if (empty || !runs.flat.length) return null;

  // ── the strip's words ──
  const tops = runs.flat.filter((f) => f.depth === 0);
  miniRuns.current = tops.slice(0, 3).map((f) => f.run);
  const subs = runs.flat.filter((f) => f.depth > 0).length;
  const waiting = tops.filter((f) => f.run.segs.some((g) => g.kind === "wait" && g.start <= now && now < g.end));
  const busy = tops.filter((f) => f.run.running || f.run.segs.some((g) => g.start <= now && now < g.end));
  const lastSeg = tops.flatMap((f) => f.run.segs.filter((g) => g.kind !== "think" && g.start <= now).map((g) => ({ f, g }))).sort((a, b) => b.g.start - a.g.start)[0];
  let state: { k: string; node: React.ReactNode };
  if (!tops.length) state = { k: "none", node: <span>还没有 agent 做过事</span> };
  else if (waiting.length) state = { k: "wait", node: <><i className="dot-c" /><b>{waiting[0].run.name}</b>在等你回复</> };
  else if (busy.length === 1) {
    const n = nowText(busy[0].run, now, placeOf);
    state = { k: n.k, node: <><i className="live" /><b>{busy[0].run.name}</b>{n.text}</> };
  } else if (busy.length > 1) state = { k: "busy", node: <><i className="live" />{busy.length} 个会话在干活</> };
  else state = { k: "idle", node: lastSeg ? <>都空闲 · 最后 <b>{lastSeg.f.run.name}</b> {lastSeg.g.label} · {hhmmss(lastSeg.g.end)}</> : <>都空闲</> };

  const counts = (
    <span className="ws-cnt" title={tops.map((f) => f.run.name).join("、")}>
      <span className="stack">{tops.slice(0, 3).map((f) => <RunAvatar key={f.run.id} agent={f.run.agent} size={18} />)}</span>
      {tops.length} 个会话{subs ? ` · ${subs} 个子代理` : ""}
      {waiting.length > 0 && <span className="need"><i className="dot-c" />{waiting.length} 等你</span>}
    </span>
  );

  // Positions by transform (sub-pixel); widths grow — both glide between the 4 Hz rebuilds (CSS).
  const tx = (x: number) => `translate3d(${x.toFixed(2)}px, 0, 0)`;
  const X = (A: Axis, a: number, b: number) => ({ transform: tx(A.toPx(a)), width: Math.max(2, A.toPx(b) - A.toPx(a) - 1) });
  const visible = rows.filter((r) => r.y + r.h >= scroll.top - 200 && r.y <= scroll.top + scroll.h + 200);

  return (
    <section className="ws-tl" ref={sectionEl} data-open={open || undefined} data-replay={replay ? "" : undefined} aria-label="工位时间线">
      <motion.div
        className="ws-tl-anim"
        data-animating={animating || undefined}
        initial={false}
        animate={{ height: open ? fullH : 34 }}
        transition={reducedMotion() ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 36 }}
        onAnimationStart={() => setAnimating(true)}
        onAnimationComplete={() => setAnimating(false)}
      >
      <div ref={innerRef}>
      {!open ? (
        <div className="ws-bar">
          <button className="ttl" onClick={() => setOpen(true)} title="展开时间线">
            <IconHistory size={14} />
            工位
          </button>
          <span className="stt" data-k={state.k}>{replay ? <><b className="rp">回放 {hhmmss(t)}</b>比实时晚 {dur(now - t)}</> : state.node}</span>
          <div className="mini" ref={miniRef} {...scrub(maxis)} title="拖动回看任意时刻" role="slider" aria-label="回放位置" aria-valuemin={maxis.start} aria-valuemax={maxis.end} aria-valuenow={Math.round(t)} aria-valuetext={hhmmss(t)} tabIndex={0} onKeyDown={onKey}>
            <canvas ref={miniCanvas} className="mini-cv" aria-hidden />
            <span className="mph" ref={mph} data-replay={replay ? "" : undefined} />
          </div>
          {counts}
          <button className="icon-btn sm muted" onClick={() => setOpen(true)} aria-label="展开时间线" title="展开时间线"><IconEnter size={14} /></button>
        </div>
      ) : (
        <>
          <header className="ws-tl-head">
            <button className="tl-title" onClick={() => setOpen(false)} title="收起时间线">
              <IconHistory size={14} />
              工位时间线
            </button>
            <span className="state" data-mode={replay ? "replay" : "live"}>
              {replay ? <><IconHistory size={14} />回放 <b>{hhmmss(t)}</b><span className="sub">· {axis.gapAt(t) ? "这时没人在干活" : `比实时晚 ${dur(now - t)}`}</span></> : <><i />实时 <b>{hhmmss(now)}</b><span className="sub">· {axis.pieces.at(-1)?.kind === "tail" ? `都空闲了 ${dur(now - axis.pieces.at(-1)!.a)}` : "跟随最新动作"}</span></>}
            </span>
            {replay && (
              <>
                <button className="icon-btn sm" onClick={() => (replay.playing ? clock.pause() : play())} aria-label={replay.playing ? "暂停" : "从这里播放"} title={`${replay.playing ? "暂停" : "从这里播放"}（空格）`}>
                  {replay.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
                </button>
                <button className="icon-btn sm" onClick={() => stepEvent(-1)} aria-label="上一步" title="上一步（[）"><IconPrev size={14} /></button>
                <button className="icon-btn sm" onClick={() => stepEvent(1)} aria-label="下一步" title="下一步（]）"><IconNext size={14} /></button>
                <div className="seg ws-speed" role="group" aria-label="回放速度">
                  {SPEEDS.map((s) => (
                    <button key={s} data-on={(replay.speed ?? 1) === s} aria-pressed={(replay.speed ?? 1) === s} onClick={() => clock.speed(s)}>{s}×</button>
                  ))}
                </div>
                <button className="btn sm primary" onClick={() => clock.live()}>回到实时</button>
              </>
            )}
            <span className="grow" />
            {counts}
            <span className="ws-legend-wrap" onPointerEnter={() => setLegend(true)} onPointerLeave={() => setLegend(false)}>
              <button className="icon-btn sm muted" aria-label="图例" aria-expanded={legend} onFocus={() => setLegend(true)} onBlur={() => setLegend(false)}><IconHint size={14} /></button>
              {legend && <Legend />}
            </span>
            <button className="icon-btn sm muted" onClick={() => setOpen(false)} aria-label="收起时间线" title="收起时间线"><IconChevron size={14} open /></button>
          </header>
          <div className="ws-tl-body" ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
            <div className="names" style={{ height }}>
              {visible.map((r) => (
                <LaneName key={r.f.run.id} r={r} t={t} placeOf={placeOf} onLocate={onLocate} folded={!!fold[r.f.run.id]} kids={runs.flat.filter((x) => x.depth === 1 && x.parent?.id === r.f.run.id).length} onFold={() => setFold((o) => ({ ...o, [r.f.run.id]: !o[r.f.run.id] }))} />
              ))}
            </div>
            <div className="track" ref={trackRef} style={{ height }} {...scrub(axis)} tabIndex={0} role="slider" aria-label="回放位置" aria-valuemin={axis.start} aria-valuemax={axis.end} aria-valuenow={Math.round(t)} aria-valuetext={hhmmss(t)} onKeyDown={onKey}>
              <div className="ruler">
                {ticks(axis).map((k) => (
                  <span key={k.t} className="tick" data-maj={k.major || undefined} style={{ transform: tx(k.x) }}>{k.label && <span>{k.label}</span>}</span>
                ))}
              </div>
              {axis.pieces.filter((p) => p.kind !== "act").map((p) => (
                <span key={p.a} className="gap" data-kind={p.kind} data-at={replay && axis.gapAt(t) === p ? "" : undefined} style={{ transform: tx(p.x0), width: p.x1 - p.x0, top: RULER, height: height - RULER }} title={`${hhmmss(p.a)}–${hhmmss(p.b)} 没有会话在干活（${dur(p.b - p.a)}），已压缩显示`}>
                  {p.x1 - p.x0 >= 44 && <span className="gl">{p.kind === "tail" ? "空闲中" : "空闲"}<br />{dur(p.b - p.a)}</span>}
                </span>
              ))}
              {visible.map((r) => (
                <div key={r.f.run.id} className="lane" data-sub={r.sub || undefined} style={{ top: r.y, height: r.h }}>
                  {r.f.run.segs.map((g, i) =>
                    g.start < liveNow ? (
                      <span key={i} className="sg" data-seg={i} data-run={r.f.run.id} data-k={g.kind} data-running={g.end > liveNow || undefined} style={{ ...X(axis, g.start, Math.min(g.end, liveNow)), top: r.sub ? 3 : 5, height: r.sub ? SUB - 12 : LANE - 10 }} title={segTitle(r.f.run, g)}>
                        {axis.toPx(Math.min(g.end, liveNow)) - axis.toPx(g.start) > 40 && <span>{g.label}</span>}
                      </span>
                    ) : null,
                  )}
                  {r.sub &&
                    r.f.run.receipts
                      .filter((x) => x.at < liveNow)
                      .map((x, i, all) => {
                        const end = i + 1 < all.length ? all[i + 1].at : FINAL.has(x.state) ? Math.min(liveNow, x.at + 1200) : liveNow;
                        return <span key={i} className="rcb" data-r={x.state} style={{ ...X(axis, x.at, end), top: SUB - 9, height: 7 }} title={`${RECEIPT_NAMES[x.state]} · ${hhmmss(x.at)}`} />;
                      })}
                  {!r.sub && fold[r.f.run.id] &&
                    runs.flat
                      .filter((x) => x.depth === 1 && x.parent?.id === r.f.run.id && x.run.spawnAt != null)
                      .map((k) => <span key={k.run.id} className="kidmark" style={{ left: axis.toPx(k.run.spawnAt!) }} title={`${hhmmss(k.run.spawnAt!)} 派出 ${k.run.name}：${k.run.task ?? ""}`} />)}
                </div>
              ))}
              {visible
                .filter((r) => r.sub && r.f.run.spawnAt != null)
                .map((r) => {
                  const pr = rows.find((x) => x.f.run.id === r.f.parent?.id);
                  if (!pr) return null;
                  const top = pr.y + pr.h / 2;
                  const bottom = r.y + r.h / 2;
                  const k = r.f.run;
                  return (
                    <span key={`c${k.id}`}>
                      <span className="conn" style={{ transform: tx(axis.toPx(k.spawnAt!)), top, height: bottom - top }} title={`${hhmmss(k.spawnAt!)} ${pr.f.run.name} 派出（${k.via === "seedmux" ? "Seedmux" : "Task"}）`} />
                      {k.doneAt != null && k.doneAt < liveNow && !k.coarse && <span className="conn" data-up="" style={{ transform: tx(axis.toPx(k.doneAt)), top, height: bottom - top }} title={`${hhmmss(k.doneAt)} 交回给 ${pr.f.run.name}`} />}
                    </span>
                  );
                })}
              {replay && <span className="future" ref={future} style={{ top: RULER }} />}
              <span className="nowline" style={{ transform: tx(axis.toPx(liveNow)), top: RULER }} />
              <span className="ph" ref={ph} data-replay={replay ? "" : undefined}>
                <span className="knob" ref={knob}>{replay ? hhmmss(t) : "现在"}</span>
              </span>
            </div>
          </div>
        </>
      )}
      </div>
      </motion.div>
    </section>
  );
}

const segTitle = (run: AgentRun, g: RunSeg) => `${run.name} · ${KIND_NAME[g.kind] ?? g.kind}${g.path ? ` ${g.path}` : g.cmd ? ` ${g.cmd}` : g.question ? ` ${g.question}` : ""}\n${hhmmss(g.start)}–${hhmmss(g.end)} · ${dur(g.end - g.start)}${g.turn ? ` · 第 ${g.turn} 轮` : ""}\n点击：跳到这一刻，看具体改了什么`;

function LaneName({ r, t, placeOf, onLocate, folded, kids, onFold }: { r: Row; t: number; placeOf?: (p: string) => string | undefined; onLocate?: (runId: string) => void; folded: boolean; kids: number; onFold: () => void }) {
  const run = r.f.run;
  const n = nowText(run, t, placeOf);
  const coarse = !!run.coarse;
  return (
    <div className="lname" data-sub={r.sub || undefined} style={{ top: r.y, height: r.h }} onPointerEnter={() => focus.hover(run.id)} onPointerLeave={() => focus.hover(null)}>
      <button className="lmain" disabled={coarse} onClick={() => onLocate?.(run.id)} title={coarse ? "只有回执：看不到它在做什么，画布上没有它的位置" : "在画布上找到它"}>
        <RunAvatar agent={run.agent} size={r.sub ? 18 : (22 as never)} parent={r.f.parent?.agent} />
        <span className="t">
          <b>
            {run.name}
            {r.sub && r.f.parent ? <span className="par"> · {r.f.parent.name} 派</span> : null}
          </b>
          <span className="now" data-k={n.k}>{coarse ? "只能看回执" : n.text}</span>
        </span>
      </button>
      {!r.sub && kids > 0 && (
        <button className="fold" aria-expanded={!folded} onClick={onFold} title={folded ? "展开子代理" : "收起子代理"}>{folded ? "▸" : "▾"} {kids}</button>
      )}
      {r.f.root.sessionId && (
        <span className="lacts">
          <button onClick={() => ui.openSession(r.f.root.sessionId!)}>打开会话</button>
        </span>
      )}
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["read", "读文件"],
    ["write", "写文件"],
    ["exec", "执行命令"],
    ["think", "思考"],
    ["delegate", "派子代理"],
    ["wait", "等你回复"],
    ["gap", "空闲（已压缩）"],
  ];
  return (
    <div className="ws-legend" role="tooltip">
      {items.map(([k, name]) => (
        <span key={k}>
          <i data-k={k} />
          {name}
        </span>
      ))}
      <span className="keys">键盘：← → 1 秒，[ ] 上/下一步，空格 播放，Esc 回到实时</span>
    </div>
  );
}

/** For tests: the replay position after playing (see axis.advance). */
export const _advance = advance;
