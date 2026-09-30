// The node action bar: one row of pills beside the selected node — 代码路径 (the globs the node
// stands for, docs/progress-pointer.md) and 子图 (its child canvas, docs/nested-canvas.md) — with
// at most one popover open. The node is what the selection stands for (canvas/nodes.ts: a
// library icon or a group counts as one node). Placement (nodeBar.ts) keeps the bar and its
// popover inside the free part of the pane and off the panels, pointer labels and pins.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconCode, IconNested } from "../app/icons";
import { ChildMenu, useChildPill } from "../nested/NestedLayer";
import { childOf } from "../nested/graph";
import { elementFor, type Link, type Placed } from "../pointer/codeLinks";
import { writeCodePaths } from "../pointer/writeLinks";
import type { CanvasViewState } from "./CanvasView";
import { occluded } from "./chrome";
import { overlaps, type Box } from "./clearance";
import { placeBar, placePop, toggleOpen, type NodePop } from "./nodeBarLayout";
import { nodeBox, selectedNode } from "./nodes";
import { codePathsOf, labelOf, type El } from "./scene";
import "./nodeBar.css";

type Size = { w: number; h: number };
const GUESS: Record<NodePop, Size> = { code: { w: 336, h: 236 }, child: { w: 236, h: 110 } };

export type NodeBarProps = {
  api: ExcalidrawImperativeAPI;
  view: CanvasViewState;
  canvasId: string;
  open: NodePop | null;
  onOpen: (p: NodePop | null) => void;
  /** Never covered when any other spot exists: the canvas's panels, pointer labels, pins. */
  hard: Box[];
  /** Covered only when nothing else fits: the drawing (screen boxes). */
  soft: Box[];
  /** The canvas's panels alone: a node behind one gets no bar. */
  chrome: Box[];
  /** The followed session's changes and the canvas's links, for the editor's preview line. */
  placed: Placed[];
  links: Link[];
};

export function NodeBar({ api, view, canvasId, open, onOpen, hard, soft, chrome, placed, links }: NodeBarProps) {
  const a = view.appState;
  const z = a.zoom.value;
  // Inside a group being edited, the person picks its shapes one by one: only library icons stay whole.
  const editing = (a as unknown as { editingGroupId?: string | null }).editingGroupId;
  const target = selectedNode(Object.keys(a.selectedElementIds ?? {}), view.map, view.elements, editing ? "icons" : "all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<Size>({ w: 220, h: 28 });
  const [pop, setPop] = useState<Partial<Record<NodePop, Size>>>({});
  useEffect(() => {
    onOpen(null);
    setBusy(null);
  }, [target?.id]);
  useLayoutEffect(() => {
    const m = (el: HTMLElement | null) => el && { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) };
    const b = m(barRef.current);
    if (b && (Math.abs(b.w - bar.w) > 1 || Math.abs(b.h - bar.h) > 1)) setBar(b);
    const p = m(popRef.current);
    const was = open && pop[open];
    if (open && p && (!was || Math.abs(p.w - was.w) > 1 || Math.abs(p.h - was.h) > 1)) setPop((s) => ({ ...s, [open]: p }));
  });
  if (!target) return null;

  const viewBox = { x: 0, y: 0, w: a.width, h: a.height };
  const nb = nodeBox(target, view.map, view.elements);
  const node = { x: (nb.x + a.scrollX) * z, y: (nb.y + a.scrollY) * z, w: nb.w * z, h: nb.h * z };
  if (occluded(node, viewBox, chrome)) return null; // behind a panel or scrolled away
  // The node's own entry marker (bottom-right, NestedLayer ChildMarkers) is off-limits too.
  const marker = childOf(target) ? [{ x: node.x + node.w - 16, y: node.y + node.h - 15, w: 64, h: 28 }] : [];
  const firm = [...hard, ...marker];
  const drawing = soft.filter((b) => !overlaps(b, node, -2));
  const at = placeBar(node, bar.w, bar.h, firm, drawing, viewBox);
  const size = open ? (pop[open] ?? GUESS[open]) : null;
  const popAt = open && size ? placePop(at, node, size.w, size.h, firm, drawing, viewBox) : null;

  const paths = codePathsOf(target);
  const name = labelOf(target, view.map).replace(/\s+/g, " ").trim() || "未命名节点";
  const draft = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const preview =
    open === "code"
      ? (() => {
          const others = links.filter((l) => l.id !== target.id);
          const mine = { id: target.id, label: "", globs: draft };
          return [...new Set(placed.filter((p) => elementFor(p.path, [...others, mine])?.link.id === target.id).map((p) => p.path))];
        })()
      : [];
  const save = (globs: string[]) => {
    writeCodePaths(api, new Map([[target.id, globs]]));
    onOpen(null);
  };

  return (
    <div className="node-bar-layer">
      <div ref={barRef} className="node-bar ptr-ui" style={{ transform: `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)` }} data-side={at.side}>
        <button
          className="ptr-pill"
          aria-expanded={open === "code"}
          onClick={() => {
            if (open !== "code") setText(paths.join("\n"));
            onOpen(toggleOpen(open, "code"));
          }}
          title={paths.length ? paths.join("\n") : "让这个节点代表一部分代码，进度指针就能落在它上面"}
        >
          <IconCode size={14} />
          {paths.length ? `代码路径 · ${paths.length}` : "关联代码路径"}
        </button>
        <ChildPill target={target} busy={busy} open={open === "child"} onClick={() => onOpen(toggleOpen(open, "child"))} />
      </div>
      {/* No exit animation: one popover at a time means the old one is gone the moment another opens. */}
      {open && popAt && (
        <motion.div
          key={open}
          ref={popRef}
          className="node-pop ptr-ui"
          data-kind={open}
          style={{ left: Math.round(popAt.x), top: Math.round(popAt.y) }}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16 }}
        >
          {open === "code" ? (
            <div className="ptr-editor">
              <div className="ptr-pop-head">
                <b>「{name}」代表的代码</b>
                <span>相对项目根目录，一行一个，如 server/** 或 web/src/api/*.ts</span>
              </div>
              <textarea
                autoFocus
                rows={Math.max(3, draft.length + 1)}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onOpen(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(draft);
                }}
                spellCheck={false}
                aria-label="代码路径"
              />
              {draft.length > 0 && <p className="ptr-hint">{preview.length ? `会话改过的 ${preview.length} 个文件会落到这里：${preview.slice(0, 3).join("、")}${preview.length > 3 ? " …" : ""}` : "会话里还没有改过匹配的文件"}</p>}
              <div className="ptr-actions">
                {paths.length > 0 && (
                  <button className="ptr-quiet" onClick={() => save([])}>
                    清除
                  </button>
                )}
                <button className="ptr-quiet" onClick={() => onOpen(null)}>
                  取消
                </button>
                <button className="ptr-primary" onClick={() => save(draft)}>
                  保存
                </button>
              </div>
            </div>
          ) : (
            <ChildMenu api={api} view={view} canvasId={canvasId} target={target} onAct={(what) => (setBusy(what), onOpen(null))} />
          )}
        </motion.div>
      )}
    </div>
  );
}

function ChildPill({ target, busy, open, onClick }: { target: El; busy: string | null; open: boolean; onClick: () => void }) {
  const p = useChildPill(target);
  return (
    <button className="ptr-pill" aria-expanded={open} aria-haspopup="menu" onClick={onClick} title={p.title}>
      <IconNested size={14} />
      {!p.has && busy === "ai" ? "已交给 Agent" : p.text}
    </button>
  );
}
