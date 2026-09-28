// Overlays drawn over the scene (progress pointers, 工位视图 workers, child-canvas markers) must
// never cover the canvas's own UI: Excalidraw's islands (style panel, toolbar, library button,
// zoom / undo, the bottom bar in the compact layout, menus and popovers) and our own panels.
// The layers sit below that UI (z-order), are clipped to the unobstructed area, and a target
// hidden behind a panel or off-screen is shown as an edge indicator instead.
// Pure (type-only imports) so it runs under vitest in node; the DOM measuring is in useChrome.ts.
import type { Box } from "./clearance";

/** What counts as UI over the canvas (inside the canvas pane). */
export const CHROME_SELECTORS = [
  ".excalidraw .Island",
  ".excalidraw .App-toolbar",
  ".excalidraw .App-menu_top__left > *",
  ".excalidraw .layer-ui__wrapper__top-right > *",
  ".excalidraw .layer-ui__wrapper__footer-left > *",
  ".excalidraw .layer-ui__wrapper__footer-right > *",
  ".excalidraw .App-bottom-bar",
  ".excalidraw .sidebar",
  ".excalidraw .context-menu",
  ".excalidraw .popover",
  ".excalidraw .dropdown-menu",
  ".ws-toggle",
  ".nest-menu",
  ".ptr-edit",
  ".tcard",
  ".drawer",
];
/** Our UI outside the canvas pane that can still float over it (the dock, the comment-mode hint). */
export const GLOBAL_CHROME = [".dock", ".mode-hint"];

const inside = (x: number, y: number, b: Box) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/** Share of a box (sampled on a grid) that is inside `view` and not under any block. */
export function visibleShare(box: Box, view: Box, blocks: readonly Box[], n = 6): number {
  let free = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = box.x + ((i + 0.5) / n) * box.w;
      const y = box.y + ((j + 0.5) / n) * box.h;
      if (inside(x, y, view) && !blocks.some((b) => inside(x, y, b))) free++;
    }
  return free / (n * n);
}

/** Hidden = its centre is off-screen or under UI, or less than `min` of it is free. */
export function occluded(box: Box, view: Box, blocks: readonly Box[], min = 0.4): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (!inside(cx, cy, view) || blocks.some((b) => inside(cx, cy, b))) return true;
  return visibleShare(box, view, blocks) < min;
}

export type EdgeSpot = { x: number; y: number; w: number; h: number; angle: number };

/**
 * Where to put a `w`×`h` indicator for a hidden target: on the view's edge (inset by `inset`)
 * where the line from the view's centre to the target leaves it, then slid along that edge to the
 * nearest place no block covers. `angle` (degrees, 0 = pointing right) points at the target.
 */
export function edgeSpot(target: Box, view: Box, blocks: readonly Box[], w: number, h: number, inset = 10): EdgeSpot {
  const vx = view.x + view.w / 2;
  const vy = view.y + view.h / 2;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  const dx = tx - vx;
  const dy = ty - vy;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // The inner rectangle the indicator's top-left may take.
  const lo = { x: view.x + inset, y: view.y + inset };
  const hi = { x: view.x + view.w - inset - w, y: view.y + view.h - inset - h };
  const clampX = (x: number) => Math.max(lo.x, Math.min(hi.x, x));
  const clampY = (y: number) => Math.max(lo.y, Math.min(hi.y, y));
  // A target inside the view (behind a panel): go to the edge on its side, level with it.
  const hx = (view.w / 2 - inset) / Math.max(1e-6, Math.abs(dx));
  const hy = (view.h / 2 - inset) / Math.max(1e-6, Math.abs(dy));
  const t = Math.min(hx, hy);
  let x = clampX(vx + dx * t - w / 2);
  let y = clampY(vy + dy * t - h / 2);
  const onVertical = hx <= hy; // left or right edge: slide up / down
  const free = (px: number, py: number) => !blocks.some((b) => px < b.x + b.w && px + w > b.x && py < b.y + b.h && py + h > b.y);
  if (!free(x, y)) {
    const steps = onVertical ? Math.ceil((hi.y - lo.y) / 8) : Math.ceil((hi.x - lo.x) / 8);
    let found = false;
    for (let k = 1; k <= steps && !found; k++)
      for (const s of [1, -1]) {
        const nx = onVertical ? x : clampX(x + s * k * 8);
        const ny = onVertical ? clampY(y + s * k * 8) : y;
        if (free(nx, ny)) {
          x = nx;
          y = ny;
          found = true;
          break;
        }
      }
    // The whole edge is covered (a tall panel on that side): try just past the block.
    if (!found) {
      const b = blocks.find((q) => x < q.x + q.w && x + w > q.x && y < q.y + q.h && y + h > q.y)!;
      if (onVertical) x = clampX(b.x + b.w + 6 <= hi.x ? b.x + b.w + 6 : b.x - w - 6);
      else y = clampY(b.y + b.h + 6 <= hi.y ? b.y + b.h + 6 : b.y - h - 6);
    }
  }
  return { x: Math.round(x), y: Math.round(y), w, h, angle };
}

/**
 * A CSS `clip-path` that keeps the view and cuts out every block (even-odd holes), so nothing a
 * layer draws can show on top of — or catch clicks meant for — the UI under those boxes.
 */
export function clipPath(view: Box, blocks: readonly Box[]): string {
  const r = (b: Box) => `M${Math.round(b.x)} ${Math.round(b.y)}h${Math.round(b.w)}v${Math.round(b.h)}h${-Math.round(b.w)}Z`;
  const holes = merge(blocks.map((b) => intersect(b, view)).filter((b): b is Box => !!b));
  return `path(evenodd, "${[r(view), ...holes.map(r)].join("")}")`;
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/** Overlapping holes would cancel out under even-odd: merge them into their union box first. */
export function merge(boxes: Box[]): Box[] {
  const out = [...boxes];
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        if (intersect(out[i], out[j])) {
          const a = out[i];
          const b = out[j];
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          out.splice(j, 1);
          changed = true;
          break outer;
        }
  }
  return out;
}
