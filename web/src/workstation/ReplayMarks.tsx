// The nodes a PR replay changes (web/docs/workstation.md「PR 回放」): a purple frame round each node
// that has been written so far, and 「+N」 at its top right — how many of the PR's files landed there by
// this moment, counting up as the writes go. A parent node shows its sub-diagram's total (the canvas's
// own `locate` puts every file of a sub-diagram on the node that opens it), and the follow pane's
// picture of the sub-diagram shows its own nodes. Mounted while a PR plays (./Overlay.tsx); rebuilt
// ≤ 4 Hz, moved by the frame loop with the view. Reduced motion: the frame and the number, no fade.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { nodeBox } from "../canvas/nodes";
import { viewport } from "../canvas/viewport";
import { clock, useReplay, useTick } from "./clock";
import { frame } from "./frame";
import { OUTSIDE, type Ctx } from "./place";
import { fileCounts } from "./replay";
import { useRuns } from "./runs/store";
import "./replay.css";

export function ReplayMarks({ view, ctx }: { view: CanvasViewState; ctx: Ctx }) {
  const runs = useRuns();
  useReplay();
  useTick(250);
  const t = clock.time();
  const run = runs.roots[0];
  const counts = run ? fileCounts(run, t, (p) => {
    const at = ctx.locate(p)?.place;
    return at && at !== OUTSIDE ? at : null;
  }) : new Map<string, number>();
  const nodes = [...counts].flatMap(([id, n]) => {
    const el = view.map.get(id);
    return el && !el.isDeleted ? [{ id, n, box: nodeBox(el, view.map, view.elements) }] : [];
  });
  const world = useRef<SVGGElement>(null);
  const marks = useRef(new Map<string, HTMLElement>());
  const boxes = useRef(new Map<string, Box>());
  const drawn = useRef({ key: "", gen: 0 });
  boxes.current = new Map(nodes.map((d) => [d.id, d.box]));
  drawn.current.gen++;
  /** A node's badge: its top right corner, straddling the top edge. */
  const place = (id: string, el: HTMLElement) => {
    const v = viewport.get(view.id);
    const b = boxes.current.get(id);
    if (v && b) el.style.transform = `translate3d(${((b.x + b.w + v.scrollX) * v.zoom).toFixed(2)}px, ${((b.y + v.scrollY) * v.zoom).toFixed(2)}px, 0)`;
  };
  const sync = useRef(() => {});
  sync.current = () => {
    const v = viewport.get(view.id);
    if (!v) return;
    const key = `${v.scrollX}|${v.scrollY}|${v.zoom}|${drawn.current.gen}`;
    if (key === drawn.current.key) return;
    drawn.current.key = key;
    world.current?.setAttribute("transform", `matrix(${v.zoom} 0 0 ${v.zoom} ${v.scrollX * v.zoom} ${v.scrollY * v.zoom})`);
    for (const [id, el] of marks.current) place(id, el);
  };
  useLayoutEffect(() => sync.current());
  useEffect(() => frame.add(() => sync.current()), []);
  return (
    <div className="ws-pr-marks" aria-hidden={!nodes.length}>
      <svg className="ws-pr-frames">
        <g ref={world}>
          {nodes.map((d) => (
            <rect key={d.id} x={d.box.x - 4} y={d.box.y - 4} width={d.box.w + 8} height={d.box.h + 8} rx={12} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
      {nodes.map((d) => (
        <span
          key={d.id}
          className="ws-pr-n"
          ref={(el) => {
            if (el) (marks.current.set(d.id, el), place(d.id, el));
            else marks.current.delete(d.id);
          }}
          title={`这个 PR 到这一刻改了这里的 ${d.n} 个文件`}
        >
          +{d.n}
        </span>
      ))}
    </div>
  );
}
