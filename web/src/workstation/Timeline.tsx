// The timeline under the canvas (web/docs/workstation.md §3). By default a 34 px strip: one line of
// what is going on, the activity bar (a canvas the frame loop draws; drag it to replay), how many
// sessions / sub-agents, ⤢. ⤢ opens the lanes: one row per agent, sub-agents indented under their
// dispatcher over a thin wordless receipt line, segments that say verb + file, collapsed idle
// stretches, a warm band where two agents wrote one file, the playhead. A segment's details are in
// its hover card (the pointer can move into it for its buttons); ✕ goes back to the strip.
// Structure is rebuilt at most 4 times a second (useTick); the playheads and the strip's canvas
// move in the one frame loop; only the lanes in view are rendered.
// Trace (追踪, §11): a lane name traces its agent and pans the canvas to it; while tracing, the lanes
// and the strip are about that agent and its sub-agents only, its name says 追踪中, Esc lets go.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconBack, IconClose, IconEnter, IconHistory, IconMessage, IconPause, IconPlay, IconTarget } from "../app/icons";
import { openTrajectory, ui } from "../session/ui";
import { buildAxis, fitsLabel, gapLabelFits, hhmmss, ticks, type Axis } from "./axis";
import { clock, replayTime, useReplay, useTick } from "./clock";
import { focus, useFocus, type SegRef } from "./focus";
import { follow, useFollow } from "./follow";
import { frame } from "./frame";
import { canvasWhere, OUTSIDE, outsideProject, planFor, stateAt, writeConflicts } from "./place";
import { bucketize, idleSince, isDense, recentKids } from "./density";
import { DaySummary } from "./DaySummary";
import { RunAvatar } from "./RunAvatar";
import { useRuns } from "./runs/store";
import { FINAL, RECEIPT_NAMES, receiptAt, receiptText, receiptView, type WorkRun, type FlatRun, type RunSeg } from "./runs/types";

const MINI_COLORS: Record<string, string> = { write: "--accent-fill", read: "--fg-faint", exec: "--series-3", think: "--line-strong", wait: "--caution", delegate: "--fg", gap: "--line-strong" };
let miniPalette: { theme: string; c: Record<string, string> } | null = null;
/** The strip: up to three main agents as thin rows, collapsed idle stretches hatched. `prev` + `u` blend a rebuilt axis in. */
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
  if (!n) return;
  runs.forEach((r, i) => {
    const y = (i * h) / n + 1;
    const rh = h / n - 2;
    // a crowded row (a segment every few px) is not drawn segment by segment: one mark per ~3 px, its shade how busy that stretch was
    if (isDense(r.segs.length, w)) {
      const spans: { x0: number; x1: number }[] = [];
      for (const s of r.segs) {
        if (s.start >= now) break;
        spans.push({ x0: X(s.start), x1: Math.max(X(s.start) + 0.5, X(Math.min(s.end, now))) });
      }
      g.fillStyle = c.exec;
      for (const b of bucketize(spans, w)) {
        g.globalAlpha = 0.2 + 0.8 * b.level;
        g.fillRect(b.x, y, b.w, rh);
      }
      g.globalAlpha = 1;
      return;
    }
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
    // a collapsed idle stretch is one thin dotted line at mid height, not a run of ticks: many of them must not read as a barcode
    const x0 = X(p.a + 1);
    const x1 = X(p.b - 1);
    for (let x = x0; x < x1; x += 4) g.fillRect(x, Math.floor(h / 2), 2, 1);
  }
}

/** The prototype's lane metrics (PX()): lane, sub lane, its receipt line, ruler. */
const PX = { lane: 30, sub: 20, rc: 5, ruler: 18 };
/** The strip's height: the timeline starts at it, so its first show does not animate. */
const STRIP_H = 34;
/** The prototype's axis: a stretch with nobody working for more than 8 s collapses to 88 px. */
const AXIS = { gapMs: 8_000, gapPx: 88 };
/** Replay speeds: below 1× the whole scene slows down (a slow-motion film); above it only the timeline hurries. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 2, 4];
/** How long the hover card stays after the pointer leaves its segment (time to move into it). */
const TIP_GRACE_MS = 180;
const TIP_W = 300;
/** A run's sub-agents listed in the lanes; the rest fold into one row. */
const MAX_KIDS = 8;
/** When the timeline last changed height (lanes added, opened / closed): the canvas above then
 * keeps its top edge instead of re-centring, so the diagram and the figures don't slide. */
export const timelineResize = { at: -Infinity };
const WARM = "回放比实时晚这时没人在干活回到实时0123456789:·×秒分小时";
const KIND_NAME: Record<string, string> = { read: "读文件", write: "写文件", exec: "执行命令", think: "思考", wait: "等你回复", delegate: "派子代理" };
const dur = (ms: number) => {
  const s = ms / 1000;
  return s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, "0")} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
};
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒` : `${Math.round(ms / 1000)} 秒`);
const fullName = (f: FlatRun) => (f.parent ? `${f.run.name}（${f.parent.name} 派）` : f.run.name);
/** A segment's words in the lanes: verb + file (读 app.py, 写 users.py, 跑 pytest, 想, 派 Codex). */
const segText = (g: RunSeg) => (g.kind === "think" ? "想" : g.kind === "wait" ? "等你" : g.label);

/** What a run is doing at t, in a few words (lane names, the strip's state). */
export function nowText(run: WorkRun, t: number, placeOf?: (path: string) => string | undefined): { k: string; text: string } {
  const g = run.segs.find((s) => s.start <= t && t < s.end);
  if (run.parentId) {
    const r = receiptAt(run, t);
    return { k: r ?? "idle", text: g ? g.label : r ? receiptText(run, r) : "" };
  }
  if (!g) return { k: "idle", text: "空闲" };
  const where = g.path && placeOf ? placeOf(g.path) : undefined;
  return { k: g.kind, text: `${g.kind === "wait" ? "等你回复" : g.label}${where ? ` · ${where}` : ""}` };
}

type Row = { f: FlatRun; y: number; h: number; mid: number; sub: boolean; /** 「+N 个子代理」: the sub-agents of `f` folded out of the list. */ rest?: number };

/** Renders `node` again only when `k` changes (lane names: same words, no re-render at 4 Hz). */
const Keyed = memo(({ node }: { node: ReactNode; k: string }) => <>{node}</>, (a, b) => a.k === b.k);

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
              {fitsLabel(segText(g), w - 1, 11, 6) && <span>{segText(g)}</span>}
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
  const fl = useFollow();
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [tip, setTip] = useState<{ ref: SegRef; x: number; y: number } | null>(null);
  const [spd, setSpd] = useState(1);
  const [dayAt, setDayAt] = useState<HTMLElement | null>(null);
  // Lanes and the axis are rebuilt at most 4 times a second.
  const now = useTick(250, true);
  const t = replay ? replayTime(replay, now) : now;
  const [tw, setTw] = useState(600);
  const [mw, setMw] = useState(300);
  // How far the lanes are scrolled: only the rows in view (the window's height at most) are rendered.
  const [scrollTop, setScrollTop] = useState(0);
  // The track and the strip's bar are measured when they mount (so the first frame after opening
  // or closing is laid out at the right width) and whenever they resize.
  const sized = useRef(new Map<Element, (w: number) => void>());
  const ro = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((es) => {
            for (const e of es) sized.current.get(e.target)?.(Math.round(e.contentRect.width));
          }),
    [],
  );
  useEffect(() => () => ro?.disconnect(), [ro]);
  const measure = (set: (w: number) => void) => {
    let cur: HTMLDivElement | null = null;
    return (el: HTMLDivElement | null) => {
      if (cur) (ro?.unobserve(cur), sized.current.delete(cur));
      cur = el;
      if (!el) return;
      set(Math.round(el.clientWidth));
      sized.current.set(el, set);
      ro?.observe(el);
    };
  };
  const trackRef = useMemo(() => measure(setTw), []);
  const miniRef = useMemo(() => measure(setMw), []);
  // Opening and closing animate the height (what is inside is measured; CSS does the 340 ms).
  const [innerH, setInnerH] = useState(STRIP_H);
  const innerRO = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((es) => {
            timelineResize.at = performance.now();
            setInnerH(Math.ceil(es[0].contentRect.height));
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
  const placeOfPath = (p: string) => (where && !outsideProject(p) ? where.label(where.ctx.locate(p)?.place ?? OUTSIDE) : undefined);

  // 追踪: the lanes and the strip are about the traced agent and its sub-agents only.
  const traced = fo.traced && runs.byId.has(fo.traced) ? fo.traced : null;
  // Rows: top-level runs; their sub-agents under them unless folded; deeper ones fold into the parent.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = PX.ruler;
    // A run with more than 8 sub-agents lists the 8 most recently active at the moment shown; the rest are one 「+N 个子代理」 row.
    const at = replay ? t : liveNow;
    const listed = new Map<string, { shown: Set<string>; hidden: number }>();
    for (const f of flat) {
      if (f.depth !== 0 || more[f.run.id] || fold[f.run.id]) continue;
      const kids = flat
        .filter((x) => x.depth === 1 && x.root === f.run && x.run.spawnAt != null && x.run.spawnAt <= liveNow)
        .map((x) => ({ id: x.run.id, active: Math.min(at, Math.max(x.run.spawnAt ?? 0, ...x.run.segs.filter((g) => g.start <= at).map((g) => g.end), ...x.run.receipts.filter((r) => r.at <= at).map((r) => r.at))) }));
      if (kids.length > MAX_KIDS) {
        const r = recentKids(kids, MAX_KIDS);
        listed.set(f.run.id, { shown: new Set(r.shown.map((k) => k.id)), hidden: r.hidden });
      }
    }
    const closeRest = (root: FlatRun | null) => {
      const l = root && listed.get(root.run.id);
      if (root && l && l.hidden) {
        out.push({ f: root, y, h: PX.sub, mid: y + PX.sub / 2, sub: false, rest: l.hidden });
        y += PX.sub;
      }
    };
    let prevRoot: FlatRun | null = null;
    for (const f of flat) {
      if (f.depth === 0) {
        closeRest(prevRoot);
        prevRoot = f;
      }
      if (traced && f.run.id !== traced && f.parent?.id !== traced) continue;
      if (f.depth >= 2) continue;
      if (f.depth === 1 && fold[f.root.id] && f.run.id !== traced) continue;
      if (f.depth === 1 && (f.run.spawnAt == null || f.run.spawnAt > liveNow)) continue;
      if (f.depth === 1 && !traced) {
        const l = listed.get(f.root.id);
        if (l && !l.shown.has(f.run.id)) continue;
      }
      const h = f.depth ? PX.sub + PX.rc : PX.lane;
      out.push({ f, y, h, mid: y + (f.depth ? PX.sub / 2 : PX.lane / 2), sub: f.depth > 0 });
      y += h;
    }
    if (!traced) closeRest(prevRoot);
    return out;
  }, [flat, fold, more, liveNow, traced, replay ? t : 0]);
  const height = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : PX.ruler + PX.lane;

  // ── the playheads: the frame loop moves them by transform ──
  const ph = useRef<HTMLSpanElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const mph = useRef<HTMLSpanElement>(null);
  const future = useRef<HTMLSpanElement>(null);
  /** Where each playhead was last drawn (-1: not on screen), for gliding into a rescaled axis. */
  const shown = useRef({ x: -1, mx: -1 });
  const axRef = useRef({ axis, maxis, prevM: null as Axis | null, from: { x: -1, mx: -1 }, at: 0 });
  // A rescale in time glides over 300 ms; a new width (resize, opening, closing) is laid out at once.
  const ax0 = axRef.current;
  if (ax0.axis !== axis || ax0.maxis !== maxis)
    axRef.current = {
      axis,
      maxis,
      prevM: ax0.maxis.width === maxis.width ? ax0.maxis : null,
      from: { x: ax0.axis.width === axis.width ? shown.current.x : -1, mx: ax0.maxis.width === maxis.width ? shown.current.mx : -1 },
      at: performance.now(),
    };
  const miniCanvas = useRef<HTMLCanvasElement>(null);
  const sectionEl = useRef<HTMLElement>(null);
  const miniRuns = useRef<WorkRun[]>([]);
  useEffect(
    () =>
      frame.add((n) => {
        if (sectionEl.current?.closest('[data-hidden="true"]')) return;
        const tt = clock.time(n);
        const { axis: A, maxis: M, prevM, from, at: since } = axRef.current;
        const lin = Math.min(1, (performance.now() - since) / 300);
        const u = lin * lin * (3 - 2 * lin);
        const at = (X: Axis, time: number) => Math.min(X.width - 1, time <= X.end ? X.toPx(time) : X.toPx(X.end) + (time - X.end) * X.pps);
        const blend = (X: Axis, x0: number, time: number) => (u >= 1 || x0 < 0 ? at(X, time) : x0 + (at(X, time) - x0) * u);
        const x = blend(A, from.x, Math.min(tt, n));
        shown.current.x = ph.current ? x : -1;
        if (ph.current) ph.current.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        if (future.current) future.current.style.left = `${x.toFixed(2)}px`;
        if (knob.current) {
          const txt = clock.get() ? hhmmss(tt) : "现在";
          const span = knob.current.lastChild as Text | null;
          if (span && span.textContent !== txt) span.textContent = txt;
          knob.current.toggleAttribute("data-replay", !!clock.get());
        }
        const mx = blend(M, from.mx, Math.min(tt, n));
        shown.current.mx = mph.current ? mx : -1;
        if (mph.current) mph.current.style.transform = `translate3d(${mx.toFixed(2)}px, 0, 0)`;
        const cv = miniCanvas.current;
        if (cv) drawMini(cv, miniRuns.current, M, prevM, u, n);
      }),
    [],
  );

  // ── the hover card: it stays while the pointer is on its segment or on the card ──
  const closing = useRef(0);
  const keepTip = () => {
    clearTimeout(closing.current);
    closing.current = 0;
  };
  const hideTip = () => {
    keepTip();
    setTip(null);
    focus.hoverSeg(null);
  };
  const hideTipSoon = () => {
    if (!closing.current) closing.current = window.setTimeout(hideTip, TIP_GRACE_MS);
  };
  useEffect(() => () => clearTimeout(closing.current), []);

  // ── opening and closing: keyboard focus moves to the control that undoes it ──
  const refocus = useRef(false);
  const toggle = (v: boolean) => {
    refocus.current = !!sectionEl.current?.contains(document.activeElement);
    if (!v) hideTip();
    else setScrollTop(0);
    setOpen(v);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    sectionEl.current?.querySelector<HTMLElement>(open ? "[data-close]" : "[data-open]")?.focus();
  }, [open]);

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
      hideTip();
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) {
        const sg = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
        if (!sg) return hideTipSoon();
        keepTip();
        const ref = { run: sg.dataset.run!, i: Number(sg.dataset.seg) };
        focus.hoverSeg(ref);
        // the card stays where it opened (so the pointer can reach its buttons) until another segment is hovered
        const x = e.clientX;
        const y = sg.getBoundingClientRect().top;
        setTip((cur) => (cur && cur.ref.run === ref.run && cur.ref.i === ref.i ? cur : { ref, x, y }));
        return;
      }
      if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
      if (d.moved) {
        focus.selectSeg(null);
        seek(timeAt(d.el, d.A, e.clientX), d.A);
      }
    },
    onPointerLeave: () => {
      if (!drag.current) hideTipSoon();
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
  /** The prototype's select(): pick the segment (the canvas rings its node) and jump to its middle. */
  const pickSeg = (runId: string, i: number) => {
    const g = runs.byId.get(runId)?.segs[i];
    if (!g) return;
    focus.selectSeg({ run: runId, i });
    seek(Math.min(g.start + (g.end - g.start) / 2, Date.now() - 300), axis);
  };
  /** 定位节点: pick the segment (the figure goes back to that moment), then pan to the figure once it is drawn there. */
  const locateSeg = (runId: string, i: number) => {
    pickSeg(runId, i);
    requestAnimationFrame(() => requestAnimationFrame(() => onLocate?.(runId)));
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
      e.preventDefault();
      // Esc lets go of a trace first (as on the canvas), then goes back to live
      if (focus.get().traced) return void focus.escape();
      hideTip();
      focus.selectSeg(null);
      clock.live();
    }
  };
  /** 追踪: a lane name traces its agent and pans the canvas to it (the smooth move, once). */
  const traceAndLocate = (id: string) => {
    focus.trace(id);
    onLocate?.(id);
  };
  const activate = (go: () => void) => (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) (e.preventDefault(), go());
  };
  /** A lane name's hover menu: 追踪 (or 退出追踪) and 跟随 (in the follow pane). */
  const laneActs = (id: string) => (
    <>
      {traced === id ? (
        <button onClick={(e) => (e.stopPropagation(), focus.trace(null))} title="退出追踪（Esc）">退出追踪</button>
      ) : (
        <button onClick={(e) => (e.stopPropagation(), focus.trace(id))} title="只看它走过的路">追踪</button>
      )}
      <button data-on={fl.run === id || undefined} aria-pressed={fl.run === id} onClick={(e) => (e.stopPropagation(), fl.run === id ? follow.stop() : follow.start(id))} title={fl.run === id ? "停止跟随" : "在右侧窗口里跟着它"}>
        跟随
      </button>
    </>
  );

  if (empty || !runs.flat.length) return null;

  const tops = runs.flat.filter((f) => f.depth === 0);
  const kidsOf = (id: string) => runs.flat.filter((x) => x.depth === 1 && x.parent?.id === id);
  const tf = traced ? runs.flat.find((x) => x.run.id === traced) : undefined;
  // every session over for more than 10 minutes: the strip says so and draws no activity
  const quietAt = !replay && !tf ? idleSince(tops.map((f) => f.run), liveNow) : null;
  miniRuns.current = quietAt != null ? [] : tf ? [tf.run, ...kidsOf(tf.run.id).map((x) => x.run)].slice(0, 3) : tops.slice(0, 3).map((f) => f.run);

  // ── the default: the 34 px strip ──
  const strip = () => {
    const waitAt = (f: FlatRun) => f.run.segs.find((g) => g.kind === "wait" && g.start <= now && now < g.end);
    const waiting = tops.filter(waitAt);
    const busy = tops.filter((f) => f.run.running || f.run.segs.some((g) => g.start <= now && now < g.end));
    let state: { k: string; node: ReactNode };
    if (tf) {
      // 追踪: the line is about it — what it does at the playhead (the canvas says it is a replay)
      const w = tf.run.segs.find((g) => g.kind === "wait" && g.start <= t && t < g.end);
      const n = nowText(tf.run, t, placeOfPath);
      const on = !!w || tf.run.segs.some((g) => g.start <= t && t < g.end);
      state = {
        k: w ? "wait" : n.k,
        node: (
          <>
            <span className="trk">追踪</span>
            {w ? <i className="dot-c" /> : on && <i className="live" />}
            <b>{tf.parent ? fullName(tf) : tf.run.name}</b>
            <span>{w ? `在等你回复${w.question ? ` · ${w.question}` : ""}` : n.text || "空闲"}</span>
          </>
        ),
      };
    } else if (waiting.length) {
      const q = waitAt(waiting[0])?.question;
      state = { k: "wait", node: <><i className="dot-c" /><b>{waiting[0].run.name}</b><span>在等你回复{q ? ` · ${q}` : ""}</span></> };
    } else if (busy.length === 1) {
      const n = nowText(busy[0].run, now, placeOfPath);
      state = { k: n.k, node: <><i className="live" /><b>{busy[0].run.name}</b><span>{n.text}</span></> };
    } else if (busy.length > 1) state = { k: "busy", node: <><i className="live" /><span>{busy.length} 个会话在干活</span></> };
    else state = { k: "idle", node: <span>都空闲</span> };
    if (where?.empty && !tf) {
      const on = runs.flat.filter((f) => f.run.running || f.run.segs.some((g) => g.start <= now && now < g.end)).length;
      state = { k: on ? "busy" : "idle", node: <>{on > 0 && <i className="live" />}<span>{on > 0 ? `${on} 个 agent 在干活 · ` : ""}这张图还是空的</span></> };
    }
    if (quietAt != null) state = { k: "idle", node: <span>都空闲 · 上次活动 {hhmm(quietAt)}</span> };
    const subs = runs.flat.filter((f) => f.depth > 0).length;
    return (
      <div className="ws-bar">
        <button className="ttl" onClick={() => toggle(true)} title="展开时间线">
          <IconHistory size={14} />
          工位
        </button>
        <span className="stt" data-k={state.k}>{replay && !tf ? <><b className="rp">回放 {hhmmss(t)}</b><span>比实时晚 {dur(now - t)}</span></> : state.node}</span>
        <div className="mini" ref={miniRef} {...scrub(maxis)} title="拖动回看任意时刻" role="slider" aria-label="回放位置" aria-valuemin={maxis.start} aria-valuemax={maxis.end} aria-valuenow={Math.round(t)} aria-valuetext={hhmmss(t)} tabIndex={0} onKeyDown={onKey}>
          <canvas ref={miniCanvas} className="mini-cv" aria-hidden />
          <span className="mph" ref={mph} data-replay={replay ? "" : undefined} />
        </div>
        <span className="ws-cnt" title={tops.map((f) => f.run.name).join("、")} onPointerEnter={(e) => setDayAt(e.currentTarget)} onPointerLeave={() => setDayAt(null)}>
          <span className="stack">{tops.slice(0, 3).map((f) => <RunAvatar key={f.run.id} agent={f.run.agent} size={18} />)}</span>
          <span className="n">{tops.length} 个会话{subs ? ` · ${subs} 个子代理` : ""}</span>
          <span className="num">{tops.length}</span>
          {waiting.length > 0 && <span className="need"><i className="dot-c" />{waiting.length} 等你</span>}
        </span>
        {dayAt && canvasId && <DaySummary canvasId={canvasId} anchor={dayAt} />}
        <button className="icon-btn sm muted" data-open onClick={() => toggle(true)} aria-label="展开时间线" title="展开时间线"><IconEnter size={14} /></button>
      </div>
    );
  };

  // ── ⤢: one lane per agent ──
  const lanes = () => {
    const tail = axis.pieces.at(-1)?.kind === "tail" ? axis.pieces.at(-1)! : null;
    // Placed by `left`, not transform: a transform per segment gives each its own paint chunk (a 3D
    // one its own layer), which made every frame's layerize pay for thousands of segments.
    const X = (A: Axis, a: number, b: number, minus = 1) => ({ left: A.toPx(a), width: Math.max(0, A.toPx(b) - A.toPx(a) - minus) });
    const tx = (x: number) => ({ left: x });
    const visible = rows.filter((r) => r.y + r.h >= scrollTop - 40 && r.y <= scrollTop + innerHeight + 40);
    const sel = fo.segSel;

    const laneName = (r: Row) => {
      const run = r.f.run;
      const on = traced === run.id;
      if (r.rest) {
        return (
          <div key={`rest${run.id}`} className="lname sub rest" style={{ top: r.y, height: r.h }}>
            <button className="fold" onClick={() => setMore((o) => ({ ...o, [run.id]: true }))} title="展开所有子代理（只列当前时间附近最活跃的 8 个）">+{r.rest} 个子代理 ▸</button>
          </div>
        );
      }
      if (r.sub) {
        const rc = receiptAt(run, t);
        return (
          <Keyed key={run.id} k={`${r.y}|${r.h}|${rc}|${run.task}|${run.name}|${on}|${fl.run === run.id}`} node={
          <div className="lname sub" role="button" tabIndex={0} data-trace={on || undefined} style={{ top: r.y, height: r.h }} onClick={() => traceAndLocate(run.id)} onKeyDown={activate(() => traceAndLocate(run.id))} onPointerEnter={() => focus.hover(run.id)} onPointerLeave={() => focus.hover(null)} title={`${run.task ?? ""} · ${run.via === "dispatch" ? "Agora 派发" : "原生子代理"} · 点一下追踪它`}>
            <RunAvatar agent={run.agent} size={18} parent={r.f.parent?.agent} />
            <span className="t">
              <b>{fullName(r.f)}</b>
              {on && <span className="trk">追踪中</span>}
              {rc && <span className="now"><span className="rc" data-r={rc}>{receiptText(run, rc)}</span></span>}
            </span>
            <span className="lacts">{laneActs(run.id)}</span>
          </div>} />
        );
      }
      const g = run.segs.find((s) => s.start <= t && t < s.end);
      const k = g ? g.kind : "idle";
      const text = g ? (k === "wait" ? "等你回复" : g.label) : "空闲";
      const place = g?.path ? placeOfPath(g.path) : undefined;
      const nk = kidsOf(run.id).filter((x) => x.run.spawnAt != null && x.run.spawnAt < liveNow).length;
      return (
        <Keyed key={run.id} k={`${r.y}|${r.h}|${k}|${text}|${place}|${nk}|${!!fold[run.id]}|${run.name}|${on}|${fl.run === run.id}`} node={
        <div className="lname" role="button" tabIndex={0} data-trace={on || undefined} style={{ top: r.y, height: r.h }} onClick={() => traceAndLocate(run.id)} onKeyDown={activate(() => traceAndLocate(run.id))} onPointerEnter={() => focus.hover(run.id)} onPointerLeave={() => focus.hover(null)} title="追踪它，并在画布上找到它">
          <RunAvatar agent={run.agent} size={22} />
          <span className="t">
            <b>
              {run.name}
              {on && <span className="trk">追踪中</span>}
              {nk > 0 && (
                <span className="fold" role="button" aria-expanded={!fold[run.id]} title={`${fold[run.id] ? "展开" : "收起"}子代理`} onClick={(e) => (e.stopPropagation(), setFold((o) => ({ ...o, [run.id]: !o[run.id] })))}>
                  {fold[run.id] ? "▸" : "▾"} {nk}
                </span>
              )}
            </b>
            <span className="now" data-k={k}>{text}{place ? ` · ${place}` : ""}</span>
          </span>
          <span className="lacts">
            {r.f.root.sessionId && <button onClick={(e) => (e.stopPropagation(), ui.openSession(r.f.root.sessionId!))}>打开会话</button>}
            {laneActs(run.id)}
          </span>
        </div>} />
      );
    };

    const lane = (r: Row) => {
      const run = r.f.run;
      if (r.rest) return null;
      const segTop = r.sub ? 3 : 5;
      const segH = r.sub ? PX.sub - 6 : PX.lane - 10;
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
        out.push(
          <span key={`s${i}`} className="sg" data-seg={i} data-run={run.id} data-k={g.kind} data-sel={selI === i || undefined} data-hover={hovI === i || undefined} data-running={g.end > liveNow || undefined} style={{ ...X(axis, g.start, e), top: segTop, height: segH }}>
            {fitsLabel(segText(g), w - 1, 11, 6) && <span>{segText(g)}</span>}
          </span>,
        );
      });
      if (r.sub) {
        // the receipt line: what the dispatcher was told (the words are in the lane name and the hover card)
        const rc = run.receipts.filter((x) => x.at < liveNow);
        rc.forEach((x, i) => {
          const v = receiptView(run, x);
          const end = i + 1 < rc.length ? rc[i + 1].at : FINAL.has(v) || v === "accepted" ? Math.min(liveNow, x.at + 1200) : liveNow;
          out.push(<span key={`r${i}`} className="rcb" data-r={v} style={{ ...X(axis, x.at, end), top: PX.sub }} title={`${RECEIPT_NAMES[v]} · ${hhmmss(x.at)}`} />);
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

    return (
      <>
        <header className="tl-head">
          {replay ? (
            <span className="state" data-mode="replay">
              <IconHistory size={14} />回放 <b>{hhmmss(t)}</b>
              <span className="sub">· {axis.gapAt(t) ? "这时没人在干活" : `比实时晚 ${dur(now - t)}`}</span>
            </span>
          ) : (
            <span className="state" data-mode="live">
              <i />实时 <b style={{ fontWeight: 500 }}>{hhmmss(now)}</b>
              <span className="sub">· {tail ? `都空闲了 ${dur(now - tail.a)}` : "跟随最新动作"}</span>
            </span>
          )}
          <button className="ibtn" onClick={() => (replay?.playing ? clock.pause() : play())} aria-label={replay?.playing ? "暂停回放" : replay ? "从这里播放" : "从头回放"} title={`${replay?.playing ? "暂停" : replay ? "从这里播放" : "从头回放"}（空格）`}>
            {replay?.playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          {replay && (
            <>
              <button className="ibtn" onClick={() => stepEvent(-1)} aria-label="上一步" title="上一步（[）"><IconBack size={16} /></button>
              <button className="ibtn" onClick={() => stepEvent(1)} aria-label="下一步" title="下一步（]）"><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><IconBack size={16} /></span></button>
              <div className="segc" role="group" aria-label="回放速度">
                {SPEEDS.map((s) => (
                  <button key={s} aria-pressed={replay.speed === s} aria-label={`${s} 倍速`} onClick={() => (setSpd(s), clock.speed(s))}>{String(s).replace(/^0\./, ".")}×</button>
                ))}
              </div>
              <button className="btn primary" onClick={() => clock.live()}>回到实时</button>
            </>
          )}
          <button className="ibtn close" data-close onClick={() => toggle(false)} aria-label="收成细条" title="收成细条"><IconClose size={16} /></button>
        </header>
        <div className="tl-body" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div className="names" style={{ height }}>{visible.map(laneName)}</div>
          <div className="track" ref={trackRef} style={{ height }} {...scrub(axis)} tabIndex={0} role="slider" aria-label="回放位置" aria-valuemin={axis.start} aria-valuemax={axis.end} aria-valuenow={Math.round(t)} aria-valuetext={`${hhmmss(t)}${replay ? " 回放" : " 实时"}`} onKeyDown={onKey}>
            <div className="ruler" style={{ height: PX.ruler }}>
              {ticks(axis).map((k) => (
                <span key={k.t} className={k.major ? "tick maj" : "tick"} style={tx(k.x)}>{k.label && <span>{k.label}</span>}</span>
              ))}
              {axis.pieces.filter((p) => p.kind !== "act").map((p) => <span key={`b${p.a}`} className="rbreak" style={{ ...tx(p.x0), width: p.x1 - p.x0 }} />)}
            </div>
            {axis.pieces.filter((p) => p.kind !== "act").map((p) => (
              <span key={p.a} className="gap" data-kind={p.kind} data-at={replay && axis.gapAt(t) === p ? "" : undefined} style={{ ...tx(p.x0), width: p.x1 - p.x0, top: PX.ruler, height: height - PX.ruler }} title={`${hhmmss(p.a)}–${hhmmss(p.b)} 没有会话在干活（${dur(p.b - p.a)}），已压缩显示`}>
                <Zig h={height - PX.ruler} />
                {gapLabelFits(p.kind === "tail" ? "空闲中" : "空闲", dur(p.b - p.a), p.x1 - p.x0) && <span className="gl">{p.kind === "tail" ? "空闲中" : "空闲"}<br />{dur(p.b - p.a)}</span>}
              </span>
            ))}
            {conflicts.filter((c) => c.start < liveNow).map((c, i) => (
              <span key={`c${i}`} className="cband" style={{ ...X(axis, c.start, Math.min(c.end, liveNow), 0), top: PX.ruler, bottom: 0 }} />
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
                    <span className="conn down" style={{ ...tx(axis.toPx(k.spawnAt!)), top: pr.mid, height: r.mid - pr.mid }} />
                    {back != null && back < liveNow && <span className="conn up" style={{ ...tx(axis.toPx(back)), top: pr.mid, height: r.mid - pr.mid }} />}
                  </span>
                );
              })}
            {replay && <span className="future" ref={future} style={{ top: PX.ruler }} />}
            <span className="nowline" style={{ ...tx(axis.toPx(liveNow)), top: PX.ruler }} />
            <span className="ph" ref={ph} data-replay={replay ? "" : undefined}>
              <span className="knob" ref={knob}>
                <i />
                {replay ? hhmmss(t) : "现在"}
              </span>
            </span>
          </div>
        </div>
      </>
    );
  };

  // ── the hover card: what the old detail card said, and its two buttons ──
  const tipCard = (() => {
    if (!tip || !open) return null;
    const f = runs.flat.find((x) => x.run.id === tip.ref.run);
    const g = f?.run.segs[tip.ref.i];
    if (!f || !g) return null;
    const end = Math.min(g.end, now);
    const place = g.path ? placeOfPath(g.path) : where ? where.label(stateAt(f.run, g.start + 10, where.ctx).at) : undefined;
    const c = g.kind === "write" ? conflicts.find((x) => x.runs.includes(f.run.id) && x.path === g.path && x.start < g.end && g.start < x.end) : undefined;
    const other = c ? runs.flat.find((x) => x.run.id === c.runs.find((id) => id !== f.run.id)) : undefined;
    const checked = g.verifies ? runs.flat.find((x) => x.run.id === g.verifies) : undefined;
    const child = g.child ? runs.byId.get(g.child) : undefined;
    const what = g.kind === "exec" && g.cmd ? <div className="what mono">$ {g.cmd}</div> : g.path ? <div className="what mono">{g.path}</div> : g.cmd ? <div className="what mono">$ {g.cmd}</div> : g.kind === "wait" ? <div className="what">问：{g.question ?? "—"}</div> : child ? <div className="what">{child.name}：{child.task ?? "—"}</div> : null;
    return (
      <div className="tip" style={{ left: Math.max(8, Math.min(innerWidth - TIP_W - 8, tip.x - TIP_W / 2)), top: tip.y - 4 }} onPointerEnter={keepTip} onPointerLeave={hideTipSoon}>
        <h4>
          <RunAvatar agent={f.run.agent} size={16} />
          {fullName(f)} · {g.verifies ? "验收 · " : ""}
          {KIND_NAME[g.kind] ?? g.kind}
          {g.comment ? ` · 处理评论 #${g.comment.n}` : ""}
        </h4>
        {what}
        <dl>
          {place && <><dt>在</dt><dd>{place}</dd></>}
          <dt>时间</dt>
          <dd>{hhmmss(g.start)}–{hhmmss(end)} · {secs(end - g.start)}</dd>
          {f.parent ? <><dt>任务</dt><dd>{f.run.task ?? "—"}（{f.run.via === "dispatch" ? "Agora 派发" : "原生子代理"}）</dd></> : g.turn != null && <><dt>轮次</dt><dd>第 {g.turn} 轮</dd></>}
          {checked && <><dt>验收</dt><dd>{fullName(checked)}</dd></>}
          {c && other && <><dt>冲突</dt><dd className="warn">和 {fullName(other)} 同时写这个文件（{hhmmss(c.start)}–{hhmmss(c.end)}）</dd></>}
          {child && (
            <>
              <dt>回执</dt>
              <dd className="chain">
                {child.receipts.filter((x) => x.at < now).map((x, i) => (
                  <span key={i}>{i ? "→ " : ""}<span className="rc" data-r={receiptView(child, x)}>{RECEIPT_NAMES[receiptView(child, x)]}</span> {hhmmss(x.at)}</span>
                ))}
              </dd>
            </>
          )}
        </dl>
        {(f.root.sessionId || g.path) && (
          <div className="acts">
            {f.root.sessionId && <button className="btn sm quiet" onClick={() => openSeg(f.run.id, g)}><IconMessage size={14} />在会话里看</button>}
            {g.path && <button className="btn sm quiet" onClick={() => locateSeg(f.run.id, tip.ref.i)}><IconTarget size={14} />定位节点</button>}
          </div>
        )}
      </div>
    );
  })();

  return (
    <section
      className="ws-tl"
      ref={sectionEl}
      data-replay={replay ? "" : undefined}
      aria-label="工位时间线"
      // the page's Esc keeps out of the timeline; here too it lets go of a trace first (a lane name, a button)
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && focus.get().traced) (e.preventDefault(), focus.escape());
      }}
    >
      {/* the height follows what is inside by a CSS transition: it is sampled once per frame, so it
          moves in even steps (a JS tween timed inside its own rAF batch did not) */}
      <div className="ws-tl-anim" style={{ height: innerH }} onTransitionEnd={(e) => void (e.target === e.currentTarget && (timelineResize.at = performance.now()))}>
        <div ref={innerRef}>{open ? lanes() : strip()}</div>
      </div>
      {/* the words replay brings in, laid out once up front: the first scrub never waits on new glyphs */}
      <span className="ws-warm" aria-hidden>{WARM}</span>
      {tipCard}
    </section>
  );
}
