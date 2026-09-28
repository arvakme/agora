import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveAnchor } from "../canvas/anchors";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { SPRING } from "../comments/motion";
import { replayEval, runEval, TASKS, type EvalProgress, type EvalRow } from "../eval/eval";
import { buildFixture } from "../eval/fixture";
import { IconClose, IconCols, IconComment, IconGrid, IconHint, IconLayers, IconList, IconPlus, IconPointer, IconRows, IconSelect, IconSingle, IconTrash, IconWorkspace } from "./icons";
import { ThemeButton } from "./ThemeButton";
import { discard, PERSIST, project, reloadFromDisk, save, slotFile, type ProjectInfo } from "../persist";
import { byId, type El } from "../canvas/scene";
import { SessionPane } from "../session/SessionPane";
import { sessions, type Session, type Turn } from "../session/store";
import { agentChoice, canvases, ui } from "../session/ui";
import { AGENT_NAMES, agents, type Binding } from "../session/agents";
import { SessionMark } from "../session/AgentAvatar";
import { pointerFollow } from "../pointer/follow";
import { createThreadStore, threadStores, useThreads, type ThreadSnapshot, type ThreadStore } from "../comments/threads";
import { AllDocs } from "../workspace/AllDocs";
import { ancestry, descendants } from "../nested/graph";
import { canvasFromUrl, nav, nested, urlFor } from "../nested/store";
import { sessionNames } from "../multi/writes";
import { setWorkstationRoot } from "../workstation/Workstation";
import { ShareButton } from "../share/SharePanel";
import { Workspace } from "../workspace/Workspace";
import { activate, group, groupOf, groups, moveTab, preset, type Node, type Preset } from "../workspace/layout";
import {
  canvasTree,
  closeTab,
  homeGroup,
  replaceTab,
  isOpen,
  migrateDocs,
  nextTitle,
  openIds,
  openTab,
  placement,
  SAMPLE_CANVAS,
  savedWorkspace,
  sessionDocId,
  sessionTitles,
  titlesOf,
  topicOf,
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
export type Boot = { workspace?: WorkspaceState; canvases: Record<string, { elements: El[]; threads: ThreadSnapshot }>; project?: ProjectInfo; firstRun?: boolean };

/** First run: the sample canvas on the left, a draft session docked on the right. Later canvases start blank. */
function defaults(): WorkspaceState {
  const s = sessions.create("c1", undefined, { draft: true });
  const p = sessionDocId(s.id);
  const docs: Doc[] = [{ id: "c1", kind: "canvas", title: SAMPLE_CANVAS }, { id: p, kind: "session", sessionId: s.id, title: "" }];
  const g = group(["c1", p]);
  const root = moveTab(g, p, g.id, "right");
  return { v: 2, docs, root: root.kind === "split" ? { ...root, sizes: [0.6, 0.4] } : root, focused: "c1" };
}

/**
 * Settle the workspace before the first render: the first-run defaults and any session record an
 * older build never saved are created here, once, outside React. Doing it during App's render
 * (as a useMemo / useState initializer) wrote to the sessions store while rendering — and Fast
 * Refresh re-runs useMemo, so every edit created another session and React warned
 * "Cannot update SessionPane while rendering App".
 */
export function prepareBoot(boot: Boot): Boot {
  const workspace = boot.workspace ?? defaults();
  const docs = migrateDocs(workspace.docs);
  const firstCanvas = docs.find((d) => d.kind === "canvas")!.id;
  for (const d of docs) if (d.kind === "session" && !sessions.get().sessions[d.sessionId]) sessions.create(firstCanvas, d.sessionId);
  return { ...boot, workspace: { ...workspace, docs }, firstRun: !boot.workspace };
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** Bound agents as a stable string, so the shell re-renders when a binding appears, not on every status event. */
const bindingKey = () => Object.entries(agents.get().bindings).map(([id, b]) => `${id}:${b.agent}`).join(",");
/** What one delete removed, kept in memory for a single undo. */
type Removed =
  | { kind: "canvas"; doc: CanvasDoc; index: number; at: { groupId: string; index: number } | null; elements: readonly El[]; store?: ThreadStore }
  | { kind: "session"; doc: SessionDoc; name: string; index: number; at: { groupId: string; index: number } | null; session?: Session; turns: Turn[]; binding?: Binding };

export function App({ boot }: { boot: Boot }) {
  // prepareBoot (main.tsx) has settled the workspace; nothing here writes to a store while rendering.
  const firstRun = !!boot.firstRun;
  const initial = boot.workspace!;
  const [docs, setDocs] = useState<Doc[]>(initial.docs);
  const [root, setRoot] = useState<Node>(initial.root);
  const [focused, setFocused] = useState(initial.focused);
  const [lastCanvas, setLastCanvas] = useState(() =>
    initial.docs.find((d) => d.id === initial.focused)?.kind === "canvas" ? initial.focused : initial.docs.find((d) => d.kind === "canvas")!.id,
  );
  const [mode, setMode] = useState<"browse" | "comment">("browse");
  const [drawers, setDrawers] = useState<Record<string, boolean>>({});
  const [selCount, setSelCount] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
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
  // Nesting reads every canvas's scene, open or not (docs/nested-canvas.md).
  const nestedBooted = useRef(false);
  if (!nestedBooted.current) {
    nestedBooted.current = true;
    setWorkstationRoot(boot.project?.root ?? "");
    nested.reset(
      scenes.current,
      Object.fromEntries(initial.docs.filter((d) => d.kind === "canvas").map((d) => [d.id, d.title])),
      Object.fromEntries(initial.docs.flatMap((d) => (d.kind === "canvas" && d.reviewedAt ? [[d.id, d.reviewedAt]] : []))),
    );
  }
  const persistCanvas = (id: string) =>
    PERSIST && save(`canvas:${id}`, () => ({ elements: (scenes.current.get(id) ?? []).filter((e) => !e.isDeleted), threads: stores.current.get(id)?.snapshot() }));
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
  // Session names follow their agent and first message (docs/workspace-model.md §2).
  useSyncExternalStore(agents.subscribe, bindingKey);
  const bindings = agents.get().bindings;
  const names: Record<string, string> = {
    ...Object.fromEntries(docs.map((d) => [d.id, d.title])),
    ...sessionTitles(docs, (sid) => ({ agent: bindings[sid] && AGENT_NAMES[bindings[sid].agent] })),
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
  // Persist the workspace shape (drafts left out); sessions persist themselves on every change.
  const [committed, setCommitted] = useState(0);
  useEffect(() => {
    if (PERSIST) save("workspace", () => savedWorkspace({ docs, root, focused }, sessions.isDraft));
  }, [docs, root, focused, committed]);
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
      for (const id of Object.keys(bindings)) if (sessions.isDraft(id)) (sessions.commit(id), n++);
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
        for (const s of missing) next.push({ id: sessionDocId(s.id), kind: "session", sessionId: s.id, title: "" });
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
    nested.setScene(id, scenes.current.get(id)!);
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
  const onNew = (groupId: string | undefined, what: "canvas" | "session" | "sample") =>
    what === "session" ? addSession({ groupId }) : addCanvas({ groupId, sample: what === "sample" });

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
      nested.remove(id);
      stores.current.delete(id);
      threadStores.delete(id);
      if (PERSIST) void discard(`canvas:${id}`);
      if (lastCanvas === id) setLastCanvas(canvasDocs.find((d) => d.id !== id)!.id);
    } else {
      const st = sessions.get();
      const session = st.sessions[doc.sessionId];
      const turns = (session?.turnIds ?? []).map((t) => st.turns[t]).filter(Boolean);
      setRemoved({ kind: "session", doc, name: names[id] ?? doc.title, index, at, session, turns, binding: agents.get().bindings[doc.sessionId] });
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
      nested.setScene(r.doc.id, r.elements);
      if (r.store) stores.current.set(r.doc.id, r.store), threadStores.set(r.doc.id, r.store);
      persistCanvas(r.doc.id);
    } else if (r.session) {
      const st = sessions.get();
      sessions.hydrate({ ...st, sessions: { ...st.sessions, [r.session.id]: r.session }, turns: { ...st.turns, ...Object.fromEntries(r.turns.map((t) => [t.id, t])) } });
      // Deleting the session removed its agent binding on disk; bind the same native session again.
      const b = r.binding;
      if (b) void agents.bind(r.session.id, b.agent, b.model, b.effort, b.nativeId).catch(() => {});
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

  /**
   * Nested canvases: show `to` in the tab where `from` is (entering a child, going back up), and
   * record it in the address bar so the browser's back / forward walk the levels.
   */
  const go = (from: string, to: string, push = true) => {
    if (!docsRef.current.some((d) => d.id === to && d.kind === "canvas")) return;
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
    return () => removeEventListener("popstate", onPop);
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
    ui.chooseAgent = async (canvasId) => {
      // Reuse an unbound session on this canvas, else start a draft; the pane shows the agent picker.
      const bound = agents.get().bindings;
      const s = sessions.onCanvas(canvasId).find((x) => !bound[x.id]) ?? sessions.create(canvasId, undefined, { draft: true });
      const wait = agentChoice.wait(s.id);
      ui.openSession(s.id);
      return wait;
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
    // The canvas stage, not the whole pane: with the comments column open the dock stays centred on the drawing.
    const el = canvasDoc && document.querySelector<HTMLElement>(`[data-pane="${canvasDoc.id}"] .canvas-layers`);
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      // A narrow canvas puts Excalidraw in its compact layout, whose toolbar sits at the bottom: clear it.
      const compact = !!el.querySelector(".excalidraw--mobile");
      setDockAt((d) => {
        const next = { x: Math.round(r.left + r.width / 2), bottom: Math.round(innerHeight - r.bottom + (compact ? 72 : 14)) };
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
        <header className="topbar">
          <span className="brand"><IconWorkspace size={18} />Agora</span>
          {boot.project && <span className="project-name" title={boot.project.root}>{boot.project.name}</span>}
          <div className="all-docs">
            <button className="btn ghost all-docs-btn" aria-expanded={!!listOpen} onClick={() => setListOpen((o) => (o ? null : {}))} title="所有画布和会话，包括已关闭的">
              <IconLayers size={16} /><span className="btn-label">所有画布</span><em>{canvasDocs.length}</em>
            </button>
            {listOpen && (
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
          {PERSIST && <ShareButton canvases={canvasDocs.map((d) => ({ id: d.id, title: d.title }))} current={canvasDoc?.id ?? lastCanvas} />}
          <div className="iseg" role="group" aria-label="排列">
            {([["single", IconSingle, "单窗"], ["row", IconCols, "左右并排"], ["col", IconRows, "上下并排"], ["grid", IconGrid, "平铺"]] as const).map(([p, Icon, label]) => (
              <button key={p} onClick={() => applyPreset(p)} title={label} aria-label={label} disabled={open.size < 2 && p !== "single"}>
                <Icon size={16} />
              </button>
            ))}
          </div>
          <ThemeButton />
          <span className="topbar-sep" />
          <button className="btn quiet new-session" onClick={() => addSession()} title="新建会话：关联当前画布"><IconPlus size={16} /><span className="btn-label">新建会话</span></button>
          <button className="btn primary" onClick={() => addCanvas()} title="新建画布"><IconPlus size={16} /><span className="btn-label">新建画布</span></button>
        </header>
        <SaveBanner docTitle={(id) => names[id]} />

        <Workspace
          root={root}
          setRoot={setRoot}
          titles={names}
          subtitles={Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.id, titleOf(sessionCanvas(d)) ?? "画布已删除"]] : [])))}
          kinds={Object.fromEntries(docs.map((d) => [d.id, d.kind]))}
          marks={Object.fromEntries(docs.flatMap((d) => (d.kind === "session" ? [[d.id, <SessionMark key={d.id} sessionId={d.sessionId} />]] : [])))}
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
                onScene={(els) => (scenes.current.set(id, els), nested.setScene(id, els), persistCanvas(id))}
              />
            );
          }}
        />

        {canvasDoc && <>
        <Dock
          at={dockAt}
          mode={mode}
          setMode={(m) => (ui.focusPane(canvasDoc.id), setMode(m))}
          selCount={selCount}
          drawerOpen={!!drawers[canvasDoc.id]}
          toggleDrawer={() => setDrawers((d) => ({ ...d, [canvasDoc.id]: !d[canvasDoc.id] }))}
          store={storeFor(canvasDoc.id)}
          onCommentSelection={() => handle?.commentSelection()}
          onReset={() => handle?.reset()}
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
          <motion.div className="toast" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <span>已删除「{removed.kind === "session" ? removed.name : removed.doc.title}」</span>
            <button className="btn sm ghost" onClick={undoRemove}>撤销</button>
            <button className="icon-btn sm muted" aria-label="关闭提示" onClick={() => setRemoved(null)}><IconClose size={14} /></button>
          </motion.div>
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

function Dock({ at, mode, setMode, selCount, drawerOpen, toggleDrawer, store, onCommentSelection, onReset, evalButton }: {
  at: { x: number; bottom: number } | null;
  mode: "browse" | "comment";
  setMode: (m: "browse" | "comment") => void;
  selCount: number;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  store: ThreadStore;
  onCommentSelection: () => void;
  onReset: () => void;
  evalButton: React.ReactNode;
}) {
  const { threads } = useThreads(store);
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <div className="dock" role="toolbar" aria-label="画布工具" style={at ? { left: at.x, bottom: at.bottom } : undefined}>
      <div className="dock-tools">
        {([["browse", IconPointer, "浏览 · V"], ["comment", IconComment, "评论 · C"]] as const).map(([m, Icon, label]) => (
          <button key={m} className="dock-btn" data-on={mode === m} aria-pressed={mode === m} onClick={() => setMode(m)} aria-label={label} title={label}>
            {mode === m && <motion.span layoutId="dock-on" className="dock-on" transition={SPRING} />}
            <Icon size={18} />
          </button>
        ))}
        <button className="dock-btn" disabled={!selCount} onClick={onCommentSelection} aria-label="评论选区" title={selCount ? `评论选中的 ${selCount} 个元素` : "先选中元素"}>
          <IconSelect size={18} />
          {selCount > 1 && <em className="dock-badge">{selCount}</em>}
        </button>
        <button className="dock-btn" data-on={drawerOpen} aria-pressed={drawerOpen} onClick={toggleDrawer} aria-label={`所有评论 · ${open} 条进行中`} title="所有评论">
          {drawerOpen && <motion.span layoutId="dock-drawer" className="dock-on" transition={SPRING} />}
          <IconList size={18} />
          {open > 0 && <em className="dock-badge">{open}</em>}
        </button>
        <span className="dock-sep" />
        <button className="dock-btn" onClick={onReset} aria-label="清空画布（可撤销）" title="清空画布（⌘Z 可撤销）"><IconTrash size={18} /></button>
      </div>
      {evalButton}
    </div>
  );
}

/** Saving problems: a file changed on disk since this page loaded it, or the project server is unreachable. */
function SaveBanner({ docTitle }: { docTitle: (id: string) => string | undefined }) {
  const st = useSyncExternalStore(project.subscribe, project.status);
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
