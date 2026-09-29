// The nodes a PR replay changes (web/docs/workstation.md「PR 回放」): a purple frame round each node
// that has been written so far, and 「+N」 at its top right — how many of the PR's files landed there by
// this moment, counting up as the writes go. A parent node shows its sub-diagram's total (the canvas's
// own `locate` puts every file of a sub-diagram on the node that opens it), and the follow pane's
// picture of the sub-diagram shows its own nodes. Mounted while a PR plays (./Overlay.tsx); rebuilt
// ≤ 4 Hz, moved by the frame loop with the view. Reduced motion: the frame and the number, no fade.
import { useEffect, useLayoutEffect, useRef } from "react";
import { excalidrawEl, occupiedOf } from "./replayDom";
import { placeBadge } from "./replayFit";
import { replays } from "./replayMode";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { nodeBox } from "../canvas/nodes";
import { viewport } from "../canvas/viewport";
import { clock, useReplay, useTick } from "./clock";
import { frame } from "./frame";
import { OUTSIDE, stateAt, type Ctx } from "./place";
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
  // The summary at the end is on the whole diagram; when the figure is still behind a node's door (its last
  // files were in that sub-diagram) it cannot say it itself, so the node says it for it.
  const sum = run?.segs[run.segs.length - 1];
  const lastWrite = run ? [...run.segs].reverse().find((s) => s.kind === "write" && s.path) : undefined;
  const sumNode = run && sum?.note && t >= sum.start && lastWrite && !stateAt(run, t, ctx).present ? ctx.locate(lastWrite.path!)?.place : undefined;
  const nodes0 = [...counts].flatMap(([id, n]) => {
    const el = view.map.get(id);
    return el && !el.isDeleted ? [{ id, n, box: nodeBox(el, view.map, view.elements) }] : [];
  });
  const v0 = viewport.get(view.id);
  // where the badge goes: in the clear above the node — off connector labels and other nodes, below the toolbar and the bar; none: the bar says it
  const badge = (() => {
    if (!sumNode || !sum?.note || !v0) return null;
    const el = view.map.get(sumNode);
    if (!el || el.isDeleted) return null;
    const node = nodeBox(el, view.map, view.elements);
    const ex = excalidrawEl();
    const top = ex ? occupiedOf(ex).top : 0;
    const size = { w: Math.min(420, 28 + 13 * sum.note.length) / v0.zoom, h: 26 / v0.zoom };
    const obstacles: Box[] = view.elements
      .filter((e) => !e.isDeleted && e.id !== sumNode && (e.type === "text" || e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond"))
      .map((e) => ({ x: e.x, y: e.y, w: e.width, h: e.height }));
    // the +N badges sit on the nodes' top right corners
    for (const d of nodes0) obstacles.push({ x: d.box.x + d.box.w - 34 / v0.zoom, y: d.box.y - 12 / v0.zoom, w: 40 / v0.zoom, h: 24 / v0.zoom });
    const at = placeBadge({ node, size, obstacles, view: { x: -v0.scrollX, y: -v0.scrollY + top / v0.zoom, w: v0.width / v0.zoom, h: v0.height / v0.zoom - top / v0.zoom } });
    return at ? { ...at, id: sumNode } : null;
  })();
  const barNote = sumNode && sum?.note && !badge ? sum.note : null;
  useEffect(() => void replays.setBarNote(barNote), [barNote]);
  useEffect(() => () => replays.setBarNote(null), []);
  const nodes = [...counts].flatMap(([id, n]) => {
    const el = view.map.get(id);
    return el && !el.isDeleted ? [{ id, n, box: nodeBox(el, view.map, view.elements) }] : [];
  });
  const world = useRef<SVGGElement>(null);
  const marks = useRef(new Map<string, HTMLElement>());
  const boxes = useRef(new Map<string, Box>());
  /** The badge's spot (world). */
  const badgeAt = useRef<{ x: number; y: number } | null>(null);
  badgeAt.current = badge;
  const drawn = useRef({ key: "", gen: 0 });
  boxes.current = new Map(nodes.map((d) => [d.id, d.box]));
  drawn.current.gen++;
  /** A node's badge: its top right corner, straddling the top edge. */
  const place = (id: string, el: HTMLElement, sumMark = false) => {
    const v = viewport.get(view.id);
    const b = boxes.current.get(id);
    if (!v) return;
    if (sumMark) {
      const s = badgeAt.current;
      if (s) el.style.transform = `translate3d(${((s.x + v.scrollX) * v.zoom).toFixed(2)}px, ${((s.y + v.scrollY) * v.zoom).toFixed(2)}px, 0)`;
    } else if (b) el.style.transform = `translate3d(${((b.x + b.w + v.scrollX) * v.zoom).toFixed(2)}px, ${((b.y + v.scrollY) * v.zoom).toFixed(2)}px, 0)`;
  };
  const sync = useRef(() => {});
  sync.current = () => {
    const v = viewport.get(view.id);
    if (!v) return;
    const key = `${v.scrollX}|${v.scrollY}|${v.zoom}|${drawn.current.gen}`;
    if (key === drawn.current.key) return;
    drawn.current.key = key;
    world.current?.setAttribute("transform", `matrix(${v.zoom} 0 0 ${v.zoom} ${v.scrollX * v.zoom} ${v.scrollY * v.zoom})`);
    for (const [id, el] of marks.current) place(id.startsWith("sum:") ? id.slice(4) : id, el, id.startsWith("sum:"));
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
      {badge && sumNode && nodes.some((d) => d.id === sumNode) && (
        <span
          key="sum"
          className="ws-pr-n ws-pr-sum"
          ref={(el) => {
            if (el) (marks.current.set(`sum:${sumNode}`, el), place(sumNode, el, true));
            else marks.current.delete(`sum:${sumNode}`);
          }}
        >
          {sum!.note}
        </span>
      )}
    </div>
  );
}
