// One canvas: its own Excalidraw scene, comment threads and drawer.
import { CaptureUpdateAction, DefaultSidebar, Excalidraw, MainMenu, Sidebar, FONT_FAMILY, getCommonBounds, hashElementsVersion } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentLayer, type Draft } from "../comments/CommentLayer";
import { CommentsDrawer } from "../comments/CommentsDrawer";
import { AnimLayer, animHosts } from "../anim/AnimLayer";
import type { AnimScript } from "../anim/script";
import { buildFixture } from "../eval/fixture";
import { maybeInstallLibrary } from "../library/libraryPanel";
import { AssetBrowser } from "../library/AssetBrowser";
import { IconFolder, IconTrash } from "../app/icons";
import { usePrefs } from "../app/prefs";
import { useTheme } from "../app/theme";
import { bbox, byId, live, type El } from "./scene";
import type { ThreadStore } from "../comments/threads";
import { useHighlight } from "../session/ui";
import { PointerLayer } from "../pointer/PointerLayer";
import { childAt, OwnerBreadcrumb, OwnerChildMarkers } from "../nested/NestedLayer";
import { nav } from "../nested/store";
import { WorkstationOverlay } from "../workstation/Overlay";
import { Timeline } from "../workstation/Timeline";
import { useWorkstation } from "../workstation/clock";
import { viewport } from "./viewport";
import { BENCH_BARE } from "../bench/bench";
import { figurePositions } from "../workstation/focus";
import { prefersReducedMotion } from "../workstation/clock";
import { useChrome } from "./useChrome";
import type { Box } from "./clearance";
import { AnimatePresence, motion } from "motion/react";
import { SPRING } from "../comments/motion";

export type CanvasDoc = { id: string; title: string; store: ThreadStore };
export type CanvasViewState = {
  id: string;
  /** Changes whenever an element does (hashElementsVersion): geometry derived from the scene keys on it. */
  version: number;
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
  overlay?: (view: CanvasViewState, chrome: Box[]) => React.ReactNode;
};

export function CanvasView({ doc, mode, drawerOpen, onDrawer, onReady, onSelection, onModeDone, initialElements, onScene, readOnly, onEnterChild, top, overlay }: Props) {
  const enter = (child: string) => (onEnterChild ? onEnterChild(child) : nav.go(doc.id, child));
  const figuresOn = useWorkstation(doc.id);
  const viewPrefs = usePrefs();

  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [view, setView] = useState<CanvasViewState | null>(null);
  // The canvas UI (Excalidraw's panels, our popovers) as boxes: overlays stay clear of it.
  const [layers, setLayers] = useState<HTMLDivElement | null>(null);
  const chrome = useChrome(layers, view && `${view.appState.width}|${view.appState.height}|${Object.keys(view.appState.selectedElementIds ?? {}).join()}`);
  // Parent callbacks are recreated every render; read the latest through a ref so
  // effects and Excalidraw's onChange stay stable.
  const cb = useRef({ onReady, onSelection, onModeDone, onScene });
  cb.current = { onReady, onSelection, onModeDone, onScene };
  const [draft, setDraft] = useState<Draft | null>(null);
  // A resolved pin clicked → the comment list shows it; 「重新钉到…」 → the next element picked.
  const [listFocus, setListFocus] = useState<{ id: string; key: number } | null>(null);
  const [repin, setRepin] = useState<string | null>(null);
  useEffect(() => {
    if (!repin) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setRepin(null));
    addEventListener("keydown", esc, true);
    return () => removeEventListener("keydown", esc, true);
  }, [repin]);
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
    // The 工位视图 moves with the view in the same frame (its frame loop reads this, no React).
    viewport.set(doc.id, { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, width: appState.width, height: appState.height });
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
      setView({ id: doc.id, version: Number(key.split("|")[5]), elements: all, map: byId(all), appState: a });
      cb.current.onSelection(sel.length);
    });
  }, [api, doc.id]);
  // Scrolling from code (scrollToContent: the pointer's edge indicator, "在画布中高亮") does not
  // reach onChange, so the overlays would stay where the view was. Follow the scroll too.
  useEffect(() => {
    if (!api) return;
    return api.onScrollChange(() => onChange(api.getSceneElementsIncludingDeleted() as readonly El[], api.getAppState()));
  }, [api, onChange]);

  const handleRef = useRef<CanvasHandle | null>(null);
  useEffect(() => {
    if (!api) return;
    const h: CanvasHandle = {
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
    };
    handleRef.current = h;
    cb.current.onReady(h);
  }, [api, doc.store]);

  return (
    <div
      className="canvas-view"
      data-theme-resolved={resolved}
      // Excalidraw's hint line only on an empty canvas (or when asked for in ⋯).
      data-hints={viewPrefs.hints || !view || !view.elements.some((e) => !e.isDeleted) || undefined}
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
        ref={setLayers}
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
          <MainMenu>
            <MainMenu.Item icon={<IconTrash size={16} />} onSelect={() => handleRef.current?.reset()}>清空画布（⌘Z 可撤销）</MainMenu.Item>
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        )}
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
      {api && view && !readOnly && !view.elements.some((e) => !e.isDeleted) && <EmptyCanvas onSample={() => api.updateScene({ elements: buildFixture() as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })} />}
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
            onOpenResolved={(id) => (onDrawer(true), setListFocus({ id, key: Date.now() }))}
            repin={repin}
            onRepinned={() => setRepin(null)}
          />
          {!readOnly && <HighlightLayer canvasId={doc.id} view={view} />}
          {readOnly ? overlay?.(view, chrome) : <OwnerChildMarkers view={view} canvasId={doc.id} chrome={chrome} />}
          {!readOnly && <PointerLayer api={api} view={view} chrome={chrome} />}
          {!readOnly && !BENCH_BARE && <WorkstationOverlay view={view} chrome={chrome} figuresOn={figuresOn} />}
        </>
      )}
      </div>
      {!readOnly && !BENCH_BARE && <Timeline onLocate={(runId) => api && locate(api, doc.id, runId)} />}
      </div>
      {api && view && <CommentsDrawer title={doc.title} api={api} store={doc.store} view={view} open={drawerOpen} onClose={() => onDrawer(false)} focusId={listFocus} onRepin={setRepin} />}
    </div>
  );
}

/** A blank canvas (docs/workbench-focus.md state e): the one question — what first. */
function EmptyCanvas({ onSample }: { onSample: () => void }) {
  return (
    <div className="empty-cv" aria-label="空白画布">
      <div className="empty-cv-box">
        <span className="dither-field" aria-hidden />
        <h3>一张空白画布</h3>
        <ol>
          <li><i>1</i><b>画出架构</b>用上面的工具画，或让 agent 画</li>
          <li><i>2</i><b>和 agent 讨论</b>在左边选一个 agent，它会改这张图</li>
          <li><i>3</i><b>让它写代码</b>它读写哪个模块，就站到哪个节点旁</li>
        </ol>
        <button className="btn ghost sm" onClick={onSample}>从示例新建</button>
      </div>
    </div>
  );
}

/**
 * A lane name in the timeline "locates" its agent: this canvas glides (≈420 ms, eased) so the
 * figure sits in the middle, once. The person's own pan / zoom / click stops the glide at once.
 */
function locate(api: ExcalidrawImperativeAPI, canvasId: string, runId: string) {
  const p = figurePositions.get(canvasId, runId);
  if (!p) return;
  const a = api.getAppState();
  const z = a.zoom.value;
  const to = { x: a.width / 2 / z - p.x, y: a.height / 2 / z - (p.y - 30) };
  if (prefersReducedMotion()) return api.updateScene({ appState: { scrollX: to.x, scrollY: to.y } });
  const from = { x: a.scrollX, y: a.scrollY };
  const t0 = performance.now();
  const D = 420;
  let stop = false;
  const cancel = () => (stop = true);
  addEventListener("pointerdown", cancel, { capture: true, once: true });
  addEventListener("wheel", cancel, { capture: true, once: true });
  const step = () => {
    if (stop) return;
    const u = Math.min(1, (performance.now() - t0) / D);
    const e = 1 - (1 - u) ** 3;
    api.updateScene({ appState: { scrollX: from.x + (to.x - from.x) * e, scrollY: from.y + (to.y - from.y) * e } });
    if (u < 1) requestAnimationFrame(step);
    else (removeEventListener("pointerdown", cancel, { capture: true }), removeEventListener("wheel", cancel, { capture: true }));
  };
  requestAnimationFrame(step);
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
