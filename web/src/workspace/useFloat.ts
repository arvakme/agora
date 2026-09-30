// Where the floating session panel is drawn, in the workspace's frame (web/docs/workstation.md §15): the card's rectangle, or the bottom bar's (and its pill's), the rectangle
// the session pane itself takes inside it, and the gestures on them. The pane is not moved to another parent: it stays in the flat layer and only its rectangle changes, so
// nothing in it is lost when the form changes. The card and the bar are measured against the canvas body (the workspace under the tab bar), so a place means the same
// as the comment list's.
import { useEffect, useRef, useState, type RefObject } from "react";
import { barBox, barSlot, type Box, pillBox, RAIL_W, shellBox } from "../app/floatShell";
import { useBarGestures, useCard, useRail, useShellGestures } from "../app/shellParts";
import type { FloatSpec } from "../app/useSessionFloat";
import { frame } from "../workstation/frame";

type Size = { w: number; h: number };

/** Where the 「浏览 / 评论」 bar is, and the left edge of the nearest control right of it (「整张图」, Excalidraw's help), in the canvas body's frame: what the bar sits over and the pill sits beside. */
export function useDockRect(ws: RefObject<HTMLElement | null>, header: number, on: boolean): { dock: Box | null; limit: number | null } {
  const [v, setV] = useState<{ dock: Box | null; limit: number | null }>({ dock: null, limit: null });
  const last = useRef("");
  useEffect(() => {
    if (!on) return;
    return frame.add(() => {
      const w = ws.current?.getBoundingClientRect();
      const d = document.querySelector<HTMLElement>(".dock")?.getBoundingClientRect();
      if (!w || !d || d.width < 1) return;
      const lefts = [...document.querySelectorAll<HTMLElement>('[data-pane]:not([data-hidden="true"]) :is(.whole-btn, .layer-ui__wrapper__footer-right > *)')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.left > d.right).map((r) => r.left);
      const dock = { x: Math.round(d.left - w.left), y: Math.round(d.top - w.top - header), w: Math.round(d.width), h: Math.round(d.height) };
      const limit = lefts.length ? Math.round(Math.min(...lefts) - w.left) : null;
      const k = `${dock.x}|${dock.y}|${dock.w}|${dock.h}|${limit}`;
      if (k === last.current) return;
      last.current = k;
      setV({ dock, limit });
    });
  }, [ws, header, on]);
  return v;
}

const noop = () => {};
const NO_SHELL = { place: { right: 12, top: 92 }, width: 420, height: null, folded: false };

export function useFloat(flt: FloatSpec | undefined, size: Size, ws: RefObject<HTMLElement | null>, header: number) {
  const commentsRail = useRail("comments");
  const commentsCard = useCard("comments");
  // a folded comment list's rail tab is at the window's right edge: the card stays clear of it
  const gutter = flt?.mode === "card" && commentsRail ? RAIL_W : 0;
  const body = { w: size.w, h: Math.max(0, size.h - header) };
  const cardPane = { w: body.w - gutter, h: body.h };
  const { dock, limit } = useDockRect(ws, header, flt?.mode === "bar");
  // before the bar is measured (or with no canvas on screen) it is where the 「浏览 / 评论」 bar is by default: centred, 18 px off the window's bottom
  const dockBox: Box = dock ?? { x: Math.round(body.w / 2 - 103), y: body.h - 18 - 40, w: 206, h: 40 };
  const card = useShellGestures({ shell: flt?.shell ?? NO_SHELL, set: flt?.setShell ?? noop, pane: cardPane, kind: "session", onDock: flt?.onDock, onFold: flt?.onFold });
  const bar = useBarGestures({ bar: flt?.bar ?? { width: 780, height: null, expanded: false, folded: false }, set: flt?.setBar ?? noop, pane: body, dock: dockBox });
  const down = (b: Box): Box => ({ ...b, y: b.y + header });
  let frameBox: Box | null = null;
  let slot: Box | null = null;
  let strip = false;
  let pill: Box | null = null;
  let cardBox: Box | null = null;
  if (flt?.mode === "card") {
    cardBox = shellBox(flt.shell, cardPane, "session");
    frameBox = down(cardBox);
    slot = { x: frameBox.x, y: frameBox.y + header, w: frameBox.w, h: frameBox.h - header };
  } else if (flt?.mode === "bar") {
    const b = barBox(flt.bar, body, dockBox, commentsCard);
    frameBox = down(b);
    strip = !flt.bar.expanded;
    slot = down(barSlot(b, flt.bar.expanded));
    pill = down(pillBox(dockBox, limit ?? body.w - 12));
  }
  return { frame: frameBox, slot, strip, pill, cardBox, dock: dockBox, body, cardPane, gutter, card, bar };
}
