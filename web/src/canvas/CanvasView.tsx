// One canvas: its own Excalidraw scene, comment threads and drawer.
import { CaptureUpdateAction, DefaultSidebar, Excalidraw, Sidebar, FONT_FAMILY, getCommonBounds, hashElementsVersion } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentLayer, type Draft } from "../comments/CommentLayer";
import { CommentsDrawer } from "../comments/CommentsDrawer";
import { AnimLayer, animHosts } from "../anim/AnimLayer";
import type { AnimScript } from "../anim/script";
import { buildFixture } from "../eval/fixture";
import { maybeInstallLibrary } from "../library/libraryPanel";
import { AssetBrowser } from "../library/AssetBrowser";
import { IconFolder } from "../app/icons";
import { useTheme } from "../app/theme";
import { bbox, byId, live, type El } from "./scene";
import type { ThreadStore } from "../comments/threads";
import { useHighlight } from "../session/ui";
import { PointerLayer } from "../pointer/PointerLayer";
import { childAt, NodeChildMenu, OwnerBreadcrumb, OwnerChildMarkers } from "../nested/NestedLayer";
import { nav } from "../nested/store";
import { TimelinePanel, Workers, WorkstationToggle } from "../workstation/Workstation";
import { useWorkstation } from "../workstation/clock";
import { AnimatePresence, motion } from "motion/react";
import { SPRING } from "../comments/motion";

export type CanvasDoc = { id: string; title: string; store: ThreadStore };
export type CanvasViewState = {
  id: string;
  elements: readonly El[];
  map: Map<string, El>;
  appState: Pick<AppState, "scrollX" | "scrollY" | "zoom" | "width" | "height" | "selectedElementIds">;
};
/** What the app shell (dock, eval) can do with a canvas. */
export type CanvasHandle = {
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  commentSelection: () => void;
  reset: () => void;
  /** Discard the unsent comment, if any (Esc). */
  dismissDraft: () => void;
  /** Mount an animation script as a titled region with a player. */
  animate: (script: AnimScript) => void;
};

type Props = {
  doc: CanvasDoc;
  mode: "browse" | "comment";
  drawerOpen: boolean;
  onDrawer: (open: boolean) => void;
  onReady: (h: CanvasHandle) => void;
  onSelection: (count: number) => void;
  onModeDone: () => void;
  /** Persisted scene to start from (fixture otherwise). */
  initialElements?: readonly El[];
  /** Called when the scene's elements change (persistence). */
  onScene?: (elements: readonly El[]) => void;
  /** Share guests: look and comment only — no editing, asset library, animations or progress pointer. */
  readOnly?: boolean;
  /** Step into a node's child canvas (default: the app shell's navigation). */
  onEnterChild?: (child: string) => void;
  /** Share guests bring their own breadcrumb and child markers (the owner's come from the workspace). */
  top?: React.ReactNode;
  overlay?: (view: CanvasViewState) => React.ReactNode;
};

export function CanvasView({ doc, mode, drawerOpen, onDrawer, onReady, onSelection, onModeDone, initialElements, onScene, readOnly, onEnterChild, top, overlay }: Props) {
  const enter = (child: string) => (onEnterChild ? onEnterChild(child) : nav.go(doc.id, child));
  const workstation = useWorkstation(doc.id) && !readOnly;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [view, setView] = useState<CanvasViewState | null>(null);
  // Parent callbacks are recreated every render; read the latest through a ref so
  // effects and Excalidraw's onChange stay stable.
  const cb = useRef({ onReady, onSelection, onModeDone, onScene });
  cb.current = { onReady, onSelection, onModeDone, onScene };
  const [draft, setDraft] = useState<Draft | null>(null);
  // komo semantics: clicking away from a draft that has text parks it; the next
  // comment-mode entry (C) restores it. Esc / ✕ discard. Empty drafts just vanish.
  const parked = useRef<Draft | null>(null);
  const [hasParked, setHasParked] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dismissDraft = (park: boolean) => {
    const d = draftRef.current;
    if (!d) return;
    parked.current = park && d.text.trim() ? d : null;
    setHasParked(!!parked.current);
    setDraft(null);
  };
  useEffect(() => {
    if (mode !== "comment" || !parked.current) return;
    setDraft(parked.current);
    parked.current = null;
    setHasParked(false);
    cb.current.onModeDone();
  }, [mode]);
  // Excalidraw draws on a canvas and can't read CSS, so the scene background comes from the
  // --canvas-bg token (chosen so that in dark mode, after Excalidraw's invert filter, it equals --bg).
  const { resolved } = useTheme();
  const initialData = useMemo(
    () => ({
      elements: initialElements ? [...initialElements] : buildFixture(),
      appState: { viewBackgroundColor: canvasBg(), currentItemRoughness: 0, currentItemFontFamily: FONT_FAMILY.Helvetica },
    }),
    [],
  );
  useEffect(() => {
    api?.updateScene({ appState: { viewBackgroundColor: canvasBg() }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, resolved]);

  // Excalidraw fires onChange on every pointer move; coalesce to one view update per frame.
  const pending = useRef<{ elements: readonly El[]; appState: AppState } | null>(null);
  const lastKey = useRef("");
  const fitted = useRef(false);
  const lastSize = useRef<{ w: number; h: number } | null>(null);
  const onChange = useCallback((elements: readonly El[], appState: AppState) => {
    const first = !pending.current;
    pending.current = { elements, appState };
    if (!first) return;
    requestAnimationFrame(() => {
      const p = pending.current!;
      pending.current = null;
      if (!api) return;
      if (!fitted.current && p.appState.width > 0) {
        fitted.current = true;
        lastSize.current = { w: p.appState.width, h: p.appState.height };
        fit(api);
        return;
      }
      const a = p.appState;
      if (!readOnly) maybeInstallLibrary(api, a.openSidebar);
      // Keep the view centred while the pane glides/resizes (Excalidraw anchors top-left).
      const prev = lastSize.current;
      lastSize.current = { w: a.width, h: a.height };
      if (prev && (prev.w !== a.width || prev.h !== a.height)) {
        api.updateScene({ appState: { scrollX: a.scrollX + (a.width - prev.w) / 2 / a.zoom.value, scrollY: a.scrollY + (a.height - prev.h) / 2 / a.zoom.value } });
        return;
      }
      const sel = selectedContainers(a.selectedElementIds, byId(p.elements));
      const key = [a.scrollX, a.scrollY, a.zoom.value, a.width, a.height, hashElementsVersion(p.elements), sel.join()].join("|");
      if (key === lastKey.current) return;
      if (key.split("|")[5] !== lastKey.current.split("|")[5]) cb.current.onScene?.(p.elements);
      lastKey.current = key;
      const all = api.getSceneElementsIncludingDeleted();
      setView({ id: doc.id, elements: all, map: byId(all), appState: a });
      cb.current.onSelection(sel.length);
    });
  }, [api, doc.id]);

  useEffect(() => {
    if (!api) return;
    cb.current.onReady({
      api,
      store: doc.store,
      commentSelection() {
        const a = api.getAppState();
        const map = byId(api.getSceneElementsIncludingDeleted());
        const sel = selectedContainers(a.selectedElementIds, map);
        if (!sel.length) return;
        // The pin sits on the top-right corner of the right-most selected element.
        const right = (id: string) => { const b = bbox(map.get(id)!); return b.x + b.width; };
        const ids = [...sel].sort((p, q) => right(q) - right(p));
        const b = bbox(map.get(ids[0])!);
        doc.store.close();
        setDraft({ anchor: { ids, rel: { x: 1, y: 0 }, last: { x: b.x + b.width, y: b.y } }, text: "" });
        api.updateScene({ appState: { selectedElementIds: {} } });
      },
      dismissDraft: () => dismissDraft(false),
      animate: (script) => animHosts.get(api)?.(script),
      // Clear to a blank canvas as one undoable step (⌘Z brings it back). Comment threads stay;
      // their anchors show as deleted, the same as deleting those elements by hand.
      reset() {
        const cleared = api.getSceneElements().map((el) => ({ ...el, isDeleted: true, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }));
        api.updateScene({ elements: cleared, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        setDraft(null);
        parked.current = null;
        setHasParked(false);
      },
    });
  }, [api, doc.store]);

  return (
    <div
      className="canvas-view"
      data-theme-resolved={resolved}
      onPointerDownCapture={(e) => {
        // komo-style: interacting with the canvas outside a card closes the open thread
        // and takes back an unsent pin (parked if it has text).
        if ((e.target as HTMLElement).closest(".tcard, .pin, .drawer, .ptr-ui, .undo-toast, .nest-mark, .nest-crumbs, .ws-ui")) return;
        doc.store.close();
        dismissDraft(true);
      }}
    >
      <div className="canvas-stage">
      {readOnly ? top : <OwnerBreadcrumb canvasId={doc.id} />}
      <div
        className="canvas-layers"
        onDoubleClickCapture={(e) => {
          // Double-click on a node that opens a child canvas enters it (text editing stays on Enter).
          if (!view || (e.target as HTMLElement).closest(".ptr-ui, .nest-mark, .tcard, .pin")) return;
          const r = e.currentTarget.getBoundingClientRect();
          const child = childAt(view, e.clientX - r.left, e.clientY - r.top);
          if (!child) return;
          e.stopPropagation();
          e.preventDefault();
          enter(child);
        }}
      >
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange as never}
        theme={resolved}
        langCode="zh-CN"
        viewModeEnabled={readOnly}
        onLinkOpen={(el, ev) => {
          // A link written as `?canvas=<id>` (or `#canvas=<id>`) opens that canvas in place.
          const m = /[?#&]canvas=([A-Za-z0-9._-]+)/.exec(el.link ?? "");
          if (!m) return;
          ev.preventDefault();
          enter(m[1]);
        }}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveAsImage: false, ...(readOnly && { clearCanvas: false, toggleTheme: false, saveToActiveFile: false }) } }}
      >
        {!readOnly && (
          <DefaultSidebar>
            <DefaultSidebar.TabTriggers>
              <Sidebar.TabTrigger tab="agora-assets" title="内置素材库"><IconFolder size={16} /></Sidebar.TabTrigger>
            </DefaultSidebar.TabTriggers>
            <Sidebar.Tab tab="agora-assets">{api && <AssetBrowser api={api} />}</Sidebar.Tab>
          </DefaultSidebar>
        )}
      </Excalidraw>
      {api && !readOnly && <AnimLayer api={api} />}
      {hasParked && !draft && <div className="parked-hint">有一条未发送的评论 · 按 C 恢复</div>}
      {api && view && (
        <>
          <CommentLayer
            api={api}
            store={doc.store}
            view={view}
            mode={mode}
            draft={draft}
            setDraft={(d) => {
              setDraft(d);
              if (d) onModeDone();
            }}
            onCreated={onModeDone}
          />
          {!readOnly && <HighlightLayer canvasId={doc.id} view={view} />}
          {readOnly ? overlay?.(view) : <OwnerChildMarkers view={view} canvasId={doc.id} />}
          {!readOnly && <PointerLayer api={api} view={view} />}
          {!readOnly && <NodeChildMenu api={api} view={view} canvasId={doc.id} />}
          {workstation && <Workers view={view} />}
        </>
      )}
      {!readOnly && api && <WorkstationToggle canvasId={doc.id} />}
      </div>
      {workstation && <TimelinePanel canvasId={doc.id} view={view} />}
      </div>
      {api && view && <CommentsDrawer title={doc.title} api={api} store={doc.store} view={view} open={drawerOpen} onClose={() => onDrawer(false)} />}
    </div>
  );
}

const canvasBg = () => getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "white";

function selectedContainers(selected: Record<string, boolean>, map: Map<string, El>) {
  const ids = Object.keys(selected).map((id) => {
    const e = map.get(id);
    return e?.type === "text" && e.containerId ? e.containerId : id;
  });
  return [...new Set(ids)].filter((id) => live(map.get(id)) && map.get(id)!.type !== "text");
}

/** Centre the diagram in the canvas at zoom 1 (or smaller when the pane is narrow). */
export function fit(api: ExcalidrawImperativeAPI) {
  const [x0, y0, x1, y1] = getCommonBounds(api.getSceneElements());
  const { width, height } = api.getAppState();
  const zoom = Math.max(0.3, Math.min(1, (width - 48) / (x1 - x0), (height - 120) / (y1 - y0)));
  api.updateScene({
    appState: {
      zoom: { value: zoom as never },
      scrollX: width / 2 / zoom - (x0 + x1) / 2,
      scrollY: height / 2 / zoom - (y0 + y1) / 2,
    },
  });
}

/** Outlines the elements a hovered session step touched. */
function HighlightLayer({ canvasId, view }: { canvasId: string; view: CanvasViewState }) {
  const hl = useHighlight();
  const a = view.appState;
  const els = hl?.canvasId === canvasId ? hl.ids.map((id) => view.map.get(id)).filter(live) : [];
  return (
    <div className="hl-layer">
      <AnimatePresence>
        {els.map((e) => {
          const b = bbox(e);
          return (
            <motion.span
              key={e.id}
              className="hl-box"
              initial={{ opacity: 0, scale: 1.08 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={SPRING}
              style={{ left: (b.x + a.scrollX) * a.zoom.value - 6, top: (b.y + a.scrollY) * a.zoom.value - 6, width: b.width * a.zoom.value + 12, height: b.height * a.zoom.value + 12 }}
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
}
