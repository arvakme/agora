// Nested canvases on a canvas (docs/nested-canvas.md): the "can be entered" marker at the
// bottom-right of every node that opens a child canvas (with the child's open comments and a
// "may be out of date" mark), the breadcrumb above a child canvas, and the node menu that makes,
// expands (by the session's agent), enters or unlinks a child.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IconEnter, IconHint, IconNested, IconSparkles } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { bbox, codePathsOf, isShape, labelOf, live, type El } from "../canvas/scene";
import { clipPath } from "../canvas/chrome";
import type { Box } from "../canvas/clearance";
import { threadStores } from "../comments/threads";
import { useSessionFolds } from "../multi/writes";
import { agents } from "../session/agents";
import { sessions } from "../session/store";
import { ui } from "../session/ui";
import { pointerFollow } from "../pointer/follow";
import { ancestry, childOf, descendants, openThreads, staleness, type Staleness } from "./graph";
import { nav, nested, useNested } from "./store";
import { writeChildLink } from "./writeChild";
import "./nested.css";

const noSub = () => () => {};

/** Open comments in a canvas and everything below it (owner page: the live thread stores). */
function useOpenBelow(ids: string[]): Record<string, number> {
  const key = ids.join(",");
  const sub = useMemo(() => (l: () => void) => {
    const offs = [...threadStores.entries()].map(([, s]) => s.subscribe(l));
    return () => offs.forEach((f) => f());
  }, [key, threadStores.size]);
  const snap = () => ids.map((id) => openThreads(threadStores.get(id)?.get().threads ?? [])).join(",");
  const joined = useSyncExternalStore(ids.length ? sub : noSub, snap);
  return Object.fromEntries(joined.split(",").map((n, i) => [ids[i], Number(n) || 0]));
}

export type ChildInfo = { title: string; open: number; stale?: Staleness };

/** Marker per node with a child canvas; `info` says which children exist (owner page or share guest). */
export function ChildMarkers({ view, canvasId, info, onEnter, chrome = [] }: { view: CanvasViewState; canvasId: string; info: (child: string) => ChildInfo | null; onEnter: (child: string) => void; chrome?: Box[] }) {
  const a = view.appState;
  const z = a.zoom.value;
  const nodes = view.elements.filter((e) => live(e) && childOf(e) && (isShape(e) || e.type === "frame") && childOf(e) !== canvasId);
  const clip = useMemo(() => clipPath({ x: 0, y: 0, w: a.width, h: a.height }, chrome), [a.width, a.height, chrome]);
  return (
    <div className="nest-layer" style={{ clipPath: clip }}>
      {nodes.map((e) => {
        const child = childOf(e)!;
        const i = info(child);
        if (!i) return null;
        const b = bbox(e);
        const x = (b.x + b.width + a.scrollX) * z;
        const y = (b.y + b.height + a.scrollY) * z;
        const stale = !!i.stale?.files.length;
        return (
          <button
            key={e.id}
            className="nest-mark"
            data-stale={stale || undefined}
            style={{ transform: `translate(${Math.round(x - 14)}px, ${Math.round(y - 13)}px)` }}
            onClick={() => onEnter(child)}
            onDoubleClick={(ev) => ev.stopPropagation()}
            title={`进入子图「${i.title}」${i.open ? ` · ${i.open} 条未解决评论` : ""}${stale ? ` · 可能过时：${i.stale!.files.length} 次改动发生在子图画好之后` : ""}（也可以双击节点）`}
            aria-label={`进入子图 ${i.title}`}
          >
            <IconEnter size={14} />
            {i.open > 0 && <em>{i.open}</em>}
            {stale && <span className="nest-dot" aria-label="可能过时" />}
          </button>
        );
      })}
    </div>
  );
}

/** The owner page's markers: children that exist in this workspace, their open comments, staleness. */
export function OwnerChildMarkers({ view, canvasId, chrome }: { view: CanvasViewState; canvasId: string; chrome?: Box[] }) {
  const st = useNested();
  const folds = useSessionFolds();
  const writes = useMemo(() => folds.flatMap((f) => f.files), [folds]);
  const kids = useMemo(() => [...new Set(view.elements.map((e) => (live(e) ? childOf(e) : null)).filter((c): c is string => !!c && st.scenes.has(c)))], [view.elements, st.scenes]);
  const below = useMemo(() => Object.fromEntries(kids.map((k) => [k, [k, ...descendants(k, st.scenes)]])), [kids, st.scenes]);
  const counts = useOpenBelow([...new Set(Object.values(below).flat())]);
  const stale = useMemo(() => {
    const out: Record<string, Staleness> = {};
    for (const e of view.elements) {
      const k = live(e) ? childOf(e) : null;
      if (k && st.scenes.has(k)) out[k] = staleness(k, st.scenes, writes, codePathsOf(e), st.reviewed[k] ?? 0);
    }
    return out;
  }, [view.elements, st.scenes, st.reviewed, writes]);
  return (
    <ChildMarkers
      view={view}
      canvasId={canvasId}
      chrome={chrome}
      info={(k) => (st.scenes.has(k) ? { title: st.titles[k] ?? k, open: (below[k] ?? [k]).reduce((n, id) => n + (counts[id] ?? 0), 0), stale: stale[k] } : null)}
      onEnter={(k) => nav.go(canvasId, k)}
    />
  );
}

/** The canvas's place in its tree: 总架构 › 后端 › 订单模块. Shown only on a child canvas. */
export function Breadcrumb({ path, current, onGo, extra }: { path: { id: string; title: string }[]; current: string; onGo: (id: string) => void; extra?: React.ReactNode }) {
  if (path.length < 2) return null;
  return (
    <nav className="nest-crumbs" aria-label="画布层级">
      <IconNested size={14} />
      <ol>
        {path.map((p, i) => (
          <li key={p.id}>
            {i > 0 && <span className="nest-sep" aria-hidden>›</span>}
            {p.id === current ? (
              <b aria-current="page">{p.title || "未命名画布"}</b>
            ) : (
              <button onClick={() => onGo(p.id)} title={`回到「${p.title}」`}>
                {p.title || "未命名画布"}
              </button>
            )}
          </li>
        ))}
      </ol>
      {extra}
    </nav>
  );
}

/** The owner page's breadcrumb, with the "may be out of date" notice of this child canvas. */
export function OwnerBreadcrumb({ canvasId }: { canvasId: string }) {
  const st = useNested();
  const folds = useSessionFolds();
  const chain = ancestry(canvasId, st.index);
  const parent = st.index.get(canvasId);
  const parentEl = parent ? st.scenes.get(parent.canvasId)?.find((e) => e.id === parent.elementId) : undefined;
  const stale = useMemo(
    () => (parent ? staleness(canvasId, st.scenes, folds.flatMap((f) => f.files), codePathsOf(parentEl), st.reviewed[canvasId] ?? 0) : null),
    [canvasId, st.scenes, st.reviewed, folds, parentEl],
  );
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [canvasId]);
  const files = [...new Set(stale?.files.map((f) => f.path) ?? [])];
  return (
    <Breadcrumb
      path={chain.map((id) => ({ id, title: st.titles[id] ?? id }))}
      current={canvasId}
      onGo={(id) => nav.go(canvasId, id)}
      extra={
        files.length > 0 && (
          <span className="nest-stale" role="status">
            <span className="nest-dot" aria-hidden />
            <span title={files.join("\n")}>可能过时：子图画好之后改过 {files.length} 个文件</span>
            <button
              className="nest-act"
              disabled={sent}
              onClick={() => {
                setSent(true);
                void askAgent(canvasId, updatePrompt(canvasId, st.titles[canvasId] ?? canvasId, files));
              }}
            >
              <IconSparkles size={14} />
              {sent ? "已交给 Agent" : "让 AI 更新"}
            </button>
            <button className="nest-act quiet" onClick={() => nav.review(canvasId, Date.now())} title="子图和代码仍然一致：清掉这个标记">
              已核对
            </button>
          </span>
        )
      }
    />
  );
}

/** The session that acts for a canvas tree: the followed one, else the tree's most recent, else ask. */
export async function sessionFor(canvasId: string): Promise<string | undefined> {
  const st = nested.get();
  const root = ancestry(canvasId, st.index)[0];
  const family = new Set([root, ...descendants(root, st.scenes)]);
  const f = pointerFollow.get();
  if (f && agents.get().bindings[f] && family.has(sessions.get().sessions[f]?.canvasId ?? "")) return f;
  const mine = Object.values(sessions.get().sessions).filter((s) => family.has(s.canvasId)).map((s) => s.id);
  return agents.forCanvas(mine) ?? (f && agents.get().bindings[f] ? f : undefined) ?? (await ui.chooseAgent(root));
}

async function askAgent(canvasId: string, text: string) {
  const sid = await sessionFor(canvasId);
  if (!sid) return;
  ui.openSession(sid);
  await agents.send(sid, text, { canvasId });
}

const expandPrompt = (canvasId: string, el: El, label: string) => {
  const paths = codePathsOf(el);
  return [
    `把节点「${label}」展开成子图，画出它内部更细一层的结构。`,
    `1. \`agora canvas child create --parent ${canvasId} --node ${el.id}\` 建子画布（已有就沿用它返回的那一块）。`,
    `2. 读它代表的代码：${paths.length ? paths.join("、") : "这个节点还没有关联代码路径，按节点名在仓库里找对应的代码"}。`,
    "3. 在子画布里（`--canvas <子画布 id>`）画出内部的模块和它们之间的调用；能对应到代码的节点用 `agora canvas link` 关联更细的路径。再往下一层可以是代码逻辑或调用流程。",
    "命令直接写 `agora canvas …`（agora 在 PATH 上）。最后用一两句话说明子图里画了什么。",
  ].join("\n");
};
const updatePrompt = (canvasId: string, title: string, files: string[]) =>
  [
    files.length
      ? `子图「${title}」（canvas=${canvasId}）可能过时：它画好之后，这些文件改过：${files.slice(0, 12).join("、")}${files.length > 12 ? " …" : ""}。`
      : `对照现在的代码检查子图「${title}」（canvas=${canvasId}）是否还准确。`,
    `读 \`agora canvas read --canvas ${canvasId}\` 和这些代码，只更新变了的部分（节点、连线、代码路径），然后说明改了什么。`,
  ].join("\n");

/** Selected node → 「子图」 menu: make a blank child, let the agent expand it, enter it, or unlink it. */
export function NodeChildMenu({ api, view, canvasId }: { api: ExcalidrawImperativeAPI; view: CanvasViewState; canvasId: string }) {
  const st = useNested();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = Object.keys(view.appState.selectedElementIds ?? {}).map((id) => {
    const e = view.map.get(id);
    return e?.type === "text" && e.containerId ? e.containerId : id;
  });
  const uniq = [...new Set(ids)].filter((id) => {
    const e = view.map.get(id);
    return live(e) && (isShape(e) || e.type === "frame");
  });
  const target = uniq.length === 1 ? view.map.get(uniq[0]) : undefined;
  useEffect(() => setOpen(false), [target?.id]);
  useEffect(() => setBusy(null), [target?.id]);
  if (!target) return null;
  const a = view.appState;
  const z = a.zoom.value;
  const b = bbox(target);
  const label = labelOf(target, view.map).replace(/\s+/g, " ").trim() || "未命名节点";
  const firstLine = labelOf(target, view.map).split("\n").map((l) => l.trim()).find(Boolean) ?? label;
  const child = childOf(target);
  const has = !!child && st.scenes.has(child);
  const act = async (what: string, f: () => Promise<void> | void) => {
    setBusy(what);
    setOpen(false);
    await f();
  };
  const left = Math.round((b.x + b.width + a.scrollX) * z + 8);
  const flip = left + 260 > a.width; // near the pane's right edge the menu opens leftwards
  return (
    <div className="nest-menu ptr-ui" style={{ left, top: Math.round((b.y + a.scrollY) * z + 34) }}>
      <button className="ptr-pill" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} title={has ? `这个节点打开子图「${st.titles[child!]}」` : "把这个节点展开成一张子画布"}>
        <IconNested size={14} />
        {has ? `子图 · ${st.titles[child!] ?? ""}` : busy === "ai" ? "已交给 Agent" : "子图"}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu nest-pop" data-flip={flip || undefined} role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }} transition={{ duration: 0.16 }}>
            {has ? (
              <>
                <button role="menuitem" onClick={() => void act("enter", () => nav.go(canvasId, child!))}>
                  <IconEnter size={14} />进入子图<kbd>双击</kbd>
                </button>
                {st.scenes.get(child!)?.some((e) => live(e)) ? (
                  <button role="menuitem" onClick={() => void act("ai", () => askAgent(child!, updatePrompt(child!, st.titles[child!] ?? child!, [])))}>
                    <IconSparkles size={14} />让 AI 更新子图
                  </button>
                ) : (
                  <button role="menuitem" onClick={() => void act("ai", () => askAgent(canvasId, expandPrompt(canvasId, target, label)))}>
                    <IconSparkles size={14} />让 AI 画子图
                    <span className="nest-sub">子图还是空的：读代码，画出下一层</span>
                  </button>
                )}
                <button role="menuitem" onClick={() => void act("unlink", () => void writeChildLink(api, target.id, null))} title="节点不再打开它；子画布本身留在「所有画布」里">
                  <IconHint size={14} />断开（子图保留）
                </button>
              </>
            ) : (
              <>
                <button role="menuitem" onClick={() => void act("ai", () => askAgent(canvasId, expandPrompt(canvasId, target, label)))}>
                  <IconSparkles size={14} />让 AI 展开
                  <span className="nest-sub">读{codePathsOf(target).length ? "关联的" : "对应的"}代码，画出下一层</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() =>
                    void act("blank", async () => {
                      const id = await nav.createChild(firstLine.slice(0, 60));
                      if (id) (writeChildLink(api, target.id, id), nav.go(canvasId, id));
                    })
                  }
                >
                  <IconNested size={14} />新建空白子图
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The node (with a child canvas) under a screen point in the stage, for double-click → enter. */
export function childAt(view: CanvasViewState, x: number, y: number): string | null {
  const a = view.appState;
  const sx = x / a.zoom.value - a.scrollX;
  const sy = y / a.zoom.value - a.scrollY;
  for (let i = view.elements.length - 1; i >= 0; i--) {
    const e = view.elements[i];
    const c = live(e) ? childOf(e) : null;
    if (!c) continue;
    const b = bbox(e);
    if (sx >= b.x && sx <= b.x + b.width && sy >= b.y && sy <= b.y + b.height) return c;
  }
  return null;
}
