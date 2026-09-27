// Engine adapter contract + the playback clock. Engine-agnostic; copied into the tldraw spike.
// The controller owns time (step, t, speed); an engine only mounts a region and draws Frames.
import { frameAt, type Frame, type Timeline } from "./timeline.ts";

export type ViewRect = { x: number; y: number; w: number; h: number };

export interface AnimEngine {
  readonly name: "excalidraw" | "tldraw";
  /** Create the titled region + node shapes at a free spot (one undoable edit). */
  mount(tl: Timeline): void;
  /** Draw one frame. Must stay out of undo history. */
  render(frame: Frame): void;
  /** Optional native tween from the current frame to `to` (tldraw: editor.animateShapes). */
  tween?(to: Frame, ms: number): Promise<void>;
  /** Region rectangle in viewport (CSS px) coordinates, for anchoring the player; null if gone. */
  rect(): ViewRect | null;
  /** Delete the region and its shapes. */
  remove(): void;
}

export const STEP_MS = 700; // motion per step at 1×
export const DWELL_MS = 350; // pause after each step so the caption can be read
export const SPEEDS = [0.5, 1, 2, 4] as const;

export type PlayerState = { step: number; t: number; playing: boolean; speed: number; total: number; caption: string; native: boolean };
export type FrameStats = { frames: number; avgMs: number; p95Ms: number; maxMs: number; renderMs: number; longFrames: number };

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class AnimController {
  private state: PlayerState;
  private listeners = new Set<() => void>();
  private raf = 0;
  private dwell = 0; // ms left in the post-step pause
  private stepsLeft = Infinity; // single-step forward plays exactly one step
  private deltas: number[] = [];
  private renderTotal = 0;
  private runId = 0; // bumped by pause/seek: cancels an in-flight native loop
  private seekId = 0;

  constructor(readonly tl: Timeline, readonly engine: AnimEngine, opts: { native?: boolean } = {}) {
    this.state = { step: 0, t: 0, playing: false, speed: 1, total: tl.script.steps.length, caption: "", native: !!opts.native && !!engine.tween };
    this.draw();
  }

  get snapshot() {
    return this.state;
  }
  subscribe = (fn: () => void) => (this.listeners.add(fn), () => this.listeners.delete(fn));
  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private draw() {
    const f = frameAt(this.tl, this.state.step, this.state.t);
    const t0 = performance.now();
    this.engine.render(f);
    this.renderTotal += performance.now() - t0;
    if (f.caption !== this.state.caption) this.set({ caption: f.caption });
  }

  play() {
    if (this.state.playing) return;
    if (this.state.step >= this.state.total) this.seek(0);
    this.stepsLeft = Infinity;
    this.start();
  }
  pause() {
    this.runId++;
    cancelAnimationFrame(this.raf);
    this.set({ playing: false });
  }
  toggle = () => (this.state.playing ? this.pause() : this.play());
  /** Forward one step (animated), then pause. */
  next() {
    if (this.state.playing || this.state.step >= this.state.total) return;
    this.stepsLeft = 1;
    this.start();
  }
  /** Back one step (jump — reversing motion adds nothing to understanding). */
  prev() {
    this.pause();
    this.seek(this.state.t > 0 ? this.state.step : Math.max(0, this.state.step - 1));
  }
  reset = () => (this.pause(), this.seek(0));
  setSpeed = (speed: number) => this.set({ speed });
  setNative = (native: boolean) => this.set({ native: native && !!this.engine.tween });
  /** Jump to a continuous position p∈[0,total]. */
  seek(p: number) {
    const step = Math.max(0, Math.min(this.state.total, Math.floor(p)));
    this.runId++;
    this.seekId++;
    this.dwell = 0;
    this.set({ step, t: step >= this.state.total ? 0 : p - step });
    this.draw();
  }

  stats(): FrameStats {
    const d = [...this.deltas].sort((a, b) => a - b);
    const avg = d.reduce((a, b) => a + b, 0) / (d.length || 1);
    return {
      frames: d.length,
      avgMs: +avg.toFixed(2),
      p95Ms: +(d[Math.floor(d.length * 0.95)] ?? 0).toFixed(2),
      maxMs: +(d[d.length - 1] ?? 0).toFixed(2),
      renderMs: +(this.renderTotal / (d.length || 1)).toFixed(3),
      longFrames: d.filter((x) => x > 50).length,
    };
  }
  resetStats() {
    this.deltas = [];
    this.renderTotal = 0;
  }

  private start() {
    this.set({ playing: true });
    this.sample();
    if (this.state.native) return void this.nativeLoop();
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 250) * this.state.speed;
      last = now;
      if (!this.advance(dt)) return this.set({ playing: false });
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Advance the clock by dt (already speed-scaled). Returns false when playback should stop. */
  private advance(dt: number): boolean {
    const s = this.state;
    if (s.step >= s.total) return false;
    if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.dwell > 0) return true;
      return true;
    }
    // Reduced motion: each step is a cut, followed by the (longer) dwell.
    const t = reduced() ? 1 : s.t + dt / STEP_MS;
    if (t >= 1) {
      this.set({ step: s.step + 1, t: 0 });
      this.draw();
      this.dwell = reduced() ? STEP_MS + DWELL_MS : DWELL_MS;
      return this.state.step < s.total && --this.stepsLeft > 0;
    }
    this.set({ t });
    this.draw();
    return true;
  }

  /** Frame-cadence probe: rAF deltas while playing, independent of who drives the motion. */
  private sample() {
    let last = performance.now();
    const probe = (now: number) => {
      if (!this.state.playing) return;
      this.deltas.push(now - last);
      last = now;
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  }

  /** Native path: one engine tween per step, dwell via setTimeout. */
  private async nativeLoop() {
    const run = ++this.runId;
    while (run === this.runId && this.state.step < this.state.total && this.stepsLeft-- > 0) {
      const from = this.state.step, seek = this.seekId;
      const to = frameAt(this.tl, from + 1, 0);
      this.set({ caption: to.caption });
      if (reduced()) this.engine.render(to);
      else await this.engine.tween!(to, STEP_MS / this.state.speed);
      if (run !== this.runId) {
        // Paused mid-tween (a native tween can't be frozen): it finished, so count the step.
        // Seeked mid-tween: redraw the controller's state over the tween's end pose.
        if (seek === this.seekId) this.set({ step: from + 1, t: 0 });
        return this.draw();
      }
      this.set({ step: from + 1, t: 0 });
      await new Promise((r) => setTimeout(r, (reduced() ? STEP_MS + DWELL_MS : DWELL_MS) / this.state.speed));
    }
    if (run === this.runId) this.set({ playing: false });
  }
}
