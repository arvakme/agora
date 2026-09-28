// Measures the UI over a canvas pane (chrome.ts CHROME_SELECTORS) as boxes in the pane's own
// coordinates, so the overlay layers can stay clear of it. Re-measures when Excalidraw's DOM
// changes (a panel opens), when the pane resizes and when the view changes; identical results
// keep the same array, so nothing re-renders for nothing.
import { useEffect, useRef, useState } from "react";
import type { Box } from "./clearance";
import { CHROME_SELECTORS, GLOBAL_CHROME, NODE_BAR_SELECTORS } from "./chrome";

const NONE: Box[] = [];

export function useChrome(container: HTMLElement | null, key: unknown): Box[] {
  const [boxes, setBoxes] = useState<Box[]>(NONE);
  const last = useRef("");
  const frame = useRef(0);
  const measure = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (!container) return;
      const c = container.getBoundingClientRect();
      const out: Box[] = [];
      const add = (el: Element, own = false) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return;
        const x = Math.max(r.left, c.left);
        const y = Math.max(r.top, c.top);
        const x2 = Math.min(r.right, c.right);
        const y2 = Math.min(r.bottom, c.bottom);
        if (x2 - x < 2 || y2 - y < 2) return;
        out.push({ x: Math.round(x - c.left), y: Math.round(y - c.top), w: Math.round(x2 - x), h: Math.round(y2 - y), ...(own ? { own } : {}) });
      };
      for (const sel of CHROME_SELECTORS) container.querySelectorAll(sel).forEach((el) => add(el, NODE_BAR_SELECTORS.includes(sel)));
      for (const sel of GLOBAL_CHROME) document.querySelectorAll(sel).forEach((el) => add(el));
      const k = JSON.stringify(out);
      if (k !== last.current) {
        last.current = k;
        setBoxes(out);
      }
    });
  };
  useEffect(() => {
    if (!container) return;
    measure();
    const ex = container.querySelector(".excalidraw") ?? container;
    const mo = new MutationObserver(measure);
    mo.observe(ex, { childList: true, subtree: true });
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    addEventListener("resize", measure);
    // Panels glide in; measure again once they settle.
    const t = setInterval(measure, 1500);
    return () => (mo.disconnect(), ro.disconnect(), removeEventListener("resize", measure), clearInterval(t), cancelAnimationFrame(frame.current));
  }, [container]);
  useEffect(measure, [key]);
  return boxes;
}
