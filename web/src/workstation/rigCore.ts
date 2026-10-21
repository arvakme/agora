// The rig's building blocks (./rig.ts): points, springs, glides, two-bone IK and the body's proportions.

export type Pt = { x: number; y: number };

/** Second-order system y + k1·y' + k2·y'' = x + k3·x' (f: frequency Hz, z: damping, r: response). dt in seconds. */
export class Spring {
  k1: number;
  k2: number;
  k3: number;
  xp: number | null = null;
  y = 0;
  yd = 0;
  constructor(f: number, z: number, r: number) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (2 * Math.PI * f) ** 2;
    this.k3 = (r * z) / (2 * Math.PI * f);
  }
  reset(x: number) {
    this.xp = x;
    this.y = x;
    this.yd = 0;
    return x;
  }
  step(dt: number, x: number) {
    if (this.xp == null) return this.reset(x);
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt;
    this.xp = x;
    // stays stable at big steps (a 4× replay, a slow frame)
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}

/**
 * A retargetable glide (cubic Hermite in time): from where it is, with the speed it has, to a new
 * target that it reaches at rest after `D` seconds. Starting from rest its acceleration is small
 * (6·Δ/D²), and a new target mid-flight keeps position and speed continuous — no pop, no lurch.
 * Used for bubbles moving or flipping sides. `now` in seconds.
 */
export class Glide {
  p0 = 0;
  v0 = 0;
  p1 = 0;
  t0 = 0;
  D = 0.4;
  started = false;
  reset(x: number, now: number) {
    this.p0 = this.p1 = x;
    this.v0 = 0;
    this.t0 = now;
    this.started = true;
    return x;
  }
  private at(now: number): [number, number] {
    const u = this.D > 0 ? Math.min(1, Math.max(0, (now - this.t0) / this.D)) : 1;
    if (u >= 1) return [this.p1, 0];
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const p = h00 * this.p0 + h10 * this.D * this.v0 + h01 * this.p1;
    const d00 = 6 * u2 - 6 * u;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = -6 * u2 + 6 * u;
    const v = (d00 * this.p0 + d01 * this.p1) / this.D + d10 * this.v0;
    return [p, v];
  }
  /** Position at `now`, heading for `target` (a changed target starts a new glide from here). */
  step(now: number, target: number) {
    if (!this.started) return this.reset(target, now);
    if (Math.abs(target - this.p1) > 0.25) {
      const [p, v] = this.at(now);
      this.p0 = p;
      this.v0 = v;
      this.p1 = target;
      this.t0 = now;
      // Long moves take longer; and a glide retargeted mid-flight takes as long as it needs so that
      // neither its start nor its end accelerates harder than A (Hermite: a(0) = (6Δ − 4·D·v0) / D²,
      // a(1) = (2·D·v0 − 6Δ) / D²) — it never brakes or lurches, however often the target moves.
      const A = 2000;
      const d = target - p;
      let D = Math.min(1, 0.42 + Math.abs(d) / 260);
      while (D < 2.5 && (Math.abs(6 * d - 4 * D * v) > A * D * D || Math.abs(2 * D * v - 6 * d) > A * D * D)) D += 0.05;
      this.D = D;
    }
    return this.at(now)[0];
  }
}

/** `over`: how far the target was out of the limb's reach (too far, or too near), which `ik` then clamps: 0 when it was reachable. */
export type Bone = { jx: number; jy: number; ex: number; ey: number; over: number };
/** Two-bone IK by the law of cosines: root (rx, ry) → target (tx, ty), bones a and b. bend +1 bends clockwise (y down). */
export function ik(rx: number, ry: number, tx: number, ty: number, a: number, b: number, bend: number): Bone {
  const dx = tx - rx;
  const dy = ty - ry;
  const d0 = Math.hypot(dx, dy) || 1e-3;
  const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, d0));
  const base = Math.atan2(dy, dx);
  const A = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  const ang = base + bend * A;
  return { jx: rx + a * Math.cos(ang), jy: ry + a * Math.sin(ang), ex: rx + (dx / d0) * d, ey: ry + (dy / d0) * d, over: Math.max(0, d0 - (a + b), Math.abs(a - b) - d0) };
}

/**
 * Proportions in figure units: Loom Studio's line figure (docs/workstation.md §小人) at 0.936 of its
 * size, head excepted, so the top of the head stays 53.8 above the ground, where it has always been
 * (bubbles hang their tails there). `shin` runs from the knee to the sole (the IK target on the
 * ground); the drawn shin stops `ankle` above the sole, where the `foot` starts. `head` is the head's
 * radius (the neck is head + 0.6).
 */
export const RIG = { hip: 25.45, thigh: 12.54, shin: 13.76, ankle: 1.4, foot: 5.05, torso: 15.35, upper: 9.36, fore: 8.8, head: 6.2, stance: 3.6 };
export const smooth = (u: number) => u * u * (3 - 2 * u);
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const mix = (a: number, b: number, u: number) => a + (b - a) * u;
/** An angle difference brought into −π … π (the short way round). */
export const wrapAngle = (d: number) => d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
