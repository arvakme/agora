// What the floating shell of the session panel and the comment list share as components (the rules are in ./floatShell.ts, web/docs/workstation.md §15): each shell's own
// state kept per browser, the gestures (drag the title bar, eight resize handles, the bar's side and top handles), the title bars, the resize handles, the rail tab a folded
// card leaves at the window's right edge and the pill a folded bar leaves beside the 「浏览 / 评论」 bar. The shell is a container only: what is in it is the same component
// in every form, so nothing in it is lost when the form changes.
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as RKeyEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { AgentAvatar } from "../session/AgentAvatar";
import type { AgentKind } from "../session/agents";
import type { StatusLine } from "../session/floatStatus";
import { useDragGuard } from "./dragGuard";
import {
  applySnap, type Bar, type Box, cycleWidth, dragBy, floatFocus, type Handle, HANDLES, keyMove, loadBar, loadShell, mayDrag, RAIL_W, resizeBar, resizeBy, saveBar, saveShell, shouldDock, type Shell, type ShellName,
} from "./floatShell";

type Size = { w: number; h: number };

/** A shell's own state, per browser. `set(s, false)` while a gesture is under way (letting go keeps it). */
export function useShell(name: ShellName): readonly [Shell, (s: Shell, keep?: boolean) => void] {
  const [shell, setShell] = useState(() => loadShell(name));
  const set = useCallback((s: Shell, keep = true) => (setShell(s), keep && saveShell(name, s)), [name]);
  return [shell, set];
}
/** The bottom bar's own state, per browser. */
export function useBar(): readonly [Bar, (b: Bar, keep?: boolean) => void] {
  const [bar, setBar] = useState(() => loadBar());
  const set = useCallback((b: Bar, keep = true) => (setBar(b), keep && saveBar(b)), []);
  return [bar, set];
}

/** Which card is open now ("session" / "comments" / neither). */
export const useFloatFocus = () => useSyncExternalStore(floatFocus.subscribe, floatFocus.get);
/** Where a shell's rail tab is (undefined: it has none now). */
export const useRail = (name: ShellName) => useSyncExternalStore(floatFocus.subscribe, () => floatFocus.rail(name));

/** Where a shell's open card is, in the canvas body's frame (undefined: none is up). */
export const useCard = (name: ShellName) => useSyncExternalStore(floatFocus.subscribe, () => floatFocus.card(name));

/** The card claims "open" while it is expanded and lets go when it folds, closes or goes away; the other card, if it is open too, waits as its rail tab until then. */
export function useClaim(name: ShellName, expanded: boolean) {
  useEffect(() => {
    if (!expanded) return;
    floatFocus.set(name);
    return () => void (floatFocus.get() === name && floatFocus.set(null));
  }, [name, expanded]);
  return useFloatFocus();
}

const CURSOR: Record<Handle, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** What the card shows of a gesture under way: the snap it would make on letting go, and whether letting go would dock it. */
export type Live = { kind: "move" | "resize"; snap: "left" | "right" | null; dock: boolean } | null;

/**
 * The gestures on a card: `head` for its title bar (drag by the empty part, double-click cycles the width, Alt+arrows move, Alt+Shift+arrows resize) and `handle(h)` for each of the
 * eight resize handles. The drag itself is held by ./dragGuard.ts (no selection, the pointer is the handle's); Esc or a lost pointer puts the card back where it was; letting go keeps
 * it (snapped to the edge it is near; at the window's right edge: docked).
 */
export function useShellGestures(o: { shell: Shell; set: (s: Shell, keep?: boolean) => void; pane: Size; kind: ShellName; onDock?: () => void; onFold?: () => void }) {
  const guard = useDragGuard();
  const latest = useRef(o);
  latest.current = o;
  const at = useRef<{ x: number; y: number; from: Shell; mode: "move" | Handle } | null>(null);
  const [live, setLive] = useState<Live>(null);
  /** When a drag was last given up (Esc, a lost pointer): the same Esc must not also fold the card. */
  const gaveUp = useRef(0);
  const begin = (mode: "move" | Handle, e: RPointerEvent) => {
    at.current = { x: e.clientX, y: e.clientY, from: latest.current.shell, mode };
    setLive({ kind: mode === "move" ? "move" : "resize", snap: null, dock: false });
    guard(e, {
      cursor: mode === "move" ? "grabbing" : CURSOR[mode],
      onEnd: (why) => {
        if (why === "up") return;
        const a = at.current;
        at.current = null;
        gaveUp.current = performance.now();
        setLive(null);
        if (a) latest.current.set(a.from, false);
      },
    });
  };
  const result = (e: RPointerEvent) => {
    const a = at.current!;
    const { pane, kind } = latest.current;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    if (a.mode === "move") {
      const d = dragBy(a.from, dx, dy, pane, kind);
      return { shell: d.shell, snap: d.snap, dock: !!latest.current.onDock && shouldDock(e.clientX, innerWidth) };
    }
    return { shell: resizeBy(a.from, a.mode, dx, dy, pane, kind), snap: null, dock: false };
  };
  const track = (e: RPointerEvent) => {
    if (!at.current) return;
    const r = result(e);
    latest.current.set(r.shell, false);
    setLive({ kind: at.current.mode === "move" ? "move" : "resize", snap: r.snap, dock: r.dock });
  };
  const drop = (e: RPointerEvent) => {
    const a = at.current;
    if (!a) return;
    const r = result(e);
    at.current = null;
    setLive(null);
    if (r.dock) {
      latest.current.set(a.from, false);
      latest.current.onDock?.();
    } else latest.current.set(applySnap(r.shell, r.snap, latest.current.pane, latest.current.kind));
  };
  const cancel = () => {
    const a = at.current;
    at.current = null;
    setLive(null);
    if (a) latest.current.set(a.from, false);
  };
  return {
    live,
    head: {
      onPointerDown: (e: RPointerEvent) => void (e.button === 0 && mayDrag(e) && begin("move", e)),
      onPointerMove: track,
      onPointerUp: drop,
      onPointerCancel: cancel,
      onDoubleClick: (e: React.MouseEvent) => void (mayDrag(e) && latest.current.set(cycleWidth(latest.current.shell, latest.current.pane, latest.current.kind))),
      onKeyDown: (e: RKeyEvent) => {
        if (e.key === "Escape" && latest.current.onFold) return void (e.preventDefault(), e.stopPropagation(), !at.current && performance.now() - gaveUp.current > 200 && latest.current.onFold());
        const next = keyMove(latest.current.shell, e.key, { alt: e.altKey, shift: e.shiftKey }, latest.current.pane, latest.current.kind);
        if (next) (e.preventDefault(), latest.current.set(next));
      },
    },
    handle: (h: Handle) => ({ onPointerDown: (e: RPointerEvent) => void (e.button === 0 && begin(h, e)), onPointerMove: track, onPointerUp: drop, onPointerCancel: cancel }),
  };
}

/** The bar's gestures: the side handles change its width about the centre, the top handle pulls it up to a half screen (or sets the half screen's height). */
export function useBarGestures(o: { bar: Bar; set: (b: Bar, keep?: boolean) => void; pane: Size; dock: Box }) {
  const guard = useDragGuard();
  const latest = useRef(o);
  latest.current = o;
  const at = useRef<{ x: number; y: number; from: Bar; edge: "e" | "w" | "n" } | null>(null);
  const [active, setActive] = useState(false);
  const next = (e: RPointerEvent) => {
    const a = at.current!;
    const b = resizeBar(a.from, a.edge, e.clientX - a.x, e.clientY - a.y, latest.current.pane, latest.current.dock);
    // pulled up from the strip: it becomes the half screen once it is clearly pulled (a click on the handle does nothing)
    return a.edge === "n" && !a.from.expanded ? (b.height! > 120 ? { ...b, expanded: true } : a.from) : b;
  };
  const begin = (edge: "e" | "w" | "n", e: RPointerEvent) => {
    at.current = { x: e.clientX, y: e.clientY, from: latest.current.bar, edge };
    setActive(true);
    guard(e, {
      cursor: edge === "n" ? "ns-resize" : "ew-resize",
      onEnd: (why) => {
        if (why === "up") return;
        const a = at.current;
        at.current = null;
        setActive(false);
        if (a) latest.current.set(a.from, false);
      },
    });
  };
  const track = (e: RPointerEvent) => void (at.current && latest.current.set(next(e), false));
  const drop = (e: RPointerEvent) => {
    if (!at.current) return;
    const b = next(e);
    at.current = null;
    setActive(false);
    latest.current.set(b);
  };
  return { active, handle: (edge: "e" | "w" | "n") => ({ onPointerDown: (e: RPointerEvent) => void (e.button === 0 && begin(edge, e)), onPointerMove: track, onPointerUp: drop, onPointerCancel: drop }) };
}

/** The eight resize handles of a card: 8 px hit areas straddling its edges (a purple line shows near an edge, a dot at a corner; the cursor says which way). */
export function ResizeHandles({ handle }: { handle: (h: Handle) => Record<string, unknown> }) {
  return (
    <>
      {HANDLES.map((h) => (
        <div key={h} className="float-h" data-h={h} aria-hidden {...handle(h)} />
      ))}
    </>
  );
}

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
const GripIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    {[7, 12, 17].flatMap((y) => [9, 15].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.5" />))}
  </svg>
);
const DockIcon = () => (
  <Svg>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M14 5v14" />
  </Svg>
);
const FoldIcon = () => (
  <Svg>
    <path d="M6 12h12" />
  </Svg>
);

/** The agent's avatar, or a plain disc for a session that has not picked its agent yet. */
export function Avatar({ kind, size }: { kind?: AgentKind; size: 20 | 26 | 32 }) {
  return kind ? <AgentAvatar kind={kind} size={size} label /> : <span className="agent-avatar" style={{ "--av": `${size}px` } as React.CSSProperties} aria-hidden><i className="rail-blank" /></span>;
}

export type SessionItem = { id: string; title: string; mark: ReactNode };

/** The sessions of the panel in one menu (not laid out as tabs): pick one, or open a new one. */
function SessionMenu({ items, active, onPick, onNew }: { items: SessionItem[]; active: string; onPick: (id: string) => void; onNew: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !btn.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setAt(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setAt(null));
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", key, true);
    return () => (removeEventListener("pointerdown", away, true), removeEventListener("keydown", key, true));
  }, [open]);
  const cur = items.find((i) => i.id === active) ?? items[0];
  return (
    <div className="float-pick" data-nodrag>
      <button ref={btn} className="float-pick-btn" aria-haspopup="menu" aria-expanded={open} title={items.length > 1 ? "切换会话" : cur?.title} onClick={() => setAt(open ? null : (() => { const r = btn.current!.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })())}>
        {cur?.mark}
        <span className="float-pick-name">{cur?.title}</span>
        <Svg><path d="M7 10l5 5 5-5" /></Svg>
      </button>
      {/* the pane is drawn over the title bar's box, so the menu is in the page's top layer, not in the card */}
      {at && createPortal(
        <div ref={pop} className="menu float-pick-menu" role="menu" style={{ left: at.x, top: at.y }}>
          {items.map((i) => (
            <button key={i.id} role="menuitemradio" aria-checked={i.id === active} data-on={i.id === active} onClick={() => (onPick(i.id), setAt(null))}>
              {i.mark}
              <span className="float-pick-name">{i.title}</span>
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => (onNew(), setAt(null))}>新建会话</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

const Status = ({ s }: { s: StatusLine }) => (
  <span className="float-status" data-tone={s.tone}>
    <i aria-hidden />
    {s.text}
  </span>
);

/**
 * The title bar of the card and of the half screen: the grip, the sessions in one menu, the state; on the right only 「停靠」 and 「收起」 (the half screen's first button is
 * 「落回条」). `variant` "half" also gets the row a bit taller (CHROME_H).
 */
export function FloatHead({ variant, items, active, status, onPick, onNew, onDock, onFold, onShrink, head }: {
  variant: "card" | "half";
  items: SessionItem[];
  active: string;
  status: StatusLine;
  onPick: (id: string) => void;
  onNew: () => void;
  onDock: () => void;
  onFold: () => void;
  onShrink?: () => void;
  head?: Record<string, unknown>;
}) {
  return (
    <div className="float-head" data-variant={variant} tabIndex={0} aria-label="会话面板标题条：拖动移动，双击换宽度，Alt+方向键移动，Alt+Shift+方向键调大小，Esc 收起" title={variant === "card" ? "拖动可以挪位置 · 双击换宽度 · Alt+方向键移动 · Esc 收起" : undefined} {...head}>
      <span className="float-grip-icon" aria-hidden><GripIcon /></span>
      <SessionMenu items={items} active={active} onPick={onPick} onNew={onNew} />
      <Status s={status} />
      <span className="float-spacer" />
      {onShrink && (
        <button className="float-btn" data-nodrag onClick={onShrink} aria-label="落回一条" title="落回一条（Esc）">
          <Svg><path d="M7 10l5 5 5-5" /></Svg>
        </button>
      )}
      <button className="float-btn" data-nodrag onClick={onDock} aria-label="停靠到右边" title="停靠到右边（一栏）"><DockIcon /></button>
      <button className="float-btn" data-nodrag onClick={onFold} aria-label="收起" title="收起（Esc）"><FoldIcon /></button>
    </div>
  );
}

/** The bar's strip (the composer of the session pane sits in the middle of it): avatar and state with the last sentence on the left, 「展开」 and 「收起」 on the right. */
export function BarStrip({ kind, status, said, onExpand, onFold }: { kind?: AgentKind; status: StatusLine; said: string; onExpand: () => void; onFold: () => void }) {
  return (
    <div className="bar-strip">
      <span className="bar-left">
        <Avatar kind={kind} size={32} />
        <span className="bar-text">
          <Status s={status} />
          <span className="bar-said" title={said}>{said || "还没有对话"}</span>
        </span>
      </span>
      <span className="bar-right">
        <button className="float-btn" onClick={onExpand} aria-label="展开成半屏" title="展开成半屏">
          <Svg><path d="M7 14l5-5 5 5" /></Svg>
        </button>
        <button className="float-btn" onClick={onFold} aria-label="收起成药丸" title="收起（Esc）"><FoldIcon /></button>
      </span>
    </div>
  );
}

/** The folded card: a vertical tab at the window's right edge (avatar and name running down, a purple dot on the avatar when something new came); it stands where the card's middle was. */
export function RailTab({ name, top, avatar, label, dot, count, aria, onOpen, forwardRef }: {
  name: ShellName;
  top: number;
  avatar: ReactNode;
  label: string;
  dot?: boolean;
  count?: number;
  aria: string;
  onOpen: () => void;
  forwardRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button ref={forwardRef} className="rail-tab" data-float-shell={name} data-dot={dot || undefined} style={{ top, width: RAIL_W }} aria-label={aria} title={aria} onPointerDown={(e) => e.stopPropagation()} onClick={onOpen}>
      <span className="rail-avatar">
        {avatar}
        {dot && <i className="rail-dot" aria-hidden />}
      </span>
      {count !== undefined && <em>{count}</em>}
      <span className="rail-name">{label}</span>
    </button>
  );
}

/** The folded bar: a pill right of the 「浏览 / 评论」 bar, the same height and look — avatar, state, a dot for news; only the round avatar when there is no room for words. */
export function BarPill({ box, kind, status, dot, aria, onOpen, forwardRef }: { box: Box; kind?: AgentKind; status: StatusLine; dot: boolean; aria: string; onOpen: () => void; forwardRef?: (el: HTMLButtonElement | null) => void }) {
  const round = box.w <= box.h + 0.5;
  return (
    <button ref={forwardRef} className="bar-pill" data-float-shell="session" data-round={round || undefined} data-dot={dot || undefined} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-label={aria} title={aria} onClick={onOpen}>
      <span className="rail-avatar">
        <Avatar kind={kind} size={26} />
        {dot && <i className="rail-dot" aria-hidden />}
      </span>
      {!round && <Status s={status} />}
    </button>
  );
}

/** The faint purple outline of where a dragged card would snap to on letting go (or the docked column, at the window's right edge). */
export function SnapPreview({ box, dock, dockBox }: { box: Box | null; dock: boolean; dockBox: Box }) {
  if (dock) return <div className="float-snap" data-dock style={{ left: dockBox.x, top: dockBox.y, width: dockBox.w, height: dockBox.h }} aria-hidden />;
  // a little larger than the card, so the halo shows around it where the card is about to sit
  return box ? <div className="float-snap" style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }} aria-hidden /> : null;
}

