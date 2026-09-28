// The one animation loop of the canvas overlay (web/docs/workstation.md §性能). Jobs update
// existing SVG / DOM nodes in place (setAttribute, transform); nothing here causes a React render.
// Frames stop in a background tab; a coarse timer keeps the state roughly right there (every job
// reads the time from the clock, never accumulates it), and the first visible frame is exact.
//
// Each frame is measured as a `ws:frame` performance entry when `?perf` (or the bench) is on, so
// the frame budget (≤ 4 ms for 18 agents on a 500-element scene) can be checked in a trace.
export type Job = (now: number) => void;

const jobs = new Set<Job>();
let raf = 0;
let timer = 0;
let lastPaint = 0;
const params = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
const PERF = params.has("perf") || params.has("bench");

function run() {
  lastPaint = performance.now();
  const now = Date.now();
  const t0 = PERF ? performance.now() : 0;
  for (const j of jobs) {
    try {
      j(now);
    } catch (e) {
      console.error(e);
    }
  }
  if (PERF) performance.measure("ws:frame", { start: t0, end: performance.now() });
}

function tick() {
  raf = 0;
  if (!jobs.size) return;
  run();
  if (document.visibilityState === "visible") raf = requestAnimationFrame(tick);
}

function ensure() {
  if (!jobs.size) {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    raf = 0;
    timer = 0;
    return;
  }
  if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
  if (!timer) timer = window.setInterval(() => performance.now() - lastPaint > 180 && run(), 250);
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    raf = 0;
    ensure();
  });

export const frame = {
  /** Run `job` every frame until the returned function is called. */
  add(job: Job) {
    jobs.add(job);
    ensure();
    return () => {
      jobs.delete(job);
      ensure();
    };
  },
  /** Run all jobs once now (after a data change, so the next paint is already right). */
  flush: () => jobs.size && run(),
};
