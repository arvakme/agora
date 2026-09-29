// Glide a canvas so a scene point sits in the middle of its pane (≈420 ms, eased), once — the same move a
// lane name makes to find its agent (canvas/CanvasView.tsx `locate`), for a trace's stop or a trajectory
// row's node. Only ever on a click: the person's own pan / zoom / click stops it at once.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { prefersReducedMotion } from "./clock";

export function glideTo(api: ExcalidrawImperativeAPI, at: { x: number; y: number }) {
  const a = api.getAppState();
  const z = a.zoom.value;
  const to = { x: a.width / 2 / z - at.x, y: a.height / 2 / z - at.y };
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
