// One guard for every drag in the page (a pane's divider, a tab, the comments panel, a timeline's range, and whatever floats next: the session panel). While a pointer is held
// down on a drag handle: no text is selected and none starts being (`user-select: none` on the page, the selection cleared, `selectstart` and `dragstart` refused), the pointer
// belongs to the handle (pointer capture: the canvas or an iframe under it gets nothing), the cursor is the drag's own whatever is under it, and when it ends — pointerup,
// pointercancel, losing the pointer, the window losing focus, Esc, the component going away — everything is put back exactly as it was. Several at once count; the last one puts back.
//
//   const onDown = (e: React.PointerEvent) => { const end = dragGuard(e, { cursor: "col-resize", onEnd: (why) => why !== "up" && abort() }); … }
//   or, in a component, `const guard = useDragGuard();` — the same, and a guard still on when the component unmounts is ended.
import { useEffect, useRef } from "react";

export type EndWhy = "up" | "cancel" | "lost" | "blur" | "escape" | "manual";
export type GuardOpts = { cursor?: string; onEnd?: (why: EndWhy) => void };

/** What a guard needs of the page (a real one below; a fake in the test). */
export type GuardEnv = {
  style: { userSelect: string; webkitUserSelect?: string; cursor: string };
  clearSelection: () => void;
  listen: (type: string, fn: (e: { pointerId?: number; key?: string; preventDefault?: () => void }) => void) => () => void;
};
type Start = { pointerId: number; cancelable?: boolean; preventDefault?: () => void; currentTarget?: unknown; target?: unknown };
type Capturer = { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void };

export function createDragGuards(env: GuardEnv) {
  let live = 0;
  let saved: { userSelect: string; webkit: string | undefined; cursor: string } | null = null;
  return function guard(e: Start, o: GuardOpts = {}): () => void {
    e.preventDefault?.(); // no native text drag-select, no text drag
    const holder = (e.currentTarget ?? e.target) as Capturer | null;
    try {
      holder?.setPointerCapture?.(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    if (live++ === 0) {
      saved = { userSelect: env.style.userSelect, webkit: env.style.webkitUserSelect, cursor: env.style.cursor };
      env.style.userSelect = "none";
      if (env.style.webkitUserSelect !== undefined) env.style.webkitUserSelect = "none";
    }
    if (o.cursor) env.style.cursor = o.cursor;
    env.clearSelection();
    let done = false;
    const offs: (() => void)[] = [];
    const end = (why: EndWhy = "manual") => {
      if (done) return;
      done = true;
      for (const off of offs) off();
      try {
        holder?.releasePointerCapture?.(e.pointerId);
      } catch {
        /* already released */
      }
      if (--live === 0 && saved) {
        env.style.userSelect = saved.userSelect;
        if (saved.webkit !== undefined) env.style.webkitUserSelect = saved.webkit;
        env.style.cursor = saved.cursor;
        saved = null;
      }
      o.onEnd?.(why);
    };
    const mine = (ev: { pointerId?: number }) => ev.pointerId === undefined || ev.pointerId === e.pointerId;
    offs.push(
      env.listen("pointerup", (ev) => mine(ev) && end("up")),
      env.listen("pointercancel", (ev) => mine(ev) && end("cancel")),
      env.listen("lostpointercapture", (ev) => mine(ev) && end("lost")),
      env.listen("blur", () => end("blur")),
      env.listen("keydown", (ev) => ev.key === "Escape" && end("escape")),
      env.listen("selectstart", (ev) => ev.preventDefault?.()),
      env.listen("dragstart", (ev) => ev.preventDefault?.()),
    );
    return () => end("manual");
  };
}

let real: ReturnType<typeof createDragGuards> | null = null;
/** The page's guard: `e` is the pointerdown on the handle. Returns the function that ends it (it also ends itself, see above). */
export function dragGuard(e: Start, o?: GuardOpts): () => void {
  real ??= createDragGuards({
    get style() {
      return document.body.style as unknown as GuardEnv["style"];
    },
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    listen: (type, fn) => {
      const on = fn as EventListener;
      window.addEventListener(type, on, true);
      return () => window.removeEventListener(type, on, true);
    },
  });
  return real(e, o);
}

/** `dragGuard` for a component: a guard still on when it unmounts is ended (the drag's `onEnd` runs with "manual"). */
export function useDragGuard(): typeof dragGuard {
  const ends = useRef(new Set<() => void>());
  useEffect(() => () => [...ends.current].forEach((end) => end()), []);
  return (e, o) => {
    const end = dragGuard(e, { ...o, onEnd: (why) => (ends.current.delete(end), o?.onEnd?.(why)) });
    ends.current.add(end);
    return end;
  };
}
