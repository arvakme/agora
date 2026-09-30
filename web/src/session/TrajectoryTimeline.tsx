// The trajectory's overview strip: three lanes (user / message / tool) on one canvas, a fixed height
// however long the conversation is. Geometry and wording are in ./timelineLayout.ts, drawing in
// ./timelinePaint.ts; this file is the pointer, the keyboard, the 0.5 s hover and the legend.
// Structure after DeepSeek Harness's TrajectoryTimeline (github.com/deepseek-ai/deepseek-harness, MIT).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { useDragGuard } from "../app/dragGuard";
import { IconChevron } from "../app/icons";
import { CLASS_NAME, HEIGHT, LANES, LANE_H, hitTest, hoverText, laneTop, layoutTimeline, lookOfClass, stepCursor, targetsInOrder, type Cls, type Target } from "./timelineLayout";
import { paintTimeline, readPalette, type Palette } from "./timelinePaint";
import { HANDLE_HIT, caption, domainOf, dragEdge, edgeX, keepTurns, panSel, partAt, posAtX, range, selectBetween, stepEdge, turnsOf, type Edge, type Part, type Sel } from "./timelineSelection";
import type { TimelineModel } from "./trajectoryModel";

/** How long the pointer (or the keyboard cursor) rests on a block before its details show. */
export const HOVER_MS = 500;
const LANE_NAMES = ["用户", "消息", "工具"];
const LEGEND: Cls[] = ["user", "message", "read", "write", "run", "agent", "wait", "fail", "other"];
const LEGEND_KEY = "agora.trajectory.legend";
const TIP_HALF = 130; // half the tooltip's widest width, to keep it inside the strip

export type TimelineProps = {
  model: TimelineModel;
  /** The stretch picked by dragging on the strip: the ledger shows only its records. Kept as records (./timelineSelection.ts). */
  sel: Sel | null;
  onSel: (s: Sel | null) => void;
  /** A record's block was clicked (a band: its first record). */
  onPick: (index: number) => void;
  /** A folded turn's bar was clicked. */
  onPickTurn: (turn: number) => void;
  /** The record open in the ledger. */
  selectedIndex: number | null;
  /** The turn the ledger / the replay is on. */
  activeTurn: number | null;
};

export function TrajectoryTimeline({ model, sel, onSel, onPick, onPickTurn, selectedIndex, activeTurn }: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const palette = useRef<Palette | null>(null);
  // what a press on the strip is doing: picking out a new stretch, moving an edge, or carrying the whole stretch
  const drag = useRef<{ mode: "new" | Edge | "pan"; x0: number; moved: boolean; start: Sel | null; startPos: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [ver, setVer] = useState(0); // a theme change: the palette is read again
  const [live, setLive] = useState<Sel | null>(null);
  const [part, setPart] = useState<Part>("out");
  const [pointerKey, setPointerKey] = useState<string | null>(null);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [tip, setTip] = useState<Target | null>(null);
  const guard = useDragGuard();

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const again = () => ((palette.current = null), setVer((v) => v + 1));
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", again);
    return () => (mo.disconnect(), mq.removeEventListener("change", again));
  }, []);

  const dom = useMemo(() => domainOf(model), [model]);
  // the turns of a picked stretch stay open as blocks (folded turns inside it are unfolded, as far as they fit); a stretch being dragged does not move the strip under the pointer
  const keep = useMemo(() => (sel ? keepTurns(dom, sel) : undefined), [dom, sel]);
  const lay = useMemo(() => (width > 0 ? layoutTimeline(model, width, keep) : null), [model, width, keep]);
  const order = useMemo(() => (lay ? targetsInOrder(lay) : []), [lay]);
  const byKey = useMemo(() => new Map(order.map((t) => [t.key, t])), [order]);
  // kept by key: a record arriving re-lays the strip, and what is under the pointer follows
  const pointer = (pointerKey && byKey.get(pointerKey)) || null;
  const cursor = (cursorKey && byKey.get(cursorKey)) || null;
  const hot = pointer ?? cursor;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !lay) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(lay.width * dpr) || el.height !== Math.round(HEIGHT * dpr)) {
      el.width = Math.round(lay.width * dpr);
      el.height = Math.round(HEIGHT * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    palette.current ??= readPalette(el);
    paintTimeline(ctx, lay, palette.current, { selected: selectedIndex, turn: activeTurn, hot: pointer, cursor });
  }, [lay, selectedIndex, activeTurn, pointer, cursor, ver]);

  // the details show after the pointer or the cursor has rested on one thing for HOVER_MS, and go as soon as it moves on
  useEffect(() => {
    setTip(null);
    if (!hot) return;
    const t = setTimeout(() => setTip(hot), HOVER_MS);
    return () => clearTimeout(t);
  }, [hot?.key]);

  const at = (e: { clientX: number; clientY: number }) => {
    const b = track.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const hover = (t: Target | null) => setPointerKey(t?.key ?? null);
  const shown = live ?? sel;
  const down = (e: RPointerEvent) => {
    if (e.button !== 0 || !lay) return;
    const x = at(e).x;
    const where = partAt(lay, dom, shown, x);
    const mode = where === "left" || where === "right" ? where : where === "body" ? "pan" : "new";
    guard(e, { cursor: mode === "new" ? undefined : mode === "pan" ? "grabbing" : "ew-resize", onEnd: (why) => why !== "up" && ((drag.current = null), setLive(null)) });
    drag.current = { mode, x0: e.clientX, moved: false, start: shown, startPos: posAtX(lay, dom, x) };
    hover(null);
  };
  const move = (e: RPointerEvent) => {
    if (!lay) return;
    const { x, y } = at(e);
    const d = drag.current;
    if (!d) {
      const where = partAt(lay, dom, shown, x);
      setPart(where);
      return hover(where === "left" || where === "right" ? null : hitTest(lay, x, y));
    }
    if (Math.abs(e.clientX - d.x0) >= 3) d.moved = true;
    if (!d.moved) return;
    const p = posAtX(lay, dom, x);
    if (d.mode === "new") setLive(selectBetween(dom, d.startPos, p));
    else if (d.mode === "pan") setLive(panSel(dom, d.start!, p - d.startPos));
    else setLive(dragEdge(dom, d.start!, d.mode, p));
  };
  const up = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && live) onSel(live);
    else if (d && !d.moved && lay && d.mode !== "left" && d.mode !== "right") {
      const hit = hitTest(lay, at(e).x, at(e).y);
      if (hit) pick(hit);
      else if (d.mode === "new" && sel) onSel(null); // a click on empty strip lets go of the stretch
    }
    setLive(null);
  };
  const pick = (t: Target | null) => {
    if (!t) return;
    if (t.kind === "bar") onPickTurn(t.turn);
    else onPick(t.first);
  };
  const keys = (e: RKeyboardEvent) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir) setCursorKey(stepCursor(order, cursorKey, dir));
    else if (e.key === "Home") setCursorKey(order[0]?.key ?? null);
    else if (e.key === "End") setCursorKey(order.at(-1)?.key ?? null);
    else if ((e.key === "Enter" || e.key === " ") && cursor) pick(cursor);
    else if (e.key === "Escape") (setCursorKey(null), onSel(null));
    else return;
    e.preventDefault();
  };
  // an edge of the stretch, from the keyboard: ← → one record, Shift one turn, Esc lets go
  const edgeKeys = (edge: Edge) => (e: RKeyboardEvent) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir && sel) onSel(stepEdge(dom, sel, edge, dir, e.shiftKey ? "turn" : "record"));
    else if (e.key === "Escape") {
      onSel(null);
      track.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // tabbing in puts the cursor on the picked record (or the first thing); its details show after the usual pause
  const focused = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.matches(":focus-visible")) return;
    const picked = selectedIndex != null ? order.find((t) => t.key === `c${selectedIndex}`)?.key : undefined;
    setCursorKey((k) => k ?? picked ?? order[0]?.key ?? null);
  };

  const tipText = tip ? hoverText(tip) : null;
  const tipX = tip && lay ? Math.min(Math.max(tip.x + tip.w / 2, Math.min(TIP_HALF, lay.width / 2)), Math.max(lay.width - TIP_HALF, lay.width / 2)) : 0;
  return (
    <div className="ds-timeline-wrap">
      <div className="ds-timeline" style={{ height: HEIGHT }}>
        <div className="ds-timeline-labels" aria-hidden>
          {LANE_NAMES.slice(0, LANES).map((n, i) => (
            <span key={n} style={{ top: laneTop(i) + (LANE_H - 10) / 2 }}>
              {n}
            </span>
          ))}
        </div>
        <div
          className="ds-timeline-track"
          ref={track}
          role="group"
          aria-label="轨迹时间轴"
          data-part={part === "out" ? undefined : part}
          aria-describedby={tip ? "ds-timeline-tip" : undefined}
          tabIndex={0}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={() => (hover(null), setPart("out"))}
          onKeyDown={keys}
          onFocus={focused}
          onBlur={() => setCursorKey(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            onSel(null);
          }}
        >
          <canvas ref={canvas} style={{ width: lay?.width ?? 0, height: HEIGHT }} />
          {lay && shown && <SelectionOverlay lay={lay} dom={dom} sel={shown} live={!!live} edgeKeys={edgeKeys} />}
          {!shown && <span className="ds-tl-hint" aria-hidden>拖动选一段 · Esc 取消</span>}
        </div>
        {tipText && (
          <div id="ds-timeline-tip" className="ds-timeline-tip" role="tooltip" style={{ "--x": `${tipX}px` } as React.CSSProperties}>
            <b>{tipText.title}</b>
            {tipText.lines.map((l, i) => (
              <span key={i} className={i === 0 ? "ds-mono" : undefined}>
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      <Legend />
    </div>
  );
}

const STEP_HELP = "←→ 移动一条，Shift+←→ 移动一轮，Esc 取消选区";
type OverlayProps = { lay: NonNullable<ReturnType<typeof layoutTimeline>>; dom: ReturnType<typeof domainOf>; sel: Sel; live: boolean; edgeKeys: (edge: Edge) => (e: RKeyboardEvent) => void };
/**
 * The picked stretch on the strip: everything outside it washed over, a purple frame, a grip on each edge
 * (focusable: the pointer goes through them, the strip does the dragging) and a caption. Plain elements, so
 * dragging it never repaints the canvas.
 */
function SelectionOverlay({ lay, dom, sel, live, edgeKeys }: OverlayProps) {
  const [x0, x1] = edgeX(lay, dom, sel);
  const [r0, r1] = range(dom, sel);
  const [t0, t1] = turnsOf(dom, sel);
  const edge = (e: Edge, x: number, r: number, turn: number) => {
    const label = e === "left" ? "选区左边界" : "选区右边界";
    return (
      <span
        className="ds-tl-handle"
        data-edge={e}
        role="slider"
        tabIndex={live ? -1 : 0}
        aria-label={`${label}。${STEP_HELP}`}
        aria-orientation="horizontal"
        aria-valuemin={dom.ordered[0].index}
        aria-valuemax={dom.ordered[dom.ordered.length - 1].index}
        aria-valuenow={dom.ordered[r].index}
        aria-valuetext={`第 ${turn} 轮 #${dom.ordered[r].index}`}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Escape"
        style={{ left: x - HANDLE_HIT / 2, width: HANDLE_HIT }}
        onKeyDown={edgeKeys(e)}
      />
    );
  };
  return (
    <>
      <span className="ds-tl-dim" style={{ left: 0, width: Math.max(x0, 0) }} aria-hidden />
      <span className="ds-tl-dim" style={{ left: x1, right: 0 }} aria-hidden />
      <span className="ds-tl-sel" data-live={live || undefined} style={{ left: x0, width: Math.max(x1 - x0, 1) }} aria-hidden />
      <span className="ds-tl-cap" data-side={x1 < 130 ? "left" : "right"} style={x1 < 130 ? { left: x0 } : { right: lay.width - x1 }} aria-live={live ? undefined : "polite"}>
        {caption(dom, sel)}
      </span>
      {edge("left", x0, r0, t0)}
      {edge("right", x1, r1, t1)}
    </>
  );
}

/** One line under the strip: what each colour and shape means. Folds away to just its handle. */
function Legend() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(LEGEND_KEY, open ? "0" : "1");
    } catch {
      /* private window: the choice lasts until the page closes */
    }
  };
  return (
    <div className="ds-tl-legend" data-open={open}>
      <button className="ds-text-btn" onClick={toggle} aria-expanded={open} aria-label="图例">
        <IconChevron open={open} />
        图例
      </button>
      {open && (
        <ul>
          {LEGEND.map((c) => {
            const look = lookOfClass(c);
            return (
              <li key={c} data-cls={c}>
                <i style={{ "--c": `var(${look.token})` } as React.CSSProperties} data-fill={look.fill} data-cross={look.cross || undefined} aria-hidden />
                {CLASS_NAME[c]}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
