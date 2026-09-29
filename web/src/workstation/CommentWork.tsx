// 评论联动 on the canvas (web/docs/workstation.md §评论联动与进出子图): while an agent works on a canvas
// comment (its turn began with it: ./place.ts `commentSpans`), a thin purple dashed line runs from the
// comment's pin to the worker's head; when the turn ends — its answer goes to the thread — a check pops
// on the pin and fades (CHECK_MS). Both come from the runs and the one clock, so a replay shows the same
// (live, an answer that arrives a little late still gets its check, once). Reduced motion: the line and
// the check only show and go. Mounted by the comment layer (../comments/CommentLayer.tsx) over its pins,
// in screen space; the frame loop (./frame.ts) moves it with the view and the figure.
import { useEffect, useRef } from "react";
import type { El } from "../canvas/scene";
import { viewport } from "../canvas/viewport";
import type { Thread } from "../comments/threads";
import { clock, prefersReducedMotion, useReplay, useTick, useWorkstation } from "./clock";
import { figurePositions } from "./focus";
import { frame } from "./frame";
import { canvasWhere, commentSpans, stateAt, type CommentSpan } from "./place";
import { RIG, SUB_SCALE } from "./rig";
import { MOCK_COMMENT } from "./runs/fixtures";
import { runs as runStore, useRuns } from "./runs/store";
import type { FlatRun } from "./runs/types";

/** A pin on this canvas: its thread's number, the elements it is pinned to, and the middle of its body (scene coordinates). */
export type PinAt = { n: number; ids: readonly string[]; x: number; y: number };

/** The check on the pin when the answer comes: pops, holds, fades. */
export const CHECK_MS = 600;
const LINE_IN_MS = 200;
const LINE_OUT_MS = 300;
/** Live, an answer first seen this long after it came (the page just opened) gets no check. */
const LATE_MS = 5000;
/** The line starts this far from the pin's middle (its body is 28 px round) and stops short of the head. */
const PIN_R = 16;
const HEAD_GAP = 3;
/** The head's middle above the feet, in figure units (./rig.ts). */
const HEAD_Y = RIG.hip + RIG.torso + RIG.head;

type Item = { key: string; f: FlatRun; span: CommentSpan };
type Nodes = { line: SVGPathElement | null; check: SVGGElement | null; ring: SVGCircleElement | null };
const px = (n: number) => n.toFixed(2);

export function CommentWork({ canvasId, pins }: { canvasId: string; pins: readonly PinAt[] }) {
  const rs = useRuns();
  const on = useWorkstation(canvasId);
  useReplay();
  const any = on && rs.flat.some((f) => commentSpans(f.run).length > 0);
  useTick(250, any);
  // which comment turns are near now (≤ 4 Hz); the frame job below draws them
  const t = clock.time();
  const items: Item[] = [];
  if (any) for (const f of rs.flat) for (const span of commentSpans(f.run)) if (span.start - 500 <= t && t < span.end + LATE_MS) items.push({ key: `${f.run.id}|${span.turn ?? ""}|${span.n}|${span.start}`, f, span });
  const latest = useRef({ items, pins, all: rs.flat });
  latest.current = { items, pins, all: rs.flat };
  const svg = useRef<SVGSVGElement>(null);
  const nodes = useRef(new Map<string, Nodes>());

  useEffect(() => {
    const vis = new Map<string, number>();
    const seen = new Map<string, number>();
    let lastNow = 0;
    let lastGen = clock.gen();
    return frame.add((now) => {
      const root = svg.current;
      if (!root || root.closest('[data-hidden="true"]')) return;
      const v = viewport.get(canvasId);
      if (!v) return;
      const { items, pins, all } = latest.current;
      const still = prefersReducedMotion();
      const replay = clock.get();
      const t = clock.time(now);
      const dt = lastNow ? Math.min(100, now - lastNow) : 0;
      lastNow = now;
      const jump = clock.gen() !== lastGen;
      lastGen = clock.gen();
      const ctx = canvasWhere.get(canvasId)?.ctx;
      // figures keep a readable size, as the overlay draws them (Overlay.tsx, the frame job)
      const fsc = Math.max(1, Math.min(1.6, v.zoom * 1.2));
      const scr = (x: number, y: number) => ({ x: (x + v.scrollX) * v.zoom, y: (y + v.scrollY) * v.zoom });
      for (const it of items) {
        const n = nodes.current.get(it.key);
        if (!n) continue;
        const s = it.span;
        const pin = pins.find((p) => p.n === s.n && p.ids.some((id) => s.anchor.includes(id)));
        // the line: while it works on the comment and stands on this canvas
        const st = ctx ? stateAt(it.f.run, t, ctx) : null;
        const feet = figurePositions.get(canvasId, it.f.run.id);
        const want = pin && st?.present && feet && t >= s.start && t < s.end ? 1 : 0;
        const prev = vis.get(it.key) ?? 0;
        const a = still || jump ? want : Math.max(0, Math.min(1, prev + (want ? dt / LINE_IN_MS : -dt / LINE_OUT_MS)));
        vis.set(it.key, a);
        if (n.line) {
          if (a > 0 && pin && feet) {
            const p = scr(pin.x, pin.y);
            const k = fsc * (it.f.depth > 0 ? SUB_SCALE : 1);
            const h = scr(feet.x, feet.y);
            h.y -= HEAD_Y * k;
            const d = Math.hypot(h.x - p.x, h.y - p.y);
            const cut = RIG.head * k + HEAD_GAP;
            if (d > PIN_R + cut + 4) {
              const ux = (h.x - p.x) / d;
              const uy = (h.y - p.y) / d;
              const ax = p.x + ux * PIN_R, ay = p.y + uy * PIN_R;
              const bx = h.x - ux * cut, by = h.y - uy * cut;
              // a gentle arc, bowed upward (it reads as a link, not an edge of the diagram), over the heads
              // of anyone standing in between, so it is clear whose head it ends at
              let cy = Math.min(ay, by) - Math.min(28, d * 0.18);
              for (const o of ctx ? all : []) {
                const q = o.run.id === it.f.run.id ? undefined : figurePositions.get(canvasId, o.run.id);
                if (!q || !stateAt(o.run, t, ctx!).present) continue;
                const oq = scr(q.x, q.y);
                const along = (oq.x - ax) / (bx - ax);
                if (!(along > 0.05 && along < 0.95)) continue;
                const top = oq.y - (HEAD_Y + RIG.head) * fsc * (o.depth > 0 ? SUB_SCALE : 1) - 6;
                cy = Math.min(cy, (top - (1 - along) ** 2 * ay - along * along * by) / (2 * along * (1 - along)));
              }
              cy = Math.max(cy, Math.min(ay, by) - 120);
              n.line.setAttribute("d", `M${px(ax)} ${px(ay)}Q${px((ax + bx) / 2)} ${px(cy)} ${px(bx)} ${px(by)}`);
            }
          }
          // as visible as the worker (coming out of a door, leaving)
          n.line.setAttribute("opacity", (a * (st?.fade ?? 1)).toFixed(3));
        }
        // the check: once, when the answer comes (replay: at the turn's end; live: when the page learns of it)
        let u = -1;
        if (!s.open && t >= s.end && pin) {
          let s0 = s.end;
          if (!replay) {
            if (!seen.has(it.key)) seen.set(it.key, now);
            const first = seen.get(it.key)!;
            s0 = first - s.end > LATE_MS ? Infinity : Math.max(s.end, first);
          }
          u = ((replay ? t : now) - s0) / CHECK_MS;
        }
        if (n.check) {
          if (u >= 0 && u < 1 && pin) {
            const p = scr(pin.x, pin.y);
            // pops (0.5 → 1.15 → 1), holds, fades from 65 %
            const sc = still ? 1 : u < 0.2 ? 0.5 + 0.65 * (u / 0.2) : u < 0.35 ? 1.15 - 0.15 * ((u - 0.2) / 0.15) : 1;
            const op = still ? 1 : u < 0.1 ? u / 0.1 : u < 0.65 ? 1 : 1 - (u - 0.65) / 0.35;
            n.check.setAttribute("transform", `translate(${px(p.x)} ${px(p.y)}) scale(${sc.toFixed(3)})`);
            n.check.setAttribute("opacity", op.toFixed(3));
            n.ring?.setAttribute("r", px(12 + 12 * u));
            n.ring?.setAttribute("opacity", still ? "0" : (0.6 * (1 - u)).toFixed(3));
          } else n.check.setAttribute("opacity", "0");
        }
      }
    });
  }, [canvasId]);

  return (
    <svg ref={svg} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none", zIndex: 2 }}>
      {items.map((it) => (
        <g
          key={it.key}
          data-comment={it.span.n}
          data-run={it.f.run.id}
          ref={(g) => {
            if (g) nodes.current.set(it.key, { line: g.querySelector("path"), check: g.querySelector("g"), ring: g.querySelector("circle") });
            else nodes.current.delete(it.key);
          }}
        >
          <path fill="none" stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 3" strokeLinecap="round" opacity={0} />
          <g opacity={0}>
            <circle r={12} fill="none" stroke="var(--accent)" strokeWidth={1.5} opacity={0} />
            <circle r={11} fill="var(--accent-fill)" stroke="var(--surface)" strokeWidth={2} />
            <path d="M-4.6 0.3L-1.4 3.5L4.8 -3.2" fill="none" stroke="var(--accent-fg)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g>
      ))}
    </svg>
  );
}

const NONE: Thread[] = [];
/** The dev mock's comment (`?mock=runs`: ./runs/fixtures.ts MOCK_COMMENT) as a pin to show — only there,
 * never saved or opened — so the script's comment turn has its pin: turning while the turn runs. */
export function useMockThreads(map: ReadonlyMap<string, El>): Thread[] {
  const rs = useRuns();
  useReplay();
  useTick(250, runStore.mock);
  const el = map.get(MOCK_COMMENT.anchor[0]);
  if (!runStore.mock || !el || el.isDeleted) return NONE;
  const t = clock.time();
  const running = rs.flat.some((f) => commentSpans(f.run).some((s) => s.n === MOCK_COMMENT.n && s.start <= t && t < s.end));
  return [
    {
      id: `mock:${MOCK_COMMENT.n}`,
      n: MOCK_COMMENT.n,
      anchor: { ids: [...MOCK_COMMENT.anchor], rel: { x: 1, y: 0 }, last: { x: el.x + el.width, y: el.y } },
      resolved: false,
      agent: running ? "running" : "idle",
      messages: [{ id: "mock:m1", author: "you", text: MOCK_COMMENT.text, at: 0 }],
      createdAt: 0,
    },
  ];
}
