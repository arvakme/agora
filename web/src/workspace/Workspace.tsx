// Trellis-style window manager (own implementation, MIT with this repo): tab groups in a split tree, two columns
// by default (./twoColumns.ts). Drag a tab into a column to make it a tab there (no drop ever cuts a new column),
// drag sashes to resize.
// Canvases live in one flat layer keyed by id, so moving a tab never remounts Excalidraw;
// they glide to their new rect via CSS transitions.
import { useDragGuard } from "../app/dragGuard";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SPRING } from "../comments/motion";
import { IconClose, IconFolder, IconLayers, IconMessage, IconPencil, IconPlus, IconTrash } from "../app/icons";
import { activate, equalize, groupOf, groups, layout, resize, type Node, type Rect, type Sash } from "./layout";
import { dropTab } from "./twoColumns";
import { groupKind, plusMenu, type NewWhat } from "./model";

// Panes are flush: a 1px gap over the hairline-coloured workspace is the divider (D13).
const GAP = 1, PAD = 0, HEADER = 36, MIN_PANE = 220;

/** A drop always lands in an existing column (./twoColumns.ts): over the tab bar between its tabs, over the body as its last tab. */
type Target = { groupId: string; index?: number; preview: Rect };
type Drag = { tab: string; x: number; y: number; ox: number; oy: number; active: boolean; target: Target | null };

const ITEMS: Record<NewWhat, { icon: ReactNode; label: string }> = {
  canvas: { icon: <IconPlus size={14} />, label: "新建画布" },
  session: { icon: <IconMessage size={14} />, label: "新建会话" },
  sample: { icon: <IconLayers size={14} />, label: "从示例新建画布" },
  open: { icon: <IconFolder size={14} />, label: "打开画布" },
};
type Props = {
  root: Node;
  setRoot: (n: Node) => void;
  titles: Record<string, string>;
  /** Secondary text after a tab's title (a session's linked canvas). */
  subtitles?: Record<string, string>;
  /** Pane kind per tab: the tab's mark, and what a group's「+」creates. */
  kinds?: Record<string, "canvas" | "session">;
  /** A tab's own mark in place of the dot (a session's agent avatar). */
  marks?: Record<string, ReactNode>;
  focused: string;
  onFocus: (tab: string) => void;
  /** 「+」: session groups get a session; canvas and mixed groups offer a menu (新建 / 从示例 / 打开已有的). `at` is the menu item's screen rect (for 打开画布). */
  onNew: (groupId: string, what: NewWhat, at?: DOMRect) => void;
  /** How many canvases exist (the 「打开画布（N）」 item). */
  canvasCount?: number;
  /** Close only hides the tab; delete is a separate, confirmed action. */
  onClose: (tab: string) => void;
  onDelete: (tab: string) => void;
  /** Body of a group with no tabs (only the last remaining group can be empty). */
  renderEmpty: (groupId: string) => ReactNode;
  /** Tab being renamed (new canvases start here). */
  editing: string | null;
  setEditing: (tab: string | null) => void;
  onRename: (tab: string, title: string) => void;
  onSettled: () => void;
  renderCanvas: (id: string) => ReactNode;
};

export function Workspace({ root, setRoot, titles, subtitles = {}, kinds = {}, marks = {}, focused, onFocus, onNew, canvasCount = 0, onClose, onDelete, renderEmpty, editing, setEditing, onRename, onSettled, renderCanvas }: Props) {
  const [menu, setMenu] = useState<{ tab: string; x: number; y: number } | { group: string; x: number; y: number; kind: "canvas" | "mixed" } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const guard = useDragGuard();
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Excalidraw caches its DOM offset; refresh once panes have finished gliding.
  useEffect(() => {
    const t = setTimeout(onSettled, 460);
    return () => clearTimeout(t);
  }, [root, size, onSettled]);

  const { rects, sashes } = layout(root, { x: PAD, y: PAD, w: size.w - PAD * 2, h: size.h - PAD * 2 }, GAP);
  const all = groups(root);
  const focusedGroup = groupOf(root, focused)?.id;
  const kindOf = (t: string) => kinds[t];
  /** 「+」 or a double-click on the tab bar: a session group gets a new session; canvas and mixed groups a small menu (the one place to create or open canvases). */
  const plus = (groupId: string, anchor: HTMLElement) => {
    const g = all.find((g) => g.id === groupId)!;
    const kind = groupKind(g.tabs, kindOf);
    if (kind === "session") return onNew(groupId, "session");
    const box = ref.current!.getBoundingClientRect(), b = anchor.getBoundingClientRect();
    setMenu({ group: groupId, kind, x: Math.min(b.left - box.left, box.width - 200), y: b.bottom - box.top + 4 });
  };
  const plusLabel = (tabs: string[]) => ({ canvas: "新建或打开画布", session: "新建会话", mixed: "新建…" })[groupKind(tabs, kindOf)];

  const targetAt = (x: number, y: number): Target | null => {
    const g = all.find((g) => within(rects.get(g.id)!, x, y));
    if (!g) return null;
    const r = rects.get(g.id)!;
    if (y < r.y + HEADER) {
      const tabs = [...ref.current!.querySelectorAll<HTMLElement>(`[data-group="${g.id}"] .wm-tab`)];
      const box = ref.current!.getBoundingClientRect();
      const index = tabs.filter((el) => { const b = el.getBoundingClientRect(); return b.left - box.left + b.width / 2 < x; }).length;
      return { groupId: g.id, index, preview: r };
    }
    return { groupId: g.id, preview: r };
  };

  const onTabDown = (e: React.PointerEvent, tab: string) => {
    if ((e.target as HTMLElement).closest(".wm-tab-close, .wm-tab-input") || e.button !== 0) return;
    // a tab held down: no text selected, the pointer is the tab's; Esc, a lost pointer or a blur gives the drag up (nothing is moved)
    guard(e, { cursor: "grabbing", onEnd: (why) => why !== "up" && setDrag(null) });
    const box = ref.current!.getBoundingClientRect();
    const t = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({ tab, x: e.clientX - box.left, y: e.clientY - box.top, ox: e.clientX - t.left, oy: e.clientY - t.top, active: false, target: null });
  };
  const onTabMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const box = ref.current!.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const active = drag.active || Math.hypot(x - drag.x, y - drag.y) > 5;
    setDrag({ ...drag, x, y, active, target: active ? targetAt(x, y) : null });
  };
  const onTabUp = () => {
    if (!drag) return;
    const g = groupOf(root, drag.tab)!;
    if (!drag.active) setRoot(activate(root, g.id, drag.tab));
    else if (drag.target) setRoot(dropTab(root, drag.tab, drag.target.groupId, drag.target.index));
    onFocus(drag.tab);
    setDrag(null);
  };

  const onSashDown = (e: React.PointerEvent, s: Sash) => {
    let last = s.dir === "row" ? e.clientX : e.clientY;
    let current = root;
    setResizing(true);
    const end = guard(e, { cursor: s.dir === "row" ? "col-resize" : "row-resize", onEnd: () => (setResizing(false), window.removeEventListener("pointermove", move)) });
    const move = (ev: PointerEvent) => {
      const now = s.dir === "row" ? ev.clientX : ev.clientY;
      current = resize(current, s.splitId, s.index, (now - last) / s.span, MIN_PANE / s.span);
      last = now;
      setRoot(current);
      onSettled();
    };
    window.addEventListener("pointermove", move);
    void end;
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [menu]);

  const wasShown = useRef(new Set<string>());
  useEffect(() => {
    wasShown.current = new Set(all.map((g) => g.active));
  });
  const body = (r: Rect): Rect => ({ x: r.x, y: r.y + HEADER, w: r.w, h: r.h - HEADER });
  const tabIds = all.flatMap((g) => g.tabs);

  return (
    <div className="ws" ref={ref} data-dragging={!!drag?.active} data-resizing={resizing} data-multi={all.length > 1}>
      {/* Mount panes only once measured, so they start at their real size instead of gliding in from 0. */}
      {size.w > 0 && <>
      <LayoutGroup>
        {all.map((g) => {
          const r = rects.get(g.id)!;
          return (
            <section key={g.id} className="wm-group" data-group={g.id} data-focused={g.id === focusedGroup} data-empty={!g.tabs.length} style={box(r)}>
              <div className="wm-head" role="tablist" onDoubleClick={(e) => e.target === e.currentTarget && plus(g.id, e.currentTarget.querySelector(".wm-add")!)}>
                {g.tabs.map((t) => (
                  <motion.div
                    layout="position"
                    layoutId={`tab-${t}`}
                    transition={SPRING}
                    key={t}
                    className="wm-tab"
                    role="tab"
                    aria-selected={g.active === t}
                    data-active={g.active === t}
                    data-dragging={drag?.active && drag.tab === t}
                    data-kind={kinds[t] ?? "canvas"}
                    onPointerDown={(e) => onTabDown(e, t)}
                    onPointerMove={onTabMove}
                    onPointerUp={onTabUp}
                    onPointerCancel={() => setDrag(null)}
                    onDoubleClick={() => setEditing(t)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const box = ref.current!.getBoundingClientRect();
                      setMenu({ tab: t, x: e.clientX - box.left, y: e.clientY - box.top });
                    }}
                  >
                    {marks[t] ?? <span className="wm-tab-dot" />}
                    {editing === t ? (
                      <TitleInput value={titles[t]} label={kinds[t] === "session" ? "会话名称" : "画布名称"} onDone={(v) => (v !== null && onRename(t, v), setEditing(null))} />
                    ) : (
                      <span className="wm-tab-title" title={subtitles[t] ? `${titles[t]} · 关联画布：${subtitles[t]}（双击重命名）` : "双击重命名"}>
                        {titles[t]}
                        {subtitles[t] && <span className="wm-tab-sub">{subtitles[t]}</span>}
                      </span>
                    )}
                    <button className="wm-tab-close" aria-label={`关闭 ${titles[t]}`} title="关闭（不会删除）" onClick={() => onClose(t)}><IconClose size={14} /></button>
                    {g.active === t && <motion.span layoutId={`tab-ind-${g.id}`} className="wm-tab-ind" transition={SPRING} />}
                  </motion.div>
                ))}
                <button className="wm-add" onClick={(e) => plus(g.id, e.currentTarget)} aria-label={plusLabel(g.tabs)} title={plusLabel(g.tabs)}><IconPlus size={16} /></button>
              </div>
            </section>
          );
        })}
      </LayoutGroup>
      {all.filter((g) => !g.tabs.length).map((g) => (
        <div key={`empty-${g.id}`} className="wm-slot" style={box(body(rects.get(g.id)!))}>{renderEmpty(g.id)}</div>
      ))}
      {tabIds.map((t) => {
        const g = groupOf(root, t)!;
        const shown = g.active === t;
        // Panes that were already on screen glide to their new rect; panes that just became
        // visible appear in place (gliding from a stale rect would sweep across other panes).
        const entering = shown && !wasShown.current.has(t);
        return (
          <div key={t} className="wm-slot" data-pane={t} data-hidden={!shown} data-entering={entering} style={box(body(rects.get(g.id)!))} onPointerDownCapture={() => t !== focused && onFocus(t)}>
            {renderCanvas(t)}
          </div>
        );
      })}
      {sashes.map((s) => (
        <div
          key={`${s.splitId}-${s.index}`}
          className="wm-sash"
          data-dir={s.dir}
          style={box(s.rect)}
          onPointerDown={(e) => onSashDown(e, s)}
          onDoubleClick={() => setRoot(equalize(root, s.splitId))}
          role="separator"
          aria-orientation={s.dir === "row" ? "vertical" : "horizontal"}
        />
      ))}
      <AnimatePresence>
        {menu && (
          <motion.div
            className="menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
            transition={SPRING}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {"group" in menu ? (
              <>
                {(plusMenu(menu.kind) ?? []).map((what, i) => (
                  <Fragment key={what}>
                    {what === "open" && <hr />}
                    <button role="menuitem" autoFocus={i === 0} onClick={(e) => (onNew(menu.group, what, what === "open" ? e.currentTarget.getBoundingClientRect() : undefined), setMenu(null))}>
                      {ITEMS[what].icon}{ITEMS[what].label}{what === "open" && <em className="menu-count">{canvasCount}</em>}
                    </button>
                  </Fragment>
                ))}
              </>
            ) : (
              <>
                <button role="menuitem" onClick={() => (setEditing(menu.tab), setMenu(null))}><IconPencil size={14} />重命名<kbd>双击</kbd></button>
                <button role="menuitem" onClick={() => (onClose(menu.tab), setMenu(null))}><IconClose size={14} />关闭</button>
                <button role="menuitem" className="danger" onClick={() => (onDelete(menu.tab), setMenu(null))}><IconTrash size={14} />删除…</button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {menu && <div className="menu-scrim" onPointerDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />}
      {drag?.active && (
        <>
          {drag.target && <div className="wm-drop" style={box(drag.target.preview)} />}
          <div className="wm-ghost" style={{ transform: `translate3d(${drag.x - drag.ox}px, ${drag.y - drag.oy}px, 0)` }}>
            <span className="wm-tab-dot" /> {titles[drag.tab]}
            <span className="wm-ghost-body" />
          </div>
        </>
      )}
      </>}
    </div>
  );
}

const within = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const box = (r: Rect) => ({ left: r.x, top: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h) });

/** In-place tab title editor: Enter / blur saves, Esc cancels, blank falls back to the old name. */
function TitleInput({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v === null || !v.trim() ? null : v.trim());
  };
  return (
    <input
      className="wm-tab-input"
      defaultValue={value}
      autoFocus
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
