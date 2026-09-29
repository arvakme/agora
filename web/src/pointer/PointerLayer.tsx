// The node action bar over a canvas (代码路径 / 子图), and the words other panes use for sessions
// and conflicts. The progress pointer that used to live here is replaced by the 工位视图 figures
// (web/docs/workstation.md): the figure is the pointer.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useMemo, useState, useSyncExternalStore } from "react";
import { threadStores } from "../comments/threads";
import { layoutPins } from "../comments/pinLayout";
import type { CanvasViewState } from "../canvas/CanvasView";
import { obstacles, type Box } from "../canvas/clearance";
import { NodeBar } from "../canvas/NodeBar";
import type { NodePop } from "../canvas/nodeBarLayout";
import { notOwn } from "../canvas/chrome";
import { useAgentName, useAgents } from "../session/agents";
import { effectiveLinks } from "../nested/graph";
import { useNested } from "../nested/store";
import type { Conflict } from "../multi/pointers";
import { useSessionFolds, useSessionNames } from "../multi/writes";
import { place } from "./codeLinks";
import { useFollowedSession } from "./follow";
import "./pointer.css";

const base = (p: string) => p.split("/").pop() || p;
const NONE: never[] = [];
const noSub = () => () => {};

/** How a session is called on the canvas: the agent, or the session's name when two of one agent are active. */
export function useSessionLabel() {
  const ag = useAgents();
  const names = useSessionNames();
  const nameOf = useAgentName();
  return (sid: string, among: string[] = []) => {
    const kind = ag.bindings[sid]?.agent;
    const agent = nameOf(kind);
    const twins = among.filter((x) => ag.bindings[x]?.agent === kind).length > 1;
    return twins ? names[sid] || agent : agent;
  };
}

export function PointerLayer({ api, view, chrome = [] }: { api: ExcalidrawImperativeAPI; view: CanvasViewState; chrome?: Box[] }) {
  // The figure IS the pointer (web/docs/workstation.md): the old progress-pointer chips, rings,
  // edge indicators, conflict tags and the 「在架构图之外」 pill are gone — the 工位视图 shows who is
  // where (or a compact presence chip with the view off), and idle agents leave after a minute,
  // so nothing stale stays on the diagram. What remains here is the node action bar.
  const followed = useFollowedSession();
  const folds = useSessionFolds();
  const st = useNested();
  const links = useMemo(() => effectiveLinks(view.id, new Map(st.scenes).set(view.id, view.elements)), [view.id, view.elements, st.scenes]);
  const followedFold = folds.find((f) => f.sessionId === followed);
  const placed = useMemo(() => (followedFold ? place(followedFold.files, links).placed : []), [followedFold, links]);
  // The node action bar's popover (代码路径 / 子图): one popover open at a time across the canvas.
  const [nodeOpen, setNodeOpen] = useState<NodePop | null>(null);
  const free = useMemo(() => notOwn(chrome), [chrome]);
  const a = view.appState;
  const z = a.zoom.value;
  const toScreen = (b: Box): Box => ({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z });
  const tstore = threadStores.get(view.id);
  const threads = useSyncExternalStore(tstore?.subscribe ?? noSub, () => tstore?.get().threads ?? NONE);
  const drawing = useMemo(() => obstacles(view.elements, view.map).map(toScreen), [view.elements, view.map, a.scrollX, a.scrollY, z]);
  const pins = useMemo(() => layoutPins(threads, view).boxes, [threads, view]);
  return (
    <div className="ds">
      <NodeBar api={api} view={view} canvasId={view.id} open={nodeOpen} onOpen={setNodeOpen} hard={[...free, ...pins]} soft={drawing} chrome={free} placed={placed} links={links} />
    </div>
  );
}

/** "Claude Code 与 Codex 在 3 分钟内都改了 server/app.py" */
export function clashText(c: Conflict, label: (sid: string, among?: string[]) => string) {
  const [a, b] = c.sessions.map((s) => label(s, c.sessions));
  const gap = Math.max(1, Math.round((c.writes[1].at - c.writes[0].at) / 60_000));
  return c.kind === "file" ? `${a} 与 ${b} 在 ${gap} 分钟内都改了 ${c.path}` : `${a} 改了 ${base(c.writes[0].path)}，${b} 在 ${gap} 分钟内改了同一节点的 ${base(c.writes[1].path)}`;
}
