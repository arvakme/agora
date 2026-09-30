// Where the camera's view is not continuous, frame by frame (the evidence for web/docs/workstation.md §10 跟随, and the check a
// smoother camera is held to). A sample is the view of the canvas in front of the person at one frame: which canvas, zoom, and
// the scroll (scene coordinates of the pane's top-left, as Excalidraw keeps them). Pure.
export type ViewSample = { t: number; canvas: string; zoom: number; sx: number; sy: number };
export type ViewProblems = {
  /** The canvas changed (a cut under a cross-fade): not a fault of the camera's motion, listed on its own. */
  switches: { t: number; from: string; to: string }[];
  /** On one canvas, a frame whose velocity is not the last frame's: the view's screen displacement changed by `px` between two frames. */
  snaps: { t: number; px: number }[];
  /** Zoom changed by `dz` in one frame. */
  zoomJumps: { t: number; dz: number }[];
  /** The view crossed the screen faster than the limit. */
  fast: { t: number; pxPerSecond: number }[];
};

/** Screen position of the scene's origin, the quantity a person sees the whole picture move by. */
const shown = (s: ViewSample) => ({ x: s.sx * s.zoom, y: s.sy * s.zoom });

export function viewProblems(samples: readonly ViewSample[], o: { snapPx?: number; zoomStep?: number; fastPxPerSecond?: number } = {}): ViewProblems {
  const snapPx = o.snapPx ?? 3;
  const zoomStep = o.zoomStep ?? 0.05;
  const fastLimit = o.fastPxPerSecond ?? 3000;
  const out: ViewProblems = { switches: [], snaps: [], zoomJumps: [], fast: [] };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.canvas !== b.canvas) {
      out.switches.push({ t: b.t, from: a.canvas, to: b.canvas });
      continue;
    }
    const dt = Math.max(1e-3, (b.t - a.t) / 1000);
    const pa = shown(a);
    const pb = shown(b);
    const v = { x: pb.x - pa.x, y: pb.y - pa.y };
    const pxPerSecond = Math.hypot(v.x, v.y) / dt;
    if (pxPerSecond > fastLimit) out.fast.push({ t: b.t, pxPerSecond });
    if (Math.abs(b.zoom - a.zoom) >= zoomStep) out.zoomJumps.push({ t: b.t, dz: b.zoom - a.zoom });
    const prev = samples[i - 2];
    if (prev && prev.canvas === a.canvas) {
      const p0 = shown(prev);
      const before = { x: pa.x - p0.x, y: pa.y - p0.y };
      const px = Math.hypot(v.x - before.x, v.y - before.y);
      if (px > snapPx) out.snaps.push({ t: b.t, px });
    }
  }
  return out;
}
