import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import { AnimPrompt } from "../anim/AnimPrompt";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { SPRING } from "../comments/motion";
import { replayEval, runEval, TASKS, type EvalProgress, type EvalRow } from "../eval/eval";
import { IconAnim, IconCols, IconComment, IconGrid, IconList, IconPlus, IconPointer, IconReset, IconRows, IconSelect, IconSingle, IconSpark } from "./icons";
import { PERSIST, save } from "../persist";
import { byId, type El } from "../canvas/scene";
import { SessionPane } from "../session/SessionPane";
import { runTurn } from "../session/runTurn";
import { sessions } from "../session/store";
import { canvases, ui } from "../session/ui";
import { createThreadStore, useThreads, type ThreadSnapshot, type ThreadStore } from "../comments/threads";
import { Workspace } from "../workspace/Workspace";
import { activate, addTab, group, groupOf, groups, moveTab, preset, removeTab, type Node, type Preset } from "../workspace/layout";

const params = new URLSearchParams(location.search);
const EVAL_MODE = params.has("eval");
// ?eval&task=t1 runs one task; ?runs=N overrides the 3 runs per task.
const EVAL_ONLY = params.get("task")?.split(",").map((t) => TASKS[Number(t.replace(/\D/g, "")) - 1]?.id).filter(Boolean);
const EVAL_RUNS = Number(params.get("runs")) || 3;

/** A pane in the workspace: a canvas, or a session (chat room) linked to a canvas. */
export type Doc = { id: string; kind: "canvas"; title: string } | { id: string; kind: "session"; sessionId: string };
export type WorkspaceState = { docs: Doc[]; root: Node; focused: string; seq: number };
export type Boot = { workspace?: WorkspaceState; canvases: Record<string, { elements: El[]; threads: ThreadSnapshot }> };

/** First run: a canvas on the left, its Pi Master session docked on the right (design B). */
function defaults(): WorkspaceState {
  const s = sessions.create("c1");
  const docs: Doc[] = [{ id: "c1", kind: "canvas", title: "架构图 1" }, { id: "p1", kind: "session", sessionId: s.id }];
  const g = group(["c1", "p1"]);
  const root = moveTab(g, "p1", g.id, "right");
  return { docs, root: root.kind === "split" ? { ...root, sizes: [0.6, 0.4] } : root, focused: "c1", seq: 1 };
}

export function App({ boot }: { boot: Boot }) {
  const initial = useMemo(() => boot.workspace ?? defaults(), [boot]);
  const [docs, setDocs] = useState<Doc[]>(initial.docs);
  const [root, setRoot] = useState<Node>(initial.root);
  const [focused, setFocused] = useState(initial.focused);
  const seq = useRef(initial.seq);
  const [lastCanvas, setLastCanvas] = useState(() =>
    initial.docs.find((d) => d.id === initial.focused)?.kind === "canvas" ? initial.focused : initial.docs.find((d) => d.kind === "canvas")!.id,
  );
  const [mode, setMode] = useState<"browse" | "comment">("browse");
  const [drawers, setDrawers] = useState<Record<string, boolean>>({});
  const [selCount, setSelCount] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [animOpen, setAnimOpen] = useState(false);
  const [evalProgress, setEvalProgress] = useState<EvalProgress | null>(null);
  const handles = useRef(new Map<string, CanvasHandle>());
  const [, bump] = useState(0);

  // One comment-thread store per canvas, restored from the saved snapshot.
  const stores = useRef(new Map<string, ThreadStore>());
  const scenes = useRef(new Map<string, readonly El[]>(Object.entries(boot.canvases).map(([k, v]) => [k, v.elements])));
  const persistCanvas = (id: string) =>
    PERSIST && save(`canvas:${id}`, () => ({ elements: (scenes.current.get(id) ?? []).filter((e) => !e.isDeleted), threads: stores.current.get(id)?.snapshot() }));
  const storeFor = (id: string) => {
    if (!stores.current.has(id)) {
      const st = createThreadStore(id, boot.canvases[id]?.threads);
      stores.current.set(id, st);
      if (PERSIST) st.subscribe(() => persistCanvas(id));
    }
    return stores.current.get(id)!;
  };

  const canvasDocs = docs.filter((d): d is Extract<Doc, { kind: "canvas" }> => d.kind === "canvas");
  const titleOf = (id: string) => canvasDocs.find((d) => d.id === id)?.title ?? "已关闭的画布";
  const canvasDoc = canvasDocs.find((d) => d.id === lastCanvas) ?? canvasDocs[0];
  const handle = handles.current.get(canvasDoc.id);
  const tabTitle = (d: Doc) => (d.kind === "canvas" ? d.title : `Pi Master · ${titleOf(sessions.get().sessions[d.sessionId]?.canvasId ?? "")}`);

  // Persist the workspace shape; sessions persist themselves on every change.
  useEffect(() => {
    if (PERSIST) save("workspace", () => ({ docs, root, focused, seq: seq.current }));
  }, [docs, root, focused]);
  useEffect(() => (PERSIST ? sessions.subscribe(() => save("sessions", sessions.snapshot)) : undefined), []);
  useEffect(() => {
    for (const d of canvasDocs) {
      const e = canvases.get(d.id);
      if (e) e.title = d.title;
    }
  });

  const onReady = useCallback((id: string, h: CanvasHandle) => {
    handles.current.set(id, h);
    canvases.set(id, { api: h.api, store: h.store, title: "" });
    bump((n) => n + 1);
    // Scripted browser checks: first canvas as before, plus every handle by id.
    // __agora.eval is the eval CLI's entry point (scripts/eval.ts, scripts/eval-replay.ts).
    if (id === "c1")
      Object.assign(window, {
        __agora: {
          api: h.api,
          threads: h.store,
          handles: handles.current,
          sessions,
          eval: {
            run: (opts: { runs?: number; only?: string[] } = {}) =>
              runEval(h.api, h.store, { runs: opts.runs ?? EVAL_RUNS, only: opts.only ?? EVAL_ONLY, onProgress: setEvalProgress, reset: h.reset }),
            replay: (rows: EvalRow[]) => replayEval(h.api, rows, { reset: h.reset }),
          },
        },
      });
  }, []);
  const onSettled = useCallback(() => handles.current.forEach((h) => h.api.refresh()), []);

  const focus = (id: string) => {
    if (id === focused) return;
    setFocused(id);
    if (docs.find((d) => d.id === id)?.kind === "canvas") setLastCanvas(id);
    setMode("browse");
  };
  const addCanvas = (groupId?: string) => {
    const id = `c${++seq.current}`;
    setDocs((ds) => [...ds, { id, kind: "canvas", title: `架构图 ${seq.current}` }]);
    setRoot((r) => addTab(r, groupId ?? groupOf(r, focused)!.id, id));
    setFocused(id);
    setLastCanvas(id);
    setEditing(id); // name it right away
  };
  /** New session for the current canvas, opened in a group other than the canvas's. */
  const addSession = (canvasId = canvasDoc.id, groupId?: string) => {
    const s = sessions.create(canvasId);
    const id = `p${++seq.current}`;
    setDocs((ds) => [...ds, { id, kind: "session", sessionId: s.id }]);
    setRoot((r) => addTab(r, groupId ?? groups(r).find((g) => !g.tabs.includes(canvasId))?.id ?? groupOf(r, focused)!.id, id));
    setFocused(id);
  };
  const rename = (id: string, title: string) => setDocs((ds) => ds.map((d) => (d.id === id && d.kind === "canvas" ? { ...d, title } : d)));
  const close = (id: string) => {
    const doc = docs.find((d) => d.id === id)!;
    if (doc.kind === "canvas" && canvasDocs.length === 1) return; // keep one canvas
    const next = removeTab(root, id);
    if (!next) return;
    setRoot(next);
    setDocs((ds) => ds.filter((d) => d.id !== id));
    handles.current.delete(id);
    canvases.delete(id);
    if (id === focused) setFocused(groups(next)[0].active);
    if (id === lastCanvas) setLastCanvas(canvasDocs.find((d) => d.id !== id)!.id);
  };
  const applyPreset = (p: Preset) => setRoot(preset(docs.map((d) => d.id), p, focused));

  // UI actions sessions can trigger without importing the shell.
  const rootRef = useRef(root);
  rootRef.current = root;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  useEffect(() => {
    ui.focusPane = (id) => {
      const g = groupOf(rootRef.current, id);
      if (!g) return;
      setRoot((r) => activate(r, g.id, id));
      setFocused(id);
      if (docsRef.current.find((d) => d.id === id)?.kind === "canvas") setLastCanvas(id);
    };
    ui.openThread = (canvasId, threadId) => {
      ui.focusPane(canvasId);
      const h = handles.current.get(canvasId);
      const t = h?.store.thread(threadId);
      if (!h || !t) return;
      const a = h.api.getAppState();
      const p = resolveAnchor(t.anchor, byId(h.api.getSceneElementsIncludingDeleted())).point;
      h.api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - p.x, scrollY: a.height / 2 / a.zoom.value - p.y } });
      setTimeout(() => h.store.open(threadId), 120);
    };
    ui.openSession = (sessionId, turnId) => {
      let id = docsRef.current.find((d) => d.kind === "session" && d.sessionId === sessionId)?.id;
      if (!id) {
        const nid = `p${++seq.current}`;
        id = nid;
        const cid = sessions.get().sessions[sessionId]?.canvasId;
        setDocs((ds) => [...ds, { id: nid, kind: "session", sessionId }]);
        setRoot((r) => addTab(r, groups(r).find((g) => !g.tabs.includes(cid))?.id ?? groups(r)[0].id, nid));
      }
      const target = id;
      setTimeout(() => {
        ui.focusPane(target);
        if (turnId) dispatchEvent(new CustomEvent("agora:turn", { detail: turnId }));
      }, 60);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (e.key === "Escape") {
        setMode("browse");
        storeFor(canvasDoc.id).close();
        handles.current.get(canvasDoc.id)?.dismissDraft();
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (docs.find((d) => d.id === focused)?.kind !== "canvas") return;
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        e.stopPropagation();
        setMode((m) => (m === "comment" ? "browse" : "comment"));
      } else if (k === "v") setMode("browse");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // The dock belongs to the canvas it acts on: keep it at that pane's bottom centre, so a
  // session pane below the canvas is never covered.
  const [dockAt, setDockAt] = useState<{ x: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-pane="${canvasDoc.id}"]`);
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      setDockAt((d) => {
        const next = { x: Math.round(r.left + r.width / 2), bottom: Math.round(innerHeight - r.bottom + 14) };
        return d && d.x === next.x && d.bottom === next.bottom ? d : next;
      });
    };
    place();
    // Pane rects glide for ~420ms after layout changes; follow them, then settle.
    let frame = 0;
    const until = performance.now() + 600;
    const loop = () => (place(), performance.now() < until && (frame = requestAnimationFrame(loop)));
    frame = requestAnimationFrame(loop);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    addEventListener("resize", place);
    return () => (cancelAnimationFrame(frame), ro.disconnect(), removeEventListener("resize", place));
  }, [canvasDoc.id, root]);

  const focusedDoc = docs.find((d) => d.id === focused);
  return (
    <MotionConfig reducedMotion="user">
      <div className="app" data-mode={mode}>
        <header className="topbar">
          <span className="brand"><span className="brand-mark" />Agora</span>
          <span className="crumb">工作区 · <b>{focusedDoc ? tabTitle(focusedDoc) : ""}</b> · 共 {canvasDocs.length} 个画布</span>
          <div className="presets" role="group" aria-label="排列">
            {([["single", IconSingle, "单窗"], ["row", IconCols, "左右并排"], ["col", IconRows, "上下并排"], ["grid", IconGrid, "平铺"]] as const).map(([p, Icon, label]) => (
              <button key={p} className="preset" onClick={() => applyPreset(p)} title={label} aria-label={label} disabled={docs.length < 2 && p !== "single"}>
                <Icon size={15} />
              </button>
            ))}
          </div>
          <button className="new-session" onClick={() => addSession()}><IconSpark size={14} /> 新建会话</button>
          <button className="new-canvas" onClick={() => addCanvas()}><IconPlus size={14} /> 新建画布</button>
        </header>

        <Workspace
          root={root}
          setRoot={setRoot}
          titles={Object.fromEntries(docs.map((d) => [d.id, tabTitle(d)]))}
          kinds={Object.fromEntries(docs.map((d) => [d.id, d.kind]))}
          focused={focused}
          onFocus={focus}
          onAdd={addCanvas}
          onAddSession={(g) => addSession(canvasDoc.id, g)}
          onClose={close}
          editing={editing}
          setEditing={(id) => setEditing(id && docs.find((d) => d.id === id)?.kind === "canvas" ? id : null)}
          onRename={rename}
          onSettled={onSettled}
          renderCanvas={(id) => {
            const doc = docs.find((d) => d.id === id)!;
            if (doc.kind === "session") return <SessionPane sessionId={doc.sessionId} canvasTitles={Object.fromEntries(canvasDocs.map((d) => [d.id, d.title]))} />;
            return (
              <CanvasView
                doc={{ id, title: doc.title, store: storeFor(id) }}
                mode={id === focused ? mode : "browse"}
                drawerOpen={!!drawers[id]}
                onDrawer={(open) => setDrawers((d) => ({ ...d, [id]: open }))}
                onReady={(h) => onReady(id, h)}
                onSelection={(n) => id === lastCanvas && setSelCount(n)}
                onModeDone={() => setMode("browse")}
                initialElements={boot.canvases[id]?.elements}
                onScene={(els) => (scenes.current.set(id, els), persistCanvas(id))}
              />
            );
          }}
        />

        <Dock
          at={dockAt}
          title={canvasDoc.title}
          mode={mode}
          setMode={(m) => (ui.focusPane(canvasDoc.id), setMode(m))}
          selCount={selCount}
          drawerOpen={!!drawers[canvasDoc.id]}
          toggleDrawer={() => setDrawers((d) => ({ ...d, [canvasDoc.id]: !d[canvasDoc.id] }))}
          store={storeFor(canvasDoc.id)}
          onCommentSelection={() => handle?.commentSelection()}
          onReset={() => handle?.reset()}
          animOpen={animOpen}
          onAnim={() => setAnimOpen((o) => !o)}
          evalButton={
            EVAL_MODE && handle ? (
              <button
                className="dock-btn eval"
                disabled={!!evalProgress && !evalProgress.done}
                onClick={() => runEval(handle.api, handle.store, { runs: EVAL_RUNS, only: EVAL_ONLY, onProgress: setEvalProgress, reset: handle.reset })}
              >
                {evalProgress && !evalProgress.done ? `评测中 ${evalProgress.index}/${evalProgress.total}` : `运行评测 ${EVAL_ONLY?.length ?? TASKS.length}×${EVAL_RUNS}`}
              </button>
            ) : null
          }
        />
        {mode === "comment" && (
          <motion.div className="mode-hint" style={dockAt ? { left: dockAt.x, bottom: dockAt.bottom + 54 } : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            在「{canvasDoc.title}」上点击一个元素钉评论 · Esc 退出
          </motion.div>
        )}
        {animOpen && (
          <AnimPrompt
            onClose={() => setAnimOpen(false)}
            onScript={(script) => {
              // Offline examples mount directly (no model involved).
              handle?.animate(script);
              setAnimOpen(false);
            }}
            onRequest={(text) => {
              // Generated animations are a turn in this canvas's session, like any other request.
              setAnimOpen(false);
              const c = canvases.get(canvasDoc.id);
              if (!c) return;
              const s = sessions.forCanvas(canvasDoc.id);
              ui.openSession(s.id);
              void runTurn({ api: c.api, sessionId: s.id, canvasId: canvasDoc.id, request: { id: `anim-${Date.now()}`, origin: "chat", messages: [{ author: "user", text }], anchorIds: [] }, origin: { kind: "chat" }, text });
            }}
          />
        )}
        {evalProgress && <pre className="eval-log">{evalProgress.log.slice(-14).join("\n")}</pre>}
      </div>
    </MotionConfig>
  );
}

function Dock({ at, title, mode, setMode, selCount, drawerOpen, toggleDrawer, store, onCommentSelection, onReset, animOpen, onAnim, evalButton }: {
  at: { x: number; bottom: number } | null;
  title: string;
  mode: "browse" | "comment";
  setMode: (m: "browse" | "comment") => void;
  selCount: number;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  store: ThreadStore;
  onCommentSelection: () => void;
  onReset: () => void;
  animOpen: boolean;
  onAnim: () => void;
  evalButton: React.ReactNode;
}) {
  const { threads } = useThreads(store);
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <div className="dock" role="toolbar" aria-label="评论工具" style={at ? { left: at.x, bottom: at.bottom } : undefined}>
      <span className="dock-title">{title}</span>
      <div className="dock-tools">
        {([["browse", IconPointer, "浏览 · V"], ["comment", IconComment, "评论 · C"]] as const).map(([m, Icon, label]) => (
          <button key={m} className="dock-btn icon" data-on={mode === m} onClick={() => setMode(m)} aria-label={label} title={label}>
            {mode === m && <motion.span layoutId="dock-on" className="dock-on" transition={SPRING} />}
            <Icon size={17} />
          </button>
        ))}
        <button className="dock-btn icon" disabled={!selCount} onClick={onCommentSelection} aria-label="评论选区" title={selCount ? `评论选中的 ${selCount} 个元素` : "先选中元素"}>
          <IconSelect size={17} />
          {selCount > 1 && <em className="dock-badge">{selCount}</em>}
        </button>
        <button className="dock-btn icon" data-on={drawerOpen} onClick={toggleDrawer} aria-label={`所有评论 · ${open} 条进行中`} title="所有评论">
          {drawerOpen && <motion.span layoutId="dock-drawer" className="dock-on" transition={SPRING} />}
          <IconList size={17} />
          {open > 0 && <em className="dock-badge">{open}</em>}
        </button>
        <button className="dock-btn icon" data-on={animOpen} onClick={onAnim} aria-label="算法动画" title="算法动画 · 用动画演示…">
          {animOpen && <motion.span layoutId="dock-anim" className="dock-on" transition={SPRING} />}
          <IconAnim size={17} />
        </button>
        <span className="dock-sep" />
        <button className="dock-btn icon" onClick={onReset} aria-label="重置本画布" title="重置本画布"><IconReset size={16} /></button>
      </div>
      {evalButton}
    </div>
  );
}
