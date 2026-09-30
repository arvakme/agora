// What the floating shell of the session panel and the comment list share as components (the rules are in ./floatShell.ts, web/docs/workstation.md §15):
// each shell's own place / width / folded state kept per browser, the gestures on its head (drag, Alt+arrows) and on its left edge (width), and the capsule it
// folds to. The shell is a container only: what is in it is the same component either way.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as RKeyEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { useDragGuard } from "./dragGuard";
import { capsuleRight, dragTo, floatFocus, keyMove, loadShell, mayDrag, resizeTo, saveShell, STEP, type Shell, type ShellName } from "./floatShell";

type Size = { w: number; h: number };

/** A shell's own state, per browser. `set(s, false)` while a drag is under way (the pointer-up keeps it). */
export function useShell(name: ShellName): readonly [Shell, (s: Shell, keep?: boolean) => void] {
  const [shell, setShell] = useState(() => loadShell(name));
  const set = useCallback((s: Shell, keep = true) => (setShell(s), keep && saveShell(name, s)), [name]);
  return [shell, set];
}

/** Which shell is open now ("session" / "comments" / neither). */
export const useFloatFocus = () => useSyncExternalStore(floatFocus.subscribe, floatFocus.get);
/** How far from the right edge the other shell covers (undefined: not at all). */
export const useReach = (other: ShellName) => useSyncExternalStore(floatFocus.subscribe, () => floatFocus.reach(other));

/**
 * The shell claims "open" while it is expanded and lets go when it folds, closes or goes away; the other one, if it is open too, waits as its capsule
 * until then. `expanded` is whether this shell wants to be shown as a panel.
 */
export function useClaim(name: ShellName, expanded: boolean) {
  useEffect(() => {
    if (!expanded) return;
    floatFocus.set(name);
    return () => void (floatFocus.get() === name && floatFocus.set(null));
  }, [name, expanded]);
  return useFloatFocus();
}

/** Tell the other shell how far from the right edge this one's visible part reaches (`el`, in the pane whose right edge is `pane`). */
export function useReporter(name: ShellName, el: HTMLElement | null, pane: HTMLElement | null | undefined, on: boolean) {
  useEffect(() => {
    if (!on || !el || !pane) return;
    const tell = () => floatFocus.setReach(name, Math.round(pane.getBoundingClientRect().right - el.getBoundingClientRect().left));
    tell();
    const ro = new ResizeObserver(tell);
    ro.observe(el);
    ro.observe(pane);
    return () => (ro.disconnect(), floatFocus.setReach(name, null));
  }, [name, el, pane, on]);
}

/**
 * The gestures on a shell: `move` for its head (drag by the empty part, Alt+arrows), `resize` for its left edge (drag, ←/→). The drag itself is held by
 * ./dragGuard.ts (no selection, the pointer is the handle's, Esc or a lost pointer leaves the shell where it is).
 */
export function useShellGestures(shell: Shell, set: (s: Shell, keep?: boolean) => void, pane: Size, height: number) {
  const guard = useDragGuard();
  const latest = useRef({ shell, pane, height });
  latest.current = { shell, pane, height };
  const at = useRef<{ x: number; y: number; from: Shell; kind: "move" | "resize" } | null>(null);
  /** A gesture is under way: the layout's gliding is off while the shell follows the pointer. */
  const [active, setActive] = useState(false);
  const start = (kind: "move" | "resize", e: RPointerEvent, cursor: string) => {
    at.current = { x: e.clientX, y: e.clientY, from: latest.current.shell, kind };
    setActive(true);
    guard(e, { cursor, onEnd: (why) => void (why !== "up" && ((at.current = null), setActive(false))) });
  };
  const track = (e: RPointerEvent) => {
    const a = at.current;
    if (!a) return;
    const { pane: p, height: h } = latest.current;
    set(a.kind === "move" ? dragTo(a.from, e.clientX - a.x, e.clientY - a.y, p, h) : resizeTo(a.from, a.x - e.clientX, p), false);
  };
  const drop = () => {
    if (!at.current) return;
    at.current = null;
    setActive(false);
    set(latest.current.shell);
  };
  return {
    active,
    move: {
      onPointerDown: (e: RPointerEvent) => void (e.button === 0 && mayDrag(e) && start("move", e, "grabbing")),
      onPointerMove: track,
      onPointerUp: drop,
      onPointerCancel: drop,
      onKeyDown: (e: RKeyEvent) => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest?.(".wm-tab, .float-head")) return;
        const next = keyMove(latest.current.shell, e.key, { alt: e.altKey, shift: e.shiftKey }, latest.current.pane, latest.current.height);
        if (next) (e.preventDefault(), set(next));
      },
    },
    resize: {
      onPointerDown: (e: RPointerEvent) => void (e.button === 0 && start("resize", e, "col-resize")),
      onPointerMove: track,
      onPointerUp: drop,
      onPointerCancel: drop,
      onKeyDown: (e: RKeyEvent) => {
        const by = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
        if (by) (e.preventDefault(), set(resizeTo(latest.current.shell, by, latest.current.pane)));
      },
    },
  };
}

/** The small round-ended button a folded shell is: its icon, its name (a session's name; the comment count), a dot when something new came while it was folded. */
export function ShellCapsule({ name, shell, others, icon, label, count, dot, aria, onOpen, forwardRef }: {
  name: ShellName;
  shell: Shell;
  /** The other shell's reach: the capsule sits beside it. */
  others: (number | undefined)[];
  icon: ReactNode;
  label?: string;
  count?: number;
  dot?: boolean;
  aria: string;
  onOpen: () => void;
  forwardRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button ref={forwardRef} className="float-capsule" data-float-shell={name} data-dot={dot || undefined} style={{ right: capsuleRight(shell.place, others), top: shell.place.top }} onPointerDown={(e) => e.stopPropagation()} onClick={onOpen} aria-label={aria} title={aria}>
      {icon}
      {label && <span className="float-capsule-label">{label}</span>}
      {count !== undefined && <em>{count}</em>}
      {dot && <i className="float-capsule-dot" aria-hidden />}
    </button>
  );
}
