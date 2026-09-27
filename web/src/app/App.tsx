import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import { AnimPrompt } from "../anim/AnimPrompt";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { SPRING } from "../comments/motion";
import { replayEval, runEval, TASKS, type EvalProgress, type EvalRow } from "../eval/eval";
import { buildFixture } from "../eval/fixture";
import { IconAnim, IconClose, IconCols, IconComment, IconGrid, IconList, IconPlus, IconPointer, IconReset, IconRows, IconSelect, IconSingle } from "./icons";
import { discard, PERSIST, save } from "../persist";
import { byId, type El } from "../canvas/scene";
import { SessionPane } from "../session/SessionPane";
import { runTurn } from "../session/runTurn";
import { sessions, type Session, type Turn } from "../session/store";
import { canvases, ui } from "../session/ui";
import { createThreadStore, useThreads, type ThreadSnapshot, type ThreadStore } from "../comments/threads";
import { AllDocs } from "../workspace/AllDocs";
import { Workspace } from "../workspace/Workspace";
import { activate, group, groupOf, groups, moveTab, preset, type Node, type Preset } from "../workspace/layout";
import {
  closeTab,
  homeGroup,
  isOpen,
  migrateDocs,
  nextTitle,
  openIds,
  openTab,
  placement,
  SAMPLE_CANVAS,
  SESSION,
  sessionDocId,
  titlesOf,
  UNTITLED_CANVAS,
  type CanvasDoc,
  type Doc,
  type SessionDoc,
} from "../workspace/model";

const params = new URLSearchParams(location.search);
const EVAL_MODE = params.has("eval");
// ?eval&task=t1 runs one task; ?runs=N overrides the 3 runs per task.
const EVAL_ONLY = params.get("task")?.split(",").map((t) => TASKS[Number(t.replace(/\D/g, "")) - 1]?.id).filter(Boolean);
const EVAL_RUNS = Number(params.get("runs")) || 3;

export type { Doc } from "../workspace/model";
export type WorkspaceState = { v?: 2; docs: Doc[]; root: Node; focused: string };
export type Boot = { workspace?: WorkspaceState; canvases: Record<string, { elements: El[]; threads: ThreadSnapshot }> };

/** First run: the sample canvas on the left, its session docked on the right. Later canvases start blank. */
function defaults(): WorkspaceState {
  const s = sessions.create("c1");
  const p = sessionDocId(s.id);
  const docs: Doc[] = [{ id: "c1", kind: "canvas", title: SAMPLE_CANVAS }, { id: p, kind: "session", sessionId: s.id, title: nextTitle([], SESSION) }];
  const g = group(["c1", p]);
  const root = moveTab(g, p, g.id, "right");
  return { v: 2, docs, root: root.kind === "split" ? { ...root, sizes: [0.6, 0.4] } : root, focused: "c1" };
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
/** What one delete removed, kept in memory for a single undo. */
type Removed =
  | { kind: "canvas"; doc: CanvasDoc; index: number; at: { groupId: string; index: number } | null; elements: readonly El[]; store?: ThreadStore }
  | { kind: "session"; doc: SessionDoc; index: number; at: { groupId: string; index: number } | null; session?: Session; turns: Turn[] };

export function App({ boot }: { boot: Boot }) {
  const firstRun = !boot.workspace;
  const initial = useMemo(() => boot.workspace ?? defaults(), [boot]);
  const [docs, setDocs] = useState<Doc[]>(() => {
    const ds = migrateDocs(initial.docs);
    // Older builds never saved the first-run session; recreate a lost record so its tab still works.
    const firstCanvas = ds.find((d) => d.kind === "canvas")!.id;
    for (const d of ds) if (d.kind === "session" && !sessions.get().sessions[d.sessionId]) sessions.create(firstCanvas, d.sessionId);
    return ds;
  });
  const [root, setRoot] = useState<Node>(initial.root);
  const [focused, setFocused] = useState(initial.focused);
  const [lastCanvas, setLastCanvas] = useState(() =>
    initial.docs.find((d) => d.id === initial.focused)?.kind === "canvas" ? initial.focused : initial.docs.find((d) => d.kind === "canvas")!.id,
  );
  const [mode, setMode] = useState<"browse" | "comment">("browse");
  const [drawers, setDrawers] = useState<Record<string, boolean>>({});
  const [selCount, setSelCount] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [animOpen, setAnimOpen] = useState(false);
  const [listOpen, setListOpen] = useState<{ confirm?: string } | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [evalProgress, setEvalProgress] = useState<EvalProgress | null>(null);
  const handles = useRef(new Map<string, CanvasHandle>());
  const [, bump] = useState(0);

  // One comment-thread store per canvas, restored from the saved snapshot.
  const stores = useRef(new Map<string, ThreadStore>());
  // Latest scene per canvas, open or closed: a reopened canvas mounts from here.
  const scenes = useRef(
    new Map<string, readonly El[]>([...Object.entries(boot.canvases).map(([k, v]) => [k, v.elements] as const), ...(firstRun ? [["c1", buildFixture()] as const] : [])]),
  );
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

  const canvasDocs = docs.filter((d): d is CanvasDoc => d.kind === "canvas");
  const docOf = (id: string) => docs.find((d) => d.id === id);
  const kindOf = (id: string) => docOf(id)?.kind;
  const titleOf = (id: string) => canvasDocs.find((d) => d.id === id)?.title;
  const open = new Set(openIds(root));
  // The canvas the dock and keyboard act on: the most recent one on screen (the current tab of
  // some group). With no canvas on screen there is no dock.
  const shown = new Set(groups(root).map((g) => g.active));
  const canvasDoc = canvasDocs.find((d) => d.id === lastCanvas && shown.has(d.id)) ?? canvasDocs.find((d) => shown.has(d.id));
  const handle = canvasDoc && handles.current.get(canvasDoc.id);
  const sessionCanvas = (d: SessionDoc) => sessions.get().sessions[d.sessionId]?.canvasId ?? "";

  // Persist the workspace shape; sessions persist themselves on every change.
  useEffect(() => {
    if (PERSIST) save("workspace", () => ({ v: 2, docs, root, focused }));
  }, [docs, root, focused]);
  useEffect(() => {
    if (!PERSIST) return;
    save("sessions", sessions.snapshot); // the first-run session is created before this subscription
    return sessions.subscribe(() => save("sessions", sessions.snapshot));
  }, []);
  useEffect(() => {
    if (firstRun) persistCanvas("c1");
  }, []);
  // Every session exists as a doc, including ones created elsewhere (a comment handed to the agent).
  useEffect(() => {
    const sync = () =>
      setDocs((ds) => {
        const missing = Object.values(sessions.get().sessions).filter((s) => !ds.some((d) => d.kind === "session" && d.sessionId === s.id));
        if (!missing.length) return ds;
        const next = [...ds];
        for (const s of missing) next.push({ id: sessionDocId(s.id), kind: "session", sessionId: s.id, title: nextTitle(titlesOf(next, "session"), SESSION) });
        return next;
      });
    sync();
    return sessions.subscribe(sync);
  }, []);
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

  // Refs for callbacks that outlive a render (ui actions, timers).
  const rootRef = useRef(root);
  rootRef.current = root;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const lastCanvasRef = useRef(lastCanvas);
  lastCanvasRef.current = lastCanvas;

  const focus = (id: string) => {
    if (id === focused) return;
    setFocused(id);
    if (kindOf(id) === "canvas") setLastCanvas(id);
    setMode("browse");
  };

  /** Open (or bring forward) a doc's tab. Without a group it goes to its home group (docs/workspace-model.md §4). */
  const openDoc = (id: string, opts: { groupId?: string; focus?: boolean; kind?: Doc["kind"]; linkedCanvas?: string; keepVisible?: string } = {}) => {
    const kind = opts.kind ?? docsRef.current.find((d) => d.id === id)?.kind ?? "canvas";
    setRoot((r) => {
      if (isOpen(r, id) || opts.groupId) return openTab(r, id, opts.groupId);
      const home = homeGroup(r, kind, {
        kindOf: (t) => docsRef.current.find((d) => d.id === t)?.kind,
        recentCanvas: lastCanvasRef.current,
        linkedCanvas: opts.linkedCanvas,
        focused: focusedRef.current,
      });
      const next = openTab(r, id, home.groupId);
      // Opening in the background must not cover the tab the user is on: split beside it instead.
      if (opts.keepVisible && groupOf(r, opts.keepVisible)?.id === home.groupId) {
        let beside = moveTab(next, id, home.groupId, "left");
        beside = activate(beside, groupOf(beside, opts.keepVisible)!.id, opts.keepVisible);
        return beside.kind === "split" && beside.children.length === 2 ? { ...beside, sizes: [0.6, 0.4] } : beside;
      }
      if (!home.split) return next;
      const split = moveTab(next, id, home.groupId, "right");
      return split.kind === "split" && split.children.length === 2 ? { ...split, sizes: [0.6, 0.4] } : split;
    });
    if (opts.focus !== false) {
      setFocused(id);
      if (kind === "canvas") setLastCanvas(id);
      setMode("browse");
    }
  };

  const addCanvas = (opts: { groupId?: string; sample?: boolean } = {}) => {
    const id = uid("c");
    const title = opts.sample ? nextTitle(titlesOf(docs, "canvas"), SAMPLE_CANVAS, true) : nextTitle(titlesOf(docs, "canvas"), UNTITLED_CANVAS);
    scenes.current.set(id, opts.sample ? buildFixture() : []);
    persistCanvas(id);
    setDocs((ds) => [...ds, { id, kind: "canvas", title }]);
    openDoc(id, { groupId: opts.groupId, kind: "canvas" });
    setEditing(id); // name it right away
  };
  /** New session linked to a canvas (default: the one in use), beside that canvas unless a group is named. */
  const addSession = (opts: { groupId?: string; canvasId?: string } = {}) => {
    const canvasId = opts.canvasId ?? canvasDoc?.id ?? lastCanvas;
    const s = sessions.create(canvasId); // the sync effect adds its doc
    openDoc(sessionDocId(s.id), { groupId: opts.groupId, kind: "session", linkedCanvas: canvasId });
  };
  const onNew = (groupId: string | undefined, what: "canvas" | "session" | "sample") =>
    what === "session" ? addSession({ groupId }) : addCanvas({ groupId, sample: what === "sample" });

  const rename = (id: string, title: string) => setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, title } : d)));

  /** Close = take the tab away. The canvas or session stays in the workspace (and in 所有画布). */
  const close = (id: string) => {
    const next = closeTab(root, id);
    setRoot(next);
    if (kindOf(id) === "canvas") {
      handles.current.delete(id);
      canvases.delete(id);
    }
    if (id === focused) {
      const g = groups(next).find((g) => g.tabs.length) ?? groups(next)[0];
      const was = groupOf(root, id);
      const sibling = was && groups(next).find((n) => n.id === was.id);
      setFocused((sibling ?? g).active ?? "");
    }
    if (editing === id) setEditing(null);
  };

  /** Delete = gone from the workspace, with one undo. Confirmation happens in the 所有画布 list. */
  const remove = (id: string) => {
    const doc = docOf(id);
    if (!doc) return;
    if (doc.kind === "canvas" && canvasDocs.length === 1) return; // keep one canvas
    const at = placement(root, id);
    const index = docs.indexOf(doc);
    if (at) close(id);
    setDocs((ds) => ds.filter((d) => d.id !== id));
    if (doc.kind === "canvas") {
      setRemoved({ kind: "canvas", doc, index, at, elements: scenes.current.get(id) ?? [], store: stores.current.get(id) });
      scenes.current.delete(id);
      stores.current.delete(id);
      if (PERSIST) void discard(`canvas:${id}`);
      if (lastCanvas === id) setLastCanvas(canvasDocs.find((d) => d.id !== id)!.id);
    } else {
      const st = sessions.get();
      const session = st.sessions[doc.sessionId];
      const turns = (session?.turnIds ?? []).map((t) => st.turns[t]).filter(Boolean);
      setRemoved({ kind: "session", doc, index, at, session, turns });
      const { [doc.sessionId]: _, ...rest } = st.sessions;
      const keptTurns = Object.fromEntries(Object.entries(st.turns).filter(([, t]) => t.sessionId !== doc.sessionId));
      sessions.hydrate({ ...st, sessions: rest, turns: keptTurns });
    }
  };
  const undoRemove = () => {
    const r = removed;
    if (!r) return;
    setRemoved(null);
    setDocs((ds) => {
      const next = ds.filter((d) => d.id !== r.doc.id);
      next.splice(Math.min(r.index, next.length), 0, r.doc);
      return next;
    });
    if (r.kind === "canvas") {
      scenes.current.set(r.doc.id, r.elements);
      if (r.store) stores.current.set(r.doc.id, r.store);
      persistCanvas(r.doc.id);
    } else if (r.session) {
      const st = sessions.get();
      sessions.hydrate({ ...st, sessions: { ...st.sessions, [r.session.id]: r.session }, turns: { ...st.turns, ...Object.fromEntries(r.turns.map((t) => [t.id, t])) } });
    }
    if (r.at) {
      const at = r.at;
      setRoot((root) => openTab(root, r.doc.id, at.groupId, at.index));
      setFocused(r.doc.id);
    }
  };
  // The undo offer lasts a while, then the delete is final.
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), 12000);
    return () => clearTimeout(t);
  }, [removed]);

  const applyPreset = (p: Preset) => {
    const ids = openIds(root);
    if (ids.length) setRoot(preset(ids, p, focused || ids[0]));
  };

  // UI actions sessions can trigger without importing the shell.
  const openRef = useRef(openDoc);
  openRef.current = openDoc;
  useEffect(() => {
    ui.focusPane = (id) => {
      if (!docsRef.current.some((d) => d.id === id)) return;
      openRef.current(id);
    };
    ui.ensureCanvas = async (id) => {
      if (canvases.get(id)) return canvases.get(id);
      if (!docsRef.current.some((d) => d.id === id && d.kind === "canvas")) return undefined;
      openRef.current(id, { focus: false, kind: "canvas", keepVisible: focusedRef.current });
      for (let i = 0; i < 60 && !canvases.get(id); i++) await new Promise((ok) => setTimeout(ok, 50));
      return canvases.get(id);
    };
    ui.openThread = (canvasId, threadId) => {
      void ui.ensureCanvas(canvasId).then(() => {
        ui.focusPane(canvasId);
        const h = handles.current.get(canvasId);
        const t = h?.store.thread(threadId);
        if (!h || !t) return;
        const a = h.api.getAppState();
        const p = resolveAnchor(t.anchor, byId(h.api.getSceneElementsIncludingDeleted())).point;
        h.api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - p.x, scrollY: a.height / 2 / a.zoom.value - p.y } });
        setTimeout(() => h.store.open(threadId), 120);
      });
    };
    ui.openSession = (sessionId, turnId) => {
      const session = sessions.get().sessions[sessionId];
      if (!session) return; // deleted
      const id = sessionDocId(sessionId);
      const existing = docsRef.current.find((d) => d.kind === "session" && d.sessionId === sessionId)?.id ?? id;
      // A doc for a brand-new session is added by the sync effect; open it once it's there.
      setTimeout(() => {
        openRef.current(existing, { kind: "session", linkedCanvas: session.canvasId });
        if (turnId) setTimeout(() => dispatchEvent(new CustomEvent("agora:turn", { detail: turnId })), 60);
      }, 0);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (e.key === "Escape" && canvasDoc) {
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
    const el = canvasDoc && document.querySelector<HTMLElement>(`[data-pane="${canvasDoc.id}"]`);
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
  }, [canvasDoc?.id, root, handle]); // `handle` arrives once the pane has mounted

  const canvasTitles = Object.fromEntries(canvasDocs.map((d) => [d.id, d.title]));
  return (
    <MotionConfig reducedMotion="user">
      <div className="app" data-mode={mode}>
        <header className="topbar">
          <span className="brand"><span className="brand-mark" />Agora</span>
          <div className="all-docs">
            <button className="all-docs-btn" aria-expanded={!!listOpen} onClick={() => setListOpen((o) => (o ? null : {}))}>
              <IconList size={14} />所有画布<em>{canvasDocs.length}</em>
            </button>
            {listOpen && (
              <AllDocs
                docs={docs}
                open={open}
                focused={focused}
                confirm={listOpen.confirm}
                setConfirm={(id) => setListOpen({ confirm: id })}
                canvasOf={sessionCanvas}
                commentCount={(id) => storeFor(id).get().threads.length}
                onOpen={(id) => (openDoc(id), setListOpen(null))}
                onRemove={(id) => (remove(id), setListOpen({}))}
                onNew={(sample) => (addCanvas({ sample }), setListOpen(null))}
                onDismiss={() => setListOpen(null)}
              />
            )}
          </div>
          <span className="topbar-gap" />
          <div className="presets" role="group" aria-label="排列">
            {([["single", IconSingle, "单窗"], ["row", IconCols, "左右并排"], ["col", IconRows, "上下并排"], ["grid", IconGrid, "平铺"]] as const).map(([p, Icon, label]) => (
              <button key={p} className="preset" onClick={() => applyPreset(p)} title={label} aria-label={label} disabled={open.size < 2 && p !== "single"}>
                <Icon size={15} />
              </button>
            ))}
          </div>
          <button className="new-session" onClick={() => addSession()}><IconPlus size={14} /> 新建会话</button>
          <button className="new-canvas" onClick={() => addCanvas()}><IconPlus size={14} /> 新建画布</button>
        </header>

        <Workspace
          root={root}
          setRoot={setRoot}
          titles={Object.fromEntries(docs.map((d) => [d.id, d.title]))}
          subtitles={Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.id, titleOf(sessionCanvas(d)) ?? "画布已删除"]] : [])))}
          kinds={Object.fromEntries(docs.map((d) => [d.id, d.kind]))}
          focused={focused}
          onFocus={focus}
          onNew={onNew}
          onClose={close}
          onDelete={(id) => setListOpen({ confirm: id })}
          editing={editing}
          setEditing={setEditing}
          onRename={rename}
          renderEmpty={(g) => (
            <div className="wm-empty">
              <p>没有打开的画布或会话</p>
              <div>
                <button onClick={() => onNew(g, "canvas")}>新建画布</button>
                <button onClick={() => onNew(g, "session")}>新建会话</button>
                <button onClick={() => setListOpen({})}>所有画布</button>
              </div>
            </div>
          )}
          onSettled={onSettled}
          renderCanvas={(id) => {
            const doc = docs.find((d) => d.id === id);
            if (!doc) return null;
            if (doc.kind === "session") return <SessionPane sessionId={doc.sessionId} canvasTitles={canvasTitles} />;
            return (
              <CanvasView
                doc={{ id, title: doc.title, store: storeFor(id) }}
                mode={id === focused ? mode : "browse"}
                drawerOpen={!!drawers[id]}
                onDrawer={(open) => setDrawers((d) => ({ ...d, [id]: open }))}
                onReady={(h) => onReady(id, h)}
                onSelection={(n) => id === lastCanvas && setSelCount(n)}
                onModeDone={() => setMode("browse")}
                initialElements={scenes.current.get(id) ?? []}
                onScene={(els) => (scenes.current.set(id, els), persistCanvas(id))}
              />
            );
          }}
        />

        {canvasDoc && <>
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
        </>}
        {removed && (
          <motion.div className="undo-toast" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <span>已删除「{removed.doc.title}」</span>
            <button onClick={undoRemove}>撤销</button>
            <button className="undo-toast-x" aria-label="关闭提示" onClick={() => setRemoved(null)}><IconClose size={12} /></button>
          </motion.div>
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
        <button className="dock-btn icon" onClick={onReset} aria-label="清空画布（可撤销）" title="清空画布（⌘Z 可撤销）"><IconReset size={16} /></button>
      </div>
      {evalButton}
    </div>
  );
}
