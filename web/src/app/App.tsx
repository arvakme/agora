import { buildReplay } from "../buildreplay/store";
import { dockBottom, isCompact } from "../canvas/dockPlace";
import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveAnchor } from "../canvas/anchors";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { SPRING } from "../comments/motion";
import { replayEval, runEval, TASKS, type EvalProgress, type EvalRow } from "../eval/eval";
import { buildFixture } from "../eval/fixture";
import { sampleRequests } from "../session/firstDraw";
import { IconClose, IconComment, IconHint, IconList, IconPlus, IconPointer, IconWorkspace } from "./icons";
import { ViewMenu } from "./ViewMenu";
import { ackChange, adoptCanvas, adoptSession, dropCanvas, flushSaves, loadCanvas, onCanvasRefused, PERSIST, project, reloadFromDisk, save, slotFile, type LocalChange } from "../persist";
import { createSaveGate } from "../canvas/saveGate";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { trash, type Restored } from "../workspace/trash";
import { TrashPanel } from "../workspace/TrashPanel";
import { HistoryPanel } from "../workspace/HistoryPanel";
import { byId, type El } from "../canvas/scene";
import { SessionPane } from "../session/SessionPane";
import { sessions, type Session, type Turn } from "../session/store";
import { agentChoice, canvases, ui } from "../session/ui";
import { agents, useAgentName, type Binding } from "../session/agents";
import { SessionMark } from "../session/AgentAvatar";
import { pointerFollow } from "../pointer/follow";
import { createThreadStore, threadStores, useThreads, type ThreadSnapshot, type ThreadStore } from "../comments/threads";
import { AllDocs } from "../workspace/AllDocs";
import { ancestry, childOf, descendants, openThreads, parentIndex } from "../nested/graph";
import { enterOnKey } from "../nested/enter";
import { selectedNode } from "../canvas/nodes";
import { canvasFromUrl, nav, nested, urlFor } from "../nested/store";
import { isEditableTarget, markBackHintSeen, upOnKey } from "../nested/up";
import { threadSessionTitles } from "../comments/sessionTitles";
import { sessionNames } from "../multi/writes";
import { setRunsRoot } from "../workstation/runs/store";
import { AgentTags } from "../session/AgentTagRow";
import { WorkerDefs } from "../workstation/RunAvatar";
import { WaitNotifier } from "../workstation/WaitNotifier";
import { focus as figureFocus } from "../workstation/focus";
import { liveFollow } from "../workstation/replayLive";
import { BENCH, installBench } from "../bench/bench";
import { ShareButton } from "../share/SharePanel";
import { Workspace } from "../workspace/Workspace";
import { activate, groupOf, groups, moveTab, preset, type Node, type Preset } from "../workspace/layout";
import { defaultLayout } from "../workspace/twoColumns";
import {
  canvasTree,
  closeTab,
  firstScreen,
  groupKind,
  placeDoc,
  placeQuiet,
  replaceTab,
  isOpen,
  nextTitle,
  openIds,
  openTab,
  placement,
  placeRestored,
  relinkChild,
  SAMPLE_CANVAS,
  savedWorkspace,
  sessionDocId,
  sessionTitles,
  titlesOf,
  topicOf,
  UNTITLED_CANVAS,
  type CanvasDoc,
  type Doc,
  type NewWhat,
  type SessionDoc,
} from "../workspace/model";

const params = new URLSearchParams(location.search);
/** A canvas opened only for an agent's read or edit is closed again after this long unused, unless the person took it. */
const QUIET_TAB_MS = 8000;
const EVAL_MODE = params.has("eval");
// ?eval&task=t1 runs one task; ?runs=N overrides the 3 runs per task.
const EVAL_ONLY = params.get("task")?.split(",").map((t) => TASKS[Number(t.replace(/\D/g, "")) - 1]?.id).filter(Boolean);
const EVAL_RUNS = Number(params.get("runs")) || 3;

export type { Doc } from "../workspace/model";
import { FIRST_SCENE, type Boot } from "./boot";
export { prepareBoot, type Boot, type WorkspaceState } from "./boot";

let benched = false;
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** Bound agents as a stable string, so the shell re-renders when a binding appears or changes identity, not on every status event. */
const bindingKey = () => Object.entries(agents.get().bindings).map(([id, b]) => `${id}:${b.agent}:${b.nativeId ?? ""}:${b.started ? 1 : 0}`).join(",");
/** What workspace.json records about a session (no conversation content): its canvas and its binding. */
const sessionMeta = (sessionId: string) => {
  const s = sessions.get().sessions[sessionId];
  const b = agents.get().bindings[sessionId];
  if (!s && !b) return undefined;
  return {
    canvasId: s?.canvasId || undefined,
    createdAt: s?.createdAt,
    ...(b ? { agent: b.agent, model: b.model || undefined, effort: b.effort || undefined, nativeId: b.nativeId ?? undefined, started: b.started } : {}),
  };
};
/** The toast after a delete: the item is in the trash (restore = undo, also after a reload), or moving it failed. */
type Removed = { title: string; trashId?: string; error?: string };

export function App({ boot }: { boot: Boot }) {
  // prepareBoot (main.tsx) has settled the workspace; nothing here writes to a store while rendering.
  const firstRun = !!boot.firstRun;
  const initial = boot.workspace!;
  const [docs, setDocs] = useState<Doc[]>(initial.docs);
  // Without a ?canvas= link the saved layout opens on each tree's top, not the child level it was left on (workspace-model.md §7).
  const [screen] = useState(() => {
    const index = parentIndex(new Map(Object.entries(boot.canvases).map(([k, v]) => [k, v.elements] as const)));
    return firstScreen({ root: initial.root, focused: initial.focused, urlCanvas: canvasFromUrl(), topOf: (id) => ancestry(id, index)[0], kindOf: (id) => initial.docs.find((d) => d.id === id)?.kind });
  });
  const [root, setRoot] = useState<Node>(screen.root);
  const [focused, setFocused] = useState(screen.focused);
  const [lastCanvas, setLastCanvas] = useState(() =>
    initial.docs.find((d) => d.id === screen.focused)?.kind === "canvas" ? screen.focused : initial.docs.find((d) => d.kind === "canvas")!.id,
  );
  const [mode, setMode] = useState<"browse" | "comment">("browse");
  const [drawers, setDrawers] = useState<Record<string, boolean>>({});
  const [selCount, setSelCount] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState<{ confirm?: string; at?: { x: number; y: number } } | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [recoveredNote, setRecoveredNote] = useState(boot.recovered);
  const [change, setChange] = useState<LocalChange | null | undefined>(boot.change);
  const [panel, setPanel] = useState<"trash" | "history" | null>(null);
  const [panelFocus, setPanelFocus] = useState<string | undefined>();
  useEffect(() => void trash.refresh(), []);
  const [evalProgress, setEvalProgress] = useState<EvalProgress | null>(null);
  const handles = useRef(new Map<string, CanvasHandle>());
  const [, bump] = useState(0);

  // One comment-thread store per canvas, restored from the saved snapshot.
  const stores = useRef(new Map<string, ThreadStore>());
  // Latest scene per canvas, open or closed: a reopened canvas mounts from here.
  const scenes = useRef(
    new Map<string, readonly El[]>([...Object.entries(boot.canvases).map(([k, v]) => [k, v.elements] as const), ...(firstRun ? [["c1", FIRST_SCENE] as const] : [])]),
  );
  // Nesting reads every canvas's scene, open or not (docs/nested-canvas.md).
  const nestedBooted = useRef(false);
  if (!nestedBooted.current) {
    nestedBooted.current = true;
    setRunsRoot(boot.project?.root ?? "");
    nested.reset(
      scenes.current,
      Object.fromEntries(initial.docs.filter((d) => d.kind === "canvas").map((d) => [d.id, d.title])),
      Object.fromEntries(initial.docs.flatMap((d) => (d.kind === "canvas" && d.reviewedAt ? [[d.id, d.reviewedAt]] : []))),
    );
  }
  // A canvas is saved only after this mount has loaded the server's scene for it (canvas/saveGate.ts).
  const gate = useRef(createSaveGate()).current;
  const [synced, setSynced] = useState(!PERSIST);
  const persistCanvas = (id: string) =>
    PERSIST &&
    save(`canvas:${id}`, () => {
      const p = gate.payload(id, scenes.current.get(id) ?? []);
      return p && { ...p, threads: stores.current.get(id)?.snapshot() };
    });
  // The scene the shell got at page load is old after a remount (hot update, error reset): every
  // mount of the shell takes the server's scenes and versions first; only then editors show and saves start.
  const takeServerScene = async (id: string) => {
    const c = await loadCanvas(id);
    const els = c ? c.elements : (scenes.current.get(id) ?? []);
    if (c) {
      scenes.current.set(id, els);
      nested.setScene(id, els);
      canvases.get(id)?.api.updateScene({ elements: els as never, captureUpdate: CaptureUpdateAction.NEVER });
    }
    gate.arm(id, els);
  };
  useEffect(() => {
    if (!PERSIST) return;
    let dead = false;
    onCanvasRefused((id) => void takeServerScene(id).catch(() => reloadFromDisk()));
    (async () => {
      for (const id of [...scenes.current.keys()]) {
        for (;;) {
          try {
            await takeServerScene(id);
            break;
          } catch {
            await new Promise((ok) => setTimeout(ok, 1000)); // the server is briefly away
            if (dead) return;
          }
        }
      }
      if (dead) return;
      if (firstRun) persistCanvas("c1");
      setSynced(true);
    })();
    return () => void (dead = true);
  }, []);
  const storeFor = (id: string) => {
    if (!stores.current.has(id)) {
      const st = createThreadStore(id, boot.canvases[id]?.threads);
      stores.current.set(id, st);
      threadStores.set(id, st);
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
  const sessionSubtitle = (d: SessionDoc) => {
    const c = sessionCanvas(d);
    return c ? (titleOf(c) ?? "画布已删除") : "未关联画布";
  };
  // Session names follow their agent and first message (docs/workspace-model.md §2).
  useSyncExternalStore(agents.subscribe, bindingKey);
  const agentLabel = useAgentName(); // a session tab is named after its agent: it follows the adapter list
  const bindings = agents.get().bindings;
  const names: Record<string, string> = {
    ...Object.fromEntries(docs.map((d) => [d.id, d.title])),
    ...sessionTitles(docs, (sid, d) => {
      const kind = bindings[sid]?.agent ?? d.agent;
      return { agent: kind && agentLabel(kind) };
    }),
  };
  const isDraftDoc = (d: Doc | undefined) => d?.kind === "session" && sessions.isDraft(d.sessionId);
  // Pointer labels and the 工位视图 name sessions the way the tabs do.
  useEffect(() => sessionNames.set(Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.sessionId, names[d.id] ?? ""]] : [])))));
  useEffect(() => {
    nested.setMeta(
      Object.fromEntries(canvasDocs.map((d) => [d.id, d.title])),
      Object.fromEntries(canvasDocs.flatMap((d) => (d.reviewedAt ? [[d.id, d.reviewedAt]] : []))),
    );
  }, [docs]);
  // Every canvas's comments count on its parent's marker, so each one has a live thread store.
  useEffect(() => {
    for (const d of canvasDocs) storeFor(d.id);
  }, [docs]);

  // The progress pointer follows the session pane focused last.
  useEffect(() => {
    const d = docs.find((x) => x.id === focused);
    if (d?.kind === "session") pointerFollow.set(d.sessionId);
  }, [focused, docs]);
  // Persist the workspace shape (drafts left out) with each session's identity (canvas, agent,
  // native id); sessions persist their records themselves on every change.
  const [committed, setCommitted] = useState(0);
  const saveWorkspace = () => PERSIST && save("workspace", () => savedWorkspace({ docs: docsRef.current, root: rootRef.current, focused: focusedRef.current }, sessions.isDraft, sessionMeta));
  useEffect(() => {
    if (PERSIST) save("workspace", () => savedWorkspace({ docs, root, focused }, sessions.isDraft, sessionMeta));
  }, [docs, root, focused, committed]);
  // A binding or a canvas link changed: the entry's identity follows (unchanged content writes nothing).
  const identityKey = useSyncExternalStore(sessions.subscribe, () => Object.values(sessions.get().sessions).map((s) => `${s.id}:${s.canvasId}`).join(","));
  const boundKey = useSyncExternalStore(agents.subscribe, bindingKey);
  useEffect(() => void saveWorkspace(), [identityKey, boundKey]);
  useEffect(() => {
    if (!PERSIST) return;
    save("sessions", sessions.persisted); // the first-run session is created before this subscription
    return sessions.subscribe(() => save("sessions", sessions.persisted));
  }, []);
  // A draft whose agent was just chosen becomes a saved session; a bound session takes its topic
  // from its first message once (docs/workspace-model.md §2).
  useEffect(() => {
    const sync = () => {
      const { bindings, items } = agents.get();
      let n = 0;
      for (const id of Object.keys(bindings)) if (sessions.isDraft(id) || sessions.isPlaceholder(id)) (sessions.commit(id), n++);
      if (n) setCommitted((c) => c + n);
      setDocs((ds) => {
        let changed = false;
        const next = ds.map((d) => {
          if (d.kind !== "session" || d.topic || !bindings[d.sessionId]) return d;
          const topic = topicOf(items[d.sessionId]?.find((it) => it.kind === "user" && it.text)?.text);
          if (!topic) return d;
          changed = true;
          return { ...d, topic };
        });
        return changed ? next : ds;
      });
    };
    sync();
    return agents.subscribe(sync);
  }, []);
  // Every session exists as a doc, including ones created elsewhere (a comment handed to the agent).
  useEffect(() => {
    const sync = () =>
      setDocs((ds) => {
        const missing = Object.values(sessions.get().sessions).filter((s) => !ds.some((d) => d.kind === "session" && d.sessionId === s.id));
        if (!missing.length) return ds;
        const next = [...ds];
        for (const s of missing) next.push({ id: sessionDocId(s.id), kind: "session", sessionId: s.id, title: threadSessionTitles.get(s.id) ?? "" });
        return next;
      });
    sync();
    return sessions.subscribe(sync);
  }, []);
  // A conversation opened from a comment thread is named after it (comments/sessionTitles.ts): the name is known
  // when the hand-off is sent, and may arrive after the session's doc already exists.
  useEffect(() => {
    const apply = () =>
      setDocs((ds) => {
        const untitled = (d: Doc) => d.kind === "session" && !d.title && !!threadSessionTitles.get(d.sessionId);
        return ds.some(untitled) ? ds.map((d) => (untitled(d) && d.kind === "session" ? { ...d, title: threadSessionTitles.get(d.sessionId)! } : d)) : ds;
      });
    apply();
    return threadSessionTitles.subscribe(apply);
  }, []);
  useEffect(() => {
    for (const d of canvasDocs) {
      const e = canvases.get(d.id);
      if (e) e.title = d.title;
    }
  });

  // An editor that is gone must not stay in the registry: its API answers an empty scene.
  const onGone = useCallback((id: string, h: CanvasHandle) => {
    if (handles.current.get(id) === h) handles.current.delete(id);
    if (canvases.get(id)?.api === h.api) canvases.delete(id);
  }, []);
  const onReady = useCallback((id: string, h: CanvasHandle) => {
    handles.current.set(id, h);
    canvases.set(id, { api: h.api, store: h.store, title: "" });
    bump((n) => n + 1);
    if (BENCH && !benched) (benched = true), void installBench(h.api);
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
      return placeDoc(r, id, kind, {
        kindOf: (t) => docsRef.current.find((d) => d.id === t)?.kind,
        recentCanvas: lastCanvasRef.current,
        linkedCanvas: opts.linkedCanvas,
        focused: focusedRef.current,
        keepVisible: opts.keepVisible,
      });
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
    nested.setScene(id, scenes.current.get(id)!);
    gate.arm(id, scenes.current.get(id)!); // a new file: nothing on the server to load
    persistCanvas(id);
    setDocs((ds) => [...ds, { id, kind: "canvas", title }]);
    openDoc(id, { groupId: opts.groupId, kind: "canvas" });
    setEditing(id); // name it right away
  };
  /** New session linked to a canvas (default: the one in use), beside that canvas unless a group is named. */
  const addSession = (opts: { groupId?: string; canvasId?: string } = {}) => {
    const canvasId = opts.canvasId ?? canvasDoc?.id ?? lastCanvas;
    const s = sessions.create(canvasId, undefined, { draft: true }); // the sync effect adds its doc; saved once an agent is chosen
    openDoc(sessionDocId(s.id), { groupId: opts.groupId, kind: "session", linkedCanvas: canvasId });
  };
  /** 「+」: a session group's own session stays in it; from a canvas or mixed group a session is placed like any new one (into the session column, or one split off the canvas's right). */
  // 「看一个示例」 on the empty canvas: the sample opens as another canvas, the one on screen stays as it is.
  const addCanvasRef = useRef(addCanvas);
  addCanvasRef.current = addCanvas;
  useEffect(() => sampleRequests.subscribe(() => addCanvasRef.current({ sample: true })), []);
  const onNew = (groupId: string | undefined, what: NewWhat, at?: DOMRect) => {
    if (what === "open") return setListOpen({ at: at ? { x: at.left, y: at.bottom } : undefined });
    if (what !== "session") return addCanvas({ groupId, sample: what === "sample" });
    const g = groups(rootRef.current).find((x) => x.id === groupId);
    addSession({ groupId: g && groupKind(g.tabs, kindOf) === "session" ? groupId : undefined });
  };

  /** Rename. A session renamed to nothing goes back to its automatic name; keeping the shown name changes nothing. */
  const rename = (id: string, title: string) => {
    const doc = docOf(id);
    if (doc?.kind === "session" && title.trim() === names[id]) return;
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, title: d.kind === "session" ? title.trim() : title } : d)));
  };

  /**
   * Close = take the tab away. The canvas or session stays in the workspace (and in 所有画布) —
   * except a draft session (no agent chosen, never saved), which closing discards.
   */
  const close = (id: string) => {
    const doc = docOf(id);
    if (doc?.kind === "session" && sessions.isDraft(doc.sessionId)) {
      setDocs((ds) => ds.filter((d) => d.id !== id));
      sessions.discardDraft(doc.sessionId);
      agentChoice.resolve(doc.sessionId, undefined); // a comment waiting on it gets "先不交"
    }
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

  /**
   * Delete = into the trash (web/docs/workspace-model.md §1): the item leaves the workspace, its
   * files move to `.agora/trash/` on the server, and the toast's 撤销 restores it from there — so it
   * still works after a reload, for 30 days, from 回收站. Confirmation happens in the 所有画布 list.
   */
  const remove = async (id: string) => {
    const doc = docOf(id);
    if (!doc) return;
    if (doc.kind === "canvas" && canvasDocs.length === 1) return; // keep one canvas
    const at = placement(root, id);
    const index = docs.indexOf(doc);
    const title = names[id] ?? doc.title;
    // The entry as workspace.json has it now (with the session's identity), for the restore.
    const entry = savedWorkspace({ docs: [doc], root, focused }, () => false, sessionMeta).docs[0];
    // Everything typed so far reaches the files first, so the trash holds the latest version.
    if (PERSIST) await flushSaves();
    if (at) close(id);
    setDocs((ds) => ds.filter((d) => d.id !== id));
    // What the page had, to put back if the server could not move it.
    const keptCanvas = { elements: scenes.current.get(id) ?? [], store: stores.current.get(id) };
    const keptSession = { state: sessions.get(), binding: doc.kind === "session" ? agents.get().bindings[doc.sessionId] : undefined };
    let undoDrop = () => {};
    if (doc.kind === "canvas") {
      scenes.current.delete(id);
      gate.disarm(id);
      nested.remove(id);
      stores.current.delete(id);
      threadStores.delete(id);
      if (PERSIST) undoDrop = dropCanvas(id);
      if (lastCanvas === id) setLastCanvas(canvasDocs.find((d) => d.id !== id)!.id);
    } else {
      const st = sessions.get();
      const { [doc.sessionId]: _, ...rest } = st.sessions;
      const keptTurns = Object.fromEntries(Object.entries(st.turns).filter(([, t]) => t.sessionId !== doc.sessionId));
      sessions.hydrate({ ...st, sessions: rest, turns: keptTurns });
      agents.forget(doc.sessionId); // the progress pointer moves on to another session
    }
    if (!PERSIST) return setRemoved({ title });
    try {
      // Where it was: its place in the list always, its tab only if it had one.
      const m = await trash.put(doc.kind, doc.kind === "canvas" ? id : doc.sessionId, { entry, place: { ...(at ?? {}), docIndex: index }, title });
      setRemoved({ title, trashId: m.trashId });
    } catch (e) {
      // Nothing moved: put it back on the page as it was, and say why.
      setDocs((ds) => (ds.some((d) => d.id === id) ? ds : [...ds.slice(0, index), doc, ...ds.slice(index)]));
      if (doc.kind === "canvas") {
        scenes.current.set(id, keptCanvas.elements);
        nested.setScene(id, keptCanvas.elements);
        gate.arm(id, keptCanvas.elements);
        if (keptCanvas.store) stores.current.set(id, keptCanvas.store), threadStores.set(id, keptCanvas.store);
        undoDrop(); // the files are still there: the next save carries the version this page had seen
      } else {
        const cur = sessions.get();
        sessions.hydrate({ ...cur, sessions: { ...cur.sessions, ...keptSession.state.sessions }, turns: { ...cur.turns, ...keptSession.state.turns } });
        if (keptSession.binding) agents.hydrateBindings({ [doc.sessionId]: keptSession.binding });
      }
      if (at) setRoot((r) => openTab(r, id, at.groupId, at.index));
      setRemoved({ title, error: (e as Error).message });
    }
  };

  /** Put a restored trash item back into the workspace: its entry at its old place, its content on the page. */
  const applyRestored = (r: Restored) => {
    const m = r.item;
    const docId = m.kind === "canvas" ? r.id : sessionDocId(r.id);
    const entry: Doc = (m.entry as Doc | null) ?? (m.kind === "canvas" ? { id: r.id, kind: "canvas", title: m.title || r.id } : { id: docId, kind: "session", sessionId: r.id, title: "" });
    // The manifest's entry first, then the content: bringing the session back makes the session
    // store's sync add a bare entry for it, which must not take the kept one's place.
    setDocs((ds) => placeRestored(ds, entry, m.place?.docIndex));
    if (m.kind === "canvas" && r.canvas) {
      const { elements, threads } = adoptCanvas(r.id, r.canvas);
      scenes.current.set(r.id, elements);
      nested.setScene(r.id, elements);
      gate.arm(r.id, elements);
      const st = createThreadStore(r.id, threads);
      stores.current.set(r.id, st);
      threadStores.set(r.id, st);
      if (PERSIST) st.subscribe(() => persistCanvas(r.id));
    } else if (m.kind === "session") {
      if (r.session) {
        const got = adoptSession(r.id, r.session);
        const cur = sessions.get();
        sessions.hydrate({ sessions: { ...cur.sessions, ...got.sessions }, turns: { ...cur.turns, ...got.turns }, batches: { ...cur.batches, ...got.batches } });
      }
      if (r.binding) agents.hydrateBindings({ [r.id]: r.binding });
    }
    setDocs((ds) => placeRestored(ds, entry, m.place?.docIndex)); // again, after any bare entry the sync added
    if (m.kind === "canvas" && r.id !== r.item.originalId) relinkRestoredCanvas(r.item.originalId, r.id, r.item.linked ?? []);
    const place = m.place;
    const hadTab = !!place?.groupId;
    setRoot((root) => (hadTab && groups(root).some((g) => g.id === place!.groupId) ? openTab(root, docId, place!.groupId, place!.index) : hadTab ? openTab(root, docId) : root));
    if (hadTab) setFocused(docId);
    return docId;
  };
  /**
   * A canvas came back under a new id (its old one was taken meanwhile): what pointed at it follows —
   * the sessions it had, and parent nodes whose child link (customData.childCanvas) named the old id.
   */
  const relinkRestoredCanvas = (from: string, to: string, linked: string[]) => {
    for (const sid of linked) if (sessions.get().sessions[sid]?.canvasId === from) sessions.relink(sid, to);
    for (const [cid, els] of scenes.current) {
      if (cid === to || cid === from) continue;
      const next = relinkChild(els as El[], from, to);
      if (!next) continue;
      scenes.current.set(cid, next);
      nested.setScene(cid, next);
      canvases.get(cid)?.api.updateScene({ elements: next as never });
      persistCanvas(cid);
    }
  };
  const restore = async (trashId: string) => {
    try {
      const r = await trash.restore(trashId);
      applyRestored(r);
      setRemoved(null);
      setPanel(null); // back in the workspace: the trash panel has done its job
    } catch (e) {
      setRemoved({ title: "", error: `恢复失败：${(e as Error).message}` });
    }
  };
  // The toast lasts a while; after that the item stays in 回收站 (restorable from there).
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), removed.error ? 20000 : 12000);
    return () => clearTimeout(t);
  }, [removed]);

  const applyPreset = (p: Preset) => {
    const ids = openIds(root);
    if (ids.length) setRoot(preset(ids, p, focused || ids[0]));
  };
  // 恢复默认布局: two columns, canvases left and sessions right (an older layout with more columns opens as it was saved).
  const restoreLayout = () => setRoot(defaultLayout(root, kindOf));

  /**
   * Nested canvases: show `to` in the tab where `from` is (entering a child, going back up), and
   * record it in the address bar so the browser's back / forward walk the levels.
   */
  const go = (from: string, to: string, push = true) => {
    if (!docsRef.current.some((d) => d.id === to && d.kind === "canvas")) return;
    // Keep what the leaving canvas holds right now. Its view reports scene changes one frame
    // late (CanvasView onChange → onScene), and it unmounts below: a link just written into a
    // node (新建空白子图) would otherwise never reach the scene store, the nesting index or disk.
    const leaving = canvases.get(from)?.api.getSceneElementsIncludingDeleted() as readonly El[] | undefined;
    if (leaving) {
      scenes.current.set(from, leaving);
      nested.setScene(from, leaving);
      persistCanvas(from);
    }
    const r = replaceTab(rootRef.current, from, to);
    if (r.closed) {
      handles.current.delete(from);
      canvases.delete(from);
    }
    setRoot(r.root);
    setFocused(to);
    setLastCanvas(to);
    setMode("browse");
    if (push && canvasFromUrl() !== to) history.pushState({ canvas: to }, "", urlFor(to));
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    nav.go = (from, to) => goRef.current(from, to);
    nav.createChild = async (title) => {
      const id = uid("c");
      const name = nextTitle(titlesOf(docsRef.current, "canvas"), title.trim() || UNTITLED_CANVAS, true);
      scenes.current.set(id, []);
      gate.arm(id, []);
      nested.setMeta({ ...nested.get().titles, [id]: name }, nested.get().reviewed);
      nested.setScene(id, []);
      persistCanvas(id);
      docsRef.current = [...docsRef.current, { id, kind: "canvas", title: name }];
      setDocs((ds) => [...ds, { id, kind: "canvas", title: name }]);
      return id;
    };
    nav.review = (id, at) => setDocs((ds) => ds.map((d) => (d.id === id && d.kind === "canvas" ? { ...d, reviewedAt: at } : d)));
    // Back / forward: show that level in the tab that holds its tree (or open it).
    const onPop = (e: PopStateEvent) => {
      const to = (e.state as { canvas?: string } | null)?.canvas ?? canvasFromUrl();
      if (!to || !docsRef.current.some((d) => d.id === to && d.kind === "canvas")) return;
      const st = nested.get();
      const tree = ancestry(to, st.index)[0];
      const family = new Set([tree, ...descendants(tree, st.scenes)]);
      const shownIds = groups(rootRef.current).map((g) => g.active);
      const from = shownIds.find((id) => family.has(id)) ?? openIds(rootRef.current).find((id) => family.has(id));
      if (from) goRef.current(from, to, false);
      else openRef.current(to, { kind: "canvas" });
    };
    addEventListener("popstate", onPop);
    // ⌘↑ / Ctrl+↑: up one level from the child canvas in use (nested/up.ts decides when it is ours); ⇧↵: into the selected node.
    const onKey = (e: KeyboardEvent) => {
      const id = docsRef.current.some((d) => d.id === focusedRef.current && d.kind === "canvas") ? focusedRef.current : lastCanvasRef.current;
      const api = canvases.get(id)?.api;
      const map = api ? byId(api.getSceneElements() as readonly El[]) : new Map<string, El>();
      const selected = api ? Object.keys(api.getAppState().selectedElementIds ?? {}).flatMap((k) => map.get(k) ?? []) : [];
      const keys = { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, editable: isEditableTarget(e.target) };
      // Shift+Enter: into the sub-diagram of the selected node (nested/enter.ts) — the keyboard's way in; a double-click is Excalidraw's own.
      const node = api && selected.length ? selectedNode(selected.map((s) => s.id), map, api.getSceneElements() as readonly El[]) : undefined;
      const into = enterOnKey(keys, node, (n) => childOf(n), (c) => nested.get().scenes.has(c));
      if (into) {
        e.preventDefault();
        e.stopPropagation();
        goRef.current(id, into);
        return;
      }
      const up = upOnKey(keys, id, nested.get().index, selected);
      if (!up) return;
      e.preventDefault();
      e.stopPropagation();
      markBackHintSeen();
      goRef.current(id, up);
    };
    addEventListener("keydown", onKey, true);
    // A link like ?canvas=<id> opens that level on load.
    const first = canvasFromUrl();
    if (first && docsRef.current.some((d) => d.id === first && d.kind === "canvas")) {
      const st = nested.get();
      const tree = ancestry(first, st.index)[0];
      const family = new Set([tree, ...descendants(tree, st.scenes)]);
      const from = openIds(rootRef.current).find((id) => family.has(id));
      if (from) goRef.current(from, first, false);
      else openRef.current(first, { kind: "canvas" });
    }
    return () => (removeEventListener("popstate", onPop), removeEventListener("keydown", onKey, true));
  }, []);
  // The address bar follows the canvas in use (replace, not push: switching tabs is not a level change).
  useEffect(() => {
    if (!PERSIST || kindOf(focused) !== "canvas") return;
    if (canvasFromUrl() !== focused) history.replaceState({ canvas: focused }, "", urlFor(focused));
  }, [focused]);
  // A node that opened a child canvas was deleted: the child stays, only the link is gone.
  const [lost, setLost] = useState<{ child: string; parent: string } | null>(null);
  useEffect(() => nested.onLost(setLost), []);
  useEffect(() => {
    if (!lost) return;
    const t = setTimeout(() => setLost(null), 9000);
    return () => clearTimeout(t);
  }, [lost]);

  // UI actions sessions can trigger without importing the shell.
  const addSessionRef = useRef(addSession);
  addSessionRef.current = addSession;
  const openRef = useRef(openDoc);
  openRef.current = openDoc;
  // a comment made while watching the build replay is a comment on the whole canvas, noting the step (comments/WholeCanvas.tsx)
  useEffect(() => {
    buildReplay.setCommenter((text, step) => {
      const root = buildReplay.get();
      if (root) void ui.ensureCanvas(root).then(() => handles.current.get(root)?.store.create(null, text, { step }));
    });
    return () => buildReplay.setCommenter(null);
  }, []);
  /** Canvases opened only for an agent (`ui.ensureCanvas`): id → when one of its calls last used it. */
  const quietTabs = useRef(new Map<string, number>());
  useEffect(() => {
    const t = setInterval(() => {
      for (const [id, at] of quietTabs.current) {
        if (Date.now() - at < QUIET_TAB_MS) continue;
        quietTabs.current.delete(id);
        // the person took it (it is in front, or focused): it stays, as theirs
        const g = groupOf(rootRef.current, id);
        if (!g || g.active === id || focusedRef.current === id) continue;
        setRoot((r) => closeTab(r, id));
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    ui.focusPane = (id) => {
      if (!docsRef.current.some((d) => d.id === id)) return;
      openRef.current(id);
    };
    ui.ensureCanvas = async (id) => {
      if (canvases.get(id)) return (quietTabs.current.has(id) && quietTabs.current.set(id, Date.now()), canvases.get(id));
      if (!docsRef.current.some((d) => d.id === id && d.kind === "canvas")) return undefined;
      // for an agent's read or edit, not for the person: the tab joins quietly (never the active one, no split beside the canvas in use) and goes again once
      // nothing has used it for a while and the person has not taken it (./workspace/model.ts `placeQuiet`)
      if (!isOpen(rootRef.current, id)) {
        const quiet = { kindOf: (t: string) => docsRef.current.find((d) => d.id === t)?.kind, recentCanvas: lastCanvasRef.current, focused: focusedRef.current };
        setRoot((r) => (isOpen(r, id) ? r : placeQuiet(r, id, quiet)));
        quietTabs.current.set(id, Date.now());
      }
      for (let i = 0; i < 60 && !canvases.get(id); i++) await new Promise((ok) => setTimeout(ok, 50));
      if (quietTabs.current.has(id)) quietTabs.current.set(id, Date.now());
      return canvases.get(id);
    };
    ui.openThread = (canvasId, threadId) => {
      void ui.ensureCanvas(canvasId).then(() => {
        ui.focusPane(canvasId);
        const h = handles.current.get(canvasId);
        const t = h?.store.thread(threadId);
        if (!h || !t) return;
        const a = h.api.getAppState();
        if (t.anchor) {
          const p = resolveAnchor(t.anchor, byId(h.api.getSceneElementsIncludingDeleted())).point;
          h.api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - p.x, scrollY: a.height / 2 / a.zoom.value - p.y } });
        }
        setTimeout(() => h.store.open(threadId), 120);
      });
    };
    ui.chooseAgent = async (canvasId) => {
      // Reuse an unbound session on this canvas, else start a draft; the pane shows the agent picker.
      const bound = agents.get().bindings;
      const s = sessions.onCanvas(canvasId).find((x) => !bound[x.id]) ?? sessions.create(canvasId, undefined, { draft: true });
      const wait = agentChoice.wait(s.id);
      ui.openSession(s.id);
      return wait;
    };
    ui.newSession = () => addSessionRef.current();
    ui.openTrash = (trashId) => (setPanelFocus(trashId), setListOpen(null), setPanel("trash"));
    ui.openHistory = () => (setListOpen(null), setPanel("history"));
    ui.trashSession = (sessionId) => {
      const doc = docsRef.current.find((d) => d.kind === "session" && d.sessionId === sessionId);
      if (doc) setListOpen({ confirm: doc.id });
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
      // Editing a comment in place: Esc cancels just that edit.
      if ((e.target as HTMLElement)?.closest?.("[data-esc-local]")) return;
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
        // With elements selected, C comments that selection; otherwise it toggles comment mode.
        if (mode !== "comment" && selCount > 0 && canvasDoc) return void handles.current.get(canvasDoc.id)?.commentSelection();
        setMode((m) => (m === "comment" ? "browse" : "comment"));
      } else if (k === "v") setMode("browse");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  // The 工位视图's keys (docs/workstation.md §10): Esc closes the route of a played turn, then drops
  // the figure's selection; F follows the selected figure. Not while typing or in the timeline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable], [data-esc-local]")) return;
      const selected = figureFocus.get().selected;
      if (e.key === "Escape") figureFocus.escape();
      else if (e.key.toLowerCase() === "f" && !e.shiftKey && selected) {
        e.preventDefault();
        e.stopPropagation(); // Excalidraw's F is its frame tool
        liveFollow.follow(selected);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  // The dock belongs to the canvas it acts on: keep it at that pane's bottom centre, so a
  // session pane below the canvas is never covered.
  const [dockAt, setDockAt] = useState<{ x: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    // The canvas stage, not the whole pane: with the comments column open the dock stays centred on the drawing.
    const el = canvasDoc && document.querySelector<HTMLElement>(`[data-pane="${canvasDoc.id}"] .canvas-layers`);
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      // A narrow canvas puts Excalidraw in its compact layout, whose toolbar sits at the bottom: clear it.
      const compact = isCompact(!!el.querySelector(".excalidraw--mobile"), r.width);
      // in the compact layout the dock sits in the bottom bar's empty middle (canvas/dockPlace.ts)
      const bar = el.querySelector<HTMLElement>(".App-bottom-bar .Island")?.getBoundingClientRect();
      setDockAt((d) => {
        const next = { x: Math.round(r.left + r.width / 2), bottom: dockBottom({ paneBottom: r.bottom, windowHeight: innerHeight, compact, bar: bar ? { top: bar.top, bottom: bar.bottom } : null, dockHeight: document.querySelector<HTMLElement>(".dock")?.offsetHeight }) };
        return d && d.x === next.x && d.bottom === next.bottom ? d : next;
      });
    };
    place();
    // Pane rects glide for ~420ms after layout changes; follow them, then settle.
    let frame = 0;
    const until = performance.now() + 600;
    const loop = () => (place(), performance.now() < until && (frame = requestAnimationFrame(loop)));
    frame = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => requestAnimationFrame(place));
    ro.observe(el);
    addEventListener("resize", place);
    return () => (cancelAnimationFrame(frame), ro.disconnect(), removeEventListener("resize", place));
  }, [canvasDoc?.id, root, handle]); // `handle` arrives once the pane has mounted

  const canvasTitles = Object.fromEntries(canvasDocs.map((d) => [d.id, d.title]));
  return (
    <MotionConfig reducedMotion="user">
      <div className="app" data-mode={mode}>
        <WorkerDefs />
        <WaitNotifier />
        <header className="topbar">
          <span className="brand"><IconWorkspace size={18} />Agora</span>
          {boot.project && <span className="project-name" title={boot.project.root}>{boot.project.name}</span>}
          <span className="topbar-gap" />
          <AgentTags />
          {PERSIST && <ShareButton canvases={canvasDocs.map((d) => ({ id: d.id, title: d.title }))} current={canvasDoc?.id ?? lastCanvas} />}
          <ViewMenu onLayout={applyPreset} onRestore={restoreLayout} layouts={open.size >= 2} />
        </header>
        {listOpen && (
          // 所有画布 opens from a canvas tab bar's「+」→「打开画布」(or a delete confirmation), where it was asked for.
          <div className="all-docs" style={{ position: "fixed", zIndex: 41, left: Math.max(8, Math.min((listOpen.at?.x ?? 12), innerWidth - 352)), top: (listOpen.at?.y ?? 48) - 6 }}>
            <AllDocs
              docs={(() => {
                const st = nested.get();
                const order = canvasTree(canvasDocs.map((d) => d.id), (id) => st.index.get(id)?.canvasId);
                const byId = new Map(docs.map((d) => [d.id, d]));
                return [...order.map((o) => byId.get(o.id)!), ...docs.filter((d) => d.kind !== "canvas" && !isDraftDoc(d))];
              })()}
              depth={(id) => {
                const st = nested.get();
                return ancestry(id, st.index).length - 1;
              }}
              childCount={(id) => descendants(id, nested.get().scenes).size}
              titles={names}
              open={open}
              focused={focused}
              confirm={listOpen.confirm}
              setConfirm={(id) => setListOpen((l) => ({ ...l, confirm: id }))}
              canvasOf={sessionCanvas}
              commentCount={(id) => openThreads(storeFor(id).get().threads)}
              onOpen={(id) => (openDoc(id), setListOpen(null))}
              onRemove={(id) => (void remove(id), setListOpen((l) => ({ at: l?.at })))}
              onTrash={() => (setListOpen(null), setPanelFocus(undefined), setPanel("trash"))}
              onHistory={() => (setListOpen(null), setPanel("history"))}
              onNew={(sample) => (addCanvas({ sample }), setListOpen(null))}
              onDismiss={() => setListOpen(null)}
            />
          </div>
        )}
        <SaveBanner docTitle={(id) => names[id]} scene={(id) => scenes.current.get(id)} />
        {change && <ChangeBanner change={change} onDismiss={() => (setChange(null), void ackChange())} />}
        {recoveredNote && (
          <div className="notice save-banner" role="status" data-tone="caution">
            <IconHint size={16} />
            <b>已恢复列表</b>
            <span>
              {recoveredNote.why === "unreadable" ? ".agora/workspace.json 读不了" : "没有找到 .agora/workspace.json"}
              ：按磁盘上的 {recoveredNote.canvases} 块画布和 {recoveredNote.sessions} 个会话重建了列表，没有改动任何画布。画布名是临时的，可以改名；布局需要重新摆。
            </span>
            <button className="btn sm ghost" onClick={() => setRecoveredNote(undefined)}>知道了</button>
          </div>
        )}

        <Workspace
          root={root}
          setRoot={setRoot}
          titles={names}
          subtitles={Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.id, sessionSubtitle(d)]] : [])))}
          kinds={Object.fromEntries(docs.map((d) => [d.id, d.kind]))}
          marks={Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.id, <SessionMark key={d.id} sessionId={d.sessionId} fallback={d.agent} />]] : [])))}
          focused={focused}
          onFocus={focus}
          onNew={onNew}
          canvasCount={canvasDocs.length}
          onClose={close}
          onDelete={(id) => setListOpen({ confirm: id })}
          editing={editing}
          setEditing={setEditing}
          onRename={rename}
          renderEmpty={(g) => (
            <div className="wm-empty">
              <span className="dither-field" aria-hidden />
              <p>这里没有打开的画布或会话</p>
              <div className="wm-empty-actions">
                <button className="btn primary" onClick={() => onNew(g, "canvas")}><IconPlus size={16} />新建画布</button>
                <button className="btn ghost" onClick={() => onNew(g, "session")}>新建会话</button>
                <button className="btn ghost" onClick={() => setListOpen({})}>打开已有的</button>
              </div>
            </div>
          )}
          onSettled={onSettled}
          renderCanvas={(id) => {
            const doc = docs.find((d) => d.id === id);
            if (!doc || !synced) return null;
            if (doc.kind === "session") return <SessionPane sessionId={doc.sessionId} canvasTitles={canvasTitles} />;
            return (
              <CanvasView
                doc={{ id, title: doc.title, store: storeFor(id) }}
                mode={id === focused ? mode : "browse"}
                drawerOpen={!!drawers[id]}
                onDrawer={(open) => setDrawers((d) => ({ ...d, [id]: open }))}
                onReady={(h) => onReady(id, h)}
                onGone={(h) => onGone(id, h)}
                onSelection={(n) => id === lastCanvas && setSelCount(n)}
                onModeDone={() => setMode("browse")}
                initialElements={scenes.current.get(id) ?? []}
                onScene={(els) => (scenes.current.set(id, els), nested.setScene(id, els), persistCanvas(id))}
              />
            );
          }}
        />

        {canvasDoc && <>
        <Dock
          at={dockAt}
          mode={mode}
          setMode={(m) => {
            ui.focusPane(canvasDoc.id);
            // 评论 with elements selected comments that selection (评论选区 folded into comment mode).
            if (m === "comment" && mode !== "comment" && selCount > 0) return void handle?.commentSelection();
            setMode(m);
          }}
          drawerOpen={!!drawers[canvasDoc.id]}
          toggleDrawer={() => setDrawers((d) => ({ ...d, [canvasDoc.id]: !d[canvasDoc.id] }))}
          store={storeFor(canvasDoc.id)}
          evalButton={
            EVAL_MODE && handle ? (
              <button
                className="btn sm quiet"
                disabled={!!evalProgress && !evalProgress.done}
                onClick={() => runEval(handle.api, handle.store, { runs: EVAL_RUNS, only: EVAL_ONLY, onProgress: setEvalProgress, reset: handle.reset })}
              >
                {evalProgress && !evalProgress.done ? `评测中 ${evalProgress.index}/${evalProgress.total}` : `运行评测 ${EVAL_ONLY?.length ?? TASKS.length}×${EVAL_RUNS}`}
              </button>
            ) : null
          }
        />
        {mode === "comment" && (
          <motion.div className="mode-hint" style={dockAt ? { left: dockAt.x, bottom: dockAt.bottom + 50 } : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <IconComment size={14} />在「<b>{canvasDoc.title}</b>」上点一个元素钉评论 · Esc 退出
          </motion.div>
        )}
        </>}
        {removed && (
          <motion.div className="toast" role={removed.error ? "alert" : "status"} data-tone={removed.error ? "error" : undefined} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            {removed.error ? (
              <span>{removed.title ? `没能删除「${removed.title}」：` : ""}{removed.error}</span>
            ) : (
              <span>已移到回收站「{removed.title}」</span>
            )}
            {removed.trashId && <button className="btn sm ghost" onClick={() => void restore(removed.trashId!)}>撤销</button>}
            <button className="icon-btn sm muted" aria-label="关闭提示" onClick={() => setRemoved(null)}><IconClose size={14} /></button>
          </motion.div>
        )}
        {panel === "trash" && <TrashPanel focus={panelFocus} titles={names} canvasTitles={canvasTitles} onRestore={(id) => void restore(id)} onDismiss={() => setPanel(null)} />}
        {panel === "history" && (
          <HistoryPanel
            docs={docs.filter((d) => !isDraftDoc(d))}
            titles={names}
            canvasTitles={canvasTitles}
            open={open}
            currentCanvas={canvasDoc?.id ?? lastCanvas}
            onOpen={(id) => (openDoc(id), setPanel(null))}
            onRestore={(id) => (void restore(id), setPanel(null))}
            onImported={(docId, doc) => {
              setDocs((ds) => (ds.some((d) => d.id === docId) ? ds : [...ds, doc]));
              setPanel(null);
              setTimeout(() => openDoc(docId, { kind: "session" }), 0);
            }}
            onDismiss={() => setPanel(null)}
          />
        )}

        {lost && !removed && (
          <motion.div className="toast" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <span>「{titleOf(lost.parent) ?? "画布"}」里打开子图的节点没了：子图「{titleOf(lost.child) ?? lost.child}」仍在所有画布里，只是断开了链接（⌘Z 可恢复）</span>
            <button className="btn sm ghost" onClick={() => (openDoc(lost.child), setLost(null))}>打开子图</button>
            <button className="icon-btn sm muted" aria-label="关闭提示" onClick={() => setLost(null)}><IconClose size={14} /></button>
          </motion.div>
        )}
        {evalProgress && <pre className="eval-log">{evalProgress.log.slice(-14).join("\n")}</pre>}
      </div>
    </MotionConfig>
  );
}

/**
 * The canvas dock: 浏览 / 评论 and the open-comment count (opens the comment list). Commenting a
 * selection is part of comment mode (select, then C or 评论); 清空画布 lives in Excalidraw's ☰.
 */
function Dock({ at, mode, setMode, drawerOpen, toggleDrawer, store, evalButton }: {
  at: { x: number; bottom: number } | null;
  mode: "browse" | "comment";
  setMode: (m: "browse" | "comment") => void;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  store: ThreadStore;
  evalButton: React.ReactNode;
}) {
  const { threads } = useThreads(store);
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <div className="dock" role="toolbar" aria-label="画布工具" style={at ? { left: at.x, bottom: at.bottom } : undefined}>
      <div className="seg dock-seg" role="radiogroup" aria-label="模式">
        {([["browse", IconPointer, "浏览", "V"], ["comment", IconComment, "评论", "C"]] as const).map(([m, Icon, label, key]) => (
          <button key={m} role="radio" aria-checked={mode === m} data-on={mode === m} onClick={() => setMode(m)} title={`${label} · ${key}${m === "comment" ? "（先选中元素再按，评论这组选区）" : ""}`}>
            {mode === m && <motion.span layoutId="dock-on" className="seg-bg" transition={SPRING} />}
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <button className="dock-count" data-on={drawerOpen} aria-pressed={drawerOpen} onClick={toggleDrawer} title="评论列表" aria-label={`评论列表 · ${open} 条进行中`}>
        <IconList size={14} />
        评论
        {open > 0 && <em>{open}</em>}
      </button>
      {evalButton}
    </div>
  );
}

/**
 * Saving problems, most serious first: the project directory is gone (410), a write the server
 * refused (disk full, permissions…), a file changed on disk since this page loaded it, a file on
 * disk that cannot be read (not written from here), or the project server is unreachable.
 */
function SaveBanner({ docTitle, scene }: { docTitle: (id: string) => string | undefined; scene: (id: string) => readonly El[] | undefined }) {
  const st = useSyncExternalStore(project.subscribe, project.status);
  // The canvases whose unsaved state lives only in this page: download them before anything else.
  const unsaved = [...new Set(st.failed.map((f) => f.slot.split(":")).filter(([k]) => k === "canvas" || k === "threads").map(([, id]) => id))];
  const download = (ids: string[]) => ids.forEach((id) => downloadScene(docTitle(id) ?? id, scene(id) ?? []));
  const gone = st.failed.find((f) => f.gone);
  if (gone)
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>项目目录不在了</b>
        <span>{gone.message}</span>
        {unsaved.length > 0 && <button className="btn sm quiet" onClick={() => download(unsaved)}>下载为 .excalidraw{unsaved.length > 1 ? `（${unsaved.length} 块）` : ""}</button>}
        <button className="btn sm ghost" onClick={() => void project.retry()}>重试</button>
      </div>
    );
  const failed = st.failed[0];
  if (failed) {
    const file = failed.file ?? slotFile(failed.slot);
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>保存失败</b>
        <span>
          {failed.message.replace(/^保存失败：/, "")}
          {st.failed.length > 1 ? `（另有 ${st.failed.length - 1} 个文件）` : ""} · <code>.agora/{file}</code> · 改动还在这个页面里
        </span>
        {unsaved.length > 0 && <button className="btn sm ghost" onClick={() => download(unsaved)}>下载为 .excalidraw</button>}
        <button className="btn sm quiet" onClick={() => void project.retry()}>重试</button>
      </div>
    );
  }
  const slot = st.conflicts[0];
  if (slot) {
    const [kind, id] = slot.split(":");
    const what = kind === "workspace" ? "画布清单与布局" : kind === "session" ? "会话记录" : `「${docTitle(id) ?? id}」${kind === "threads" ? "的评论" : ""}`;
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>有冲突</b>
        <span>{what}在别处被改过（另一个窗口、编辑器或 git），这里的改动还没保存 · <code>.agora/{slotFile(slot)}</code></span>
        <button className="btn sm quiet" onClick={reloadFromDisk}>载入磁盘上的版本</button>
        <button className="btn sm ghost" onClick={() => void project.resolve(slot, "overwrite")}>用这里的覆盖</button>
      </div>
    );
  }
  if (st.blocked.length)
    return (
      <div className="notice save-banner" role="alert" data-tone="caution">
        <IconHint size={16} />
        <b>文件读不了</b>
        <span>
          {st.blocked.map((b) => b.reason).join("；")}。这个文件先不保存，其余照常；在编辑器里解决后刷新页面。
        </span>
        <button className="btn sm quiet" onClick={() => location.reload()}>刷新</button>
      </div>
    );
  if (st.offline)
    return (
      <div className="notice save-banner" role="status" data-tone="caution">
        <IconHint size={16} />
        <b>未连接</b>
        <span>项目服务连不上，改动暂存在这个页面里，恢复后自动写入。</span>
      </div>
    );
  return null;
}

/** Save a canvas as it is in this page as an .excalidraw file (opens on excalidraw.com as-is). */
function downloadScene(title: string, elements: readonly El[]) {
  const file = { type: "excalidraw", version: 2, source: "agora", elements: elements.filter((e) => !e.isDeleted), appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${title.replace(/[\\/:*?"<>|]/g, "_") || "canvas"}.excalidraw` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What happened to this copy of the project since the page last looked (server/canvas/local.py):
 * moved (Pi logs moved along), copied (sessions read-only until forked), a fresh clone or another
 * machine (sessions shown as read-only cards). Shown once; 知道了 tells the server.
 */
function ChangeBanner({ change, onDismiss }: { change: LocalChange; onDismiss: () => void }) {
  const failed = change.failed ?? [];
  const [title, text] =
    change.kind === "moved"
      ? [
          "项目移动过",
          `从 ${change.from} 移到了这里。Claude Code 和 Codex 的会话照常续接${change.migrated?.length ? `；${change.migrated.length} 个 Pi 会话的日志已迁到新目录（旧文件留了 .agora-moved.bak）` : ""}${failed.length ? `；${failed.length} 个 Pi 会话没迁移：${failed.map((f) => f.error).join("；")}` : ""}。`,
        ]
      : change.kind === "copied"
        ? ["这是一份副本", `从 ${change.from} 复制而来：带过来的 ${change.sessions?.length ?? 0} 个会话在这里只读（原来那份还在用它们），可以在会话里「在这里分叉继续」。`]
        : change.kind === "fresh"
          ? ["会话不在这台机器上", "这份项目是新 clone、换了机器或本机记录被清掉了：带着的会话显示为只读卡片，能在本机找回的会给出「恢复」。"]
          : ["已认回这份项目", "本机记录（.agora/local）不见了，已按本机注册表认回；会话绑定可以在会话里恢复，或运行 agora doctor。"];
  return (
    <div className="notice save-banner" role="status" data-tone={failed.length ? "caution" : undefined}>
      <IconHint size={16} />
      <b>{title}</b>
      <span>{text}</span>
      <button className="btn sm ghost" onClick={onDismiss}>知道了</button>
    </div>
  );
}
