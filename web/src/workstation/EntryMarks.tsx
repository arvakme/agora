// 子图入口 on a canvas (web/docs/workstation.md §10 子视图跟随): while agents are in a node's sub-view,
// that node shows their avatars at its bottom-left (three, then +N; a click follows that agent in the
// follow pane), and a pale purple ring while one of them writes in there. Who is inside comes from
// ./subview.ts, relative to this canvas, so it works on the pane's picture of a canvas too.
// Mounted inside the canvas overlay (./Overlay.tsx `.ws-layer`, which clips it); rebuilt ≤ 4 Hz,
// moved by the frame loop with the view.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { nodeBox } from "../canvas/nodes";
import { viewport } from "../canvas/viewport";
import { useNested } from "../nested/store";
import { clock, useReplay, useTick } from "./clock";
import { canvasOfView, follow } from "./follow";
import { frame } from "./frame";
import { RunAvatar } from "./RunAvatar";
import { useRuns } from "./runs/store";
import { presenceAt, subviewCtx } from "./subview";
import "./follow.css";

const SHOWN = 3;
type Door = { node: string; box: Box; title: string; ids: string[]; writing: boolean };

export function EntryMarks({ view }: { view: CanvasViewState }) {
  const canvasId = canvasOfView(view.id);
  const runs = useRuns();
  const nst = useNested();
  useReplay();
  useTick(250);
  const t = clock.time();
  const ctx = useMemo(() => subviewCtx(canvasId, nst.scenes, nst.titles, (id) => runs.byId.get(id)), [canvasId, nst.scenes, nst.titles, runs]);
  const at = new Map<string, Omit<Door, "box">>();
  for (const x of runs.flat) {
    const p = presenceAt(x.run, t, ctx);
    if (!p?.levels || p.levels.length < 2) continue;
    const node = p.levels[0].node;
    const d = at.get(node) ?? { node, title: p.levels[1].title, ids: [], writing: false };
    d.ids.push(x.run.id);
    if (!p.ended && x.run.segs.some((g) => g.kind === "write" && g.start <= t && t < g.end)) d.writing = true;
    at.set(node, d);
  }
  const doors: Door[] = [...at.values()].flatMap((d) => {
    const el = view.map.get(d.node);
    return el && !el.isDeleted ? [{ ...d, box: nodeBox(el, view.map, view.elements) }] : [];
  });

  const world = useRef<SVGGElement>(null);
  const marks = useRef(new Map<string, HTMLElement>());
  const boxes = useRef(new Map<string, Box>());
  const drawn = useRef({ key: "", gen: 0 });
  boxes.current = new Map(doors.map((d) => [d.node, d.box]));
  drawn.current.gen++;
  /** Screen position of a node's mark: its bottom-left corner, straddling the bottom edge. */
  const place = (node: string, el: HTMLElement) => {
    const v = viewport.get(view.id);
    const b = boxes.current.get(node);
    if (v && b) el.style.transform = `translate3d(${((b.x + v.scrollX) * v.zoom + 8).toFixed(2)}px, ${((b.y + b.h + v.scrollY) * v.zoom - 12).toFixed(2)}px, 0)`;
  };
  /** Follow the view (per frame, only when it or the marks changed). */
  const sync = useRef(() => {});
  sync.current = () => {
    const v = viewport.get(view.id);
    if (!v) return;
    const key = `${v.scrollX}|${v.scrollY}|${v.zoom}|${drawn.current.gen}`;
    if (key === drawn.current.key) return;
    drawn.current.key = key;
    world.current?.setAttribute("transform", `matrix(${v.zoom} 0 0 ${v.zoom} ${v.scrollX * v.zoom} ${v.scrollY * v.zoom})`);
    for (const [node, el] of marks.current) place(node, el);
  };
  useLayoutEffect(() => sync.current());
  useEffect(() => frame.add(() => sync.current()), []);

  const byId = new Map(runs.flat.map((x) => [x.run.id, x]));
  return (
    <div className="ws-doors" aria-hidden={!doors.length}>
      <svg className="ws-doors-rings">
        <g ref={world}>
          {doors.map((d) => (d.writing ? <rect key={d.node} x={d.box.x - 9} y={d.box.y - 9} width={d.box.w + 18} height={d.box.h + 18} rx={16} vectorEffect="non-scaling-stroke" /> : null))}
        </g>
      </svg>
      {doors.map((d) => (
        <div
          key={d.node}
          className="ws-door"
          ref={(el) => {
            if (el) (marks.current.set(d.node, el), place(d.node, el));
            else marks.current.delete(d.node);
          }}
          title={`在子图「${d.title || "未命名画布"}」里：${d.ids.map((id) => byId.get(id)?.run.name ?? id).join("、")}`}
        >
          {d.ids.slice(0, SHOWN).map((id) => {
            const x = byId.get(id);
            return x ? (
              <button key={id} onPointerDown={(e) => e.stopPropagation()} onClick={() => follow.start(id)} aria-label={`跟随 ${x.run.name}`}>
                <RunAvatar agent={x.run.agent} size={18} />
              </button>
            ) : null;
          })}
          {d.ids.length > SHOWN && <em>+{d.ids.length - SHOWN}</em>}
        </div>
      ))}
    </div>
  );
}
