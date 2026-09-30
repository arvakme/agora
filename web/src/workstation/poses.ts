// 姿势分层 (web/docs/workstation.md §16 · 姿势分层): the standing pose and the blending between what a worker is doing. Pure (types only from ./rig.ts),
// so every frame of it can be tested without a browser.
//
// The lower layer is what the body does: stand, walk or climb. Over it, an activity — reading, writing, running a command, thinking, waiting for the person,
// pointing at a sub-agent, handing a page over (`Pose` in ./rig.ts) — and the gestures on top of those (./gestures.ts). Nothing switches from one to the next in one
// frame: `layerStep` blends what the hands, the lean and the head do over 0.28 s, and gives the two moments people notice a beat of their own — bringing the hands
// out from behind the back into an activity (起势: up and forward first, then to the work) and coming out of one (收势: the hands come together in a clap, then go
// back behind the back). A blend that is interrupted goes on from where it is: it always starts from what was on screen the frame before.
//
// The standing pose is 双手背后 (chosen from the design board G2, web/docs/workstation.md §16): two hands behind the back, a slight lean forward, legs relaxed
// and straight (the knees barely bent), feet a little apart; it breathes, shifts its weight a little now and then and turns its head to look every few seconds.
import type { Pose, Targets } from "./rig";

/** Hands are from the shoulder, x along the facing, y down. RAISE, CLAP and STAND are in Loom's arm units (19.4 long): `k` (the rig's arm ÷ 19.4) scales them; the targets `layerStep` is given are already the rig's. */
export type Hand = readonly [number, number];

/** The blend between two layers of what a worker does takes this long (ms): 0.25–0.3 s. */
export const BLEND_MS = 280;
/** Bringing the hands out into an activity: up and forward first, then to the work (ms in all). */
export const ENTER_MS = 300;
/** Coming out of one: the hands to a clap, the clap, and back behind the back (ms in all). */
export const EXIT_MS = 560;
/** Where the hands are on the way into an activity (起势): forward and up, at the chest, ready. */
export const RAISE: { near: Hand; far: Hand } = { near: [9.4, -1.5], far: [7.8, -0.6] };
/** Where the hands meet in the clap that ends an activity (收势): in front of the chest; they touch and part once. */
export const CLAP: { near: Hand; far: Hand } = { near: [10.2, 3.6], far: [10.2, 4.2] };

/** The poses that are standing, doing nothing: the lower layer alone. */
export const isStand = (p: string): boolean => p === "idle" || p === "unknown";

/** The standing pose's fixed part: hands behind the back, lean, and how the legs stand (from the design board: gen3.py `base("back")`). */
export const STAND = {
  near: [-6.8, 13.2] as Hand,
  far: [-7.6, 13.4] as Hand,
  lean: 3,
  /** Added to the hips' height (figure units; negative = higher): the legs stand straight, the knees barely bent. */
  crouch: -0.6,
};

/**
 * What the standing pose does by itself at wall time t (ms; pure): breathing (the hips rise and fall a fifth of a unit, 4 s a breath), the weight shifting a little (the body
 * sways ±0.45 units, 14 s a way), a glance every 9 s or so (the head turns to look and tips 5° for a second). `seed` keeps two workers from breathing together. With `still`
 * (reduced motion) it holds still.
 */
export function standMotion(t: number, seed = 0, still = false): { crouch: number; sway: number; tilt: number; look: [number, number] } {
  if (still) return { crouch: 0, sway: 0, tilt: 0, look: [0, 0] };
  const s = t / 1000;
  const ph = seed * 1.3;
  let g = Math.max(0, Math.sin(s * 0.7 + ph * 2));
  g = g > 0.9 ? (g - 0.9) * 10 : 0; // only the top of the wave: a look now and then
  return { crouch: 0.22 * Math.sin(s * 1.5 + ph), sway: 0.45 * Math.sin(s * 0.45 + ph), tilt: 5 * g, look: [1.8 * g, -0.4 * g] };
}

const mix = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/** A hand between two places about the shoulder along an arc: the angle from straight ahead (0) goes evenly, the distance goes evenly — never through the shoulder. */
export function arc(a: Hand, b: Hand, u: number): [number, number] {
  const a0 = Math.atan2(a[1], a[0]);
  const a1 = Math.atan2(b[1], b[0]);
  const ang = mix(a0, a1, u);
  const r = mix(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1]), u);
  return [r * Math.cos(ang), r * Math.sin(ang)];
}

/** How a blend goes: entering an activity from standing, leaving one for standing, or any other change (an activity to another, walking to standing, standing to walking, …). */
export type LayerKind = "enter" | "exit" | "swap";
export const kindOf = (from: string, to: string): LayerKind => (isStand(from) && !isStand(to) && to !== "walk" ? "enter" : !isStand(from) && from !== "walk" && isStand(to) ? "exit" : "swap");
export const durationOf = (k: LayerKind): number => (k === "enter" ? ENTER_MS : k === "exit" ? EXIT_MS : BLEND_MS);

/** The state of the blend kept between frames: what the worker is doing now, since when (wall ms), and what was on screen when it changed (null: nothing to blend from). */
export type Layer = { key: string; at: number; kind: LayerKind; from: Targets | null };

/** The hands (near, far) along a blend at progress u (0 … 1) from `a` to `b` — through the raise on the way in, through the clap on the way out. */
export function blendHands(kind: LayerKind, a: { near: Hand; far: Hand }, b: { near: Hand; far: Hand }, u: number, k = 1): { near: [number, number]; far: [number, number] } {
  const sc = (h: Hand): Hand => [h[0] * k, h[1] * k];
  const RAISE_N = sc(RAISE.near);
  const RAISE_F = sc(RAISE.far);
  const CLAP_N = sc(CLAP.near);
  const CLAP_F = sc(CLAP.far);
  if (kind === "enter") {
    const cut = 0.45;
    return u < cut
      ? { near: arc(a.near, RAISE_N, smooth(u / cut)), far: arc(a.far, RAISE_F, smooth(u / cut)) }
      : { near: arc(RAISE_N, b.near, smooth((u - cut) / (1 - cut))), far: arc(RAISE_F, b.far, smooth((u - cut) / (1 - cut))) };
  }
  if (kind === "exit") {
    const to = 0.4; // the clap is reached
    const hold = 0.55; // …and left
    if (u < to) return { near: arc(a.near, CLAP_N, smooth(u / to)), far: arc(a.far, CLAP_F, smooth(u / to)) };
    if (u < hold) {
      // the clap: the hands touch and part once (a small out-and-in of the near one)
      const w = (u - to) / (hold - to);
      const dx = -1.6 * Math.sin(Math.PI * w);
      return { near: [CLAP_N[0] + dx * k, CLAP_N[1]], far: [CLAP_F[0], CLAP_F[1]] };
    }
    return { near: arc(CLAP_N, b.near, smooth((u - hold) / (1 - hold))), far: arc(CLAP_F, b.far, smooth((u - hold) / (1 - hold))) };
  }
  return { near: arc(a.near, b.near, smooth(u)), far: arc(a.far, b.far, smooth(u)) };
}

/** What is on screen while the worker goes from `from` to `to` at progress u: hands as `blendHands`, lean, tilt, sway and the head's turn evenly; the rest (a prop, a mark, the facing) is the new one's. */
export function mixTargets(kind: LayerKind, from: Targets, to: Targets, u: number, k = 1): Targets {
  const w = smooth(u);
  const h = blendHands(kind, from, to, u, k);
  return {
    ...to,
    near: h.near,
    far: h.far,
    lean: mix(from.lean, to.lean, w),
    tilt: mix(from.tilt, to.tilt, w),
    sway: mix(from.sway, to.sway, w),
    crouch: mix(from.crouch ?? 0, to.crouch ?? 0, w),
    look: to.look || from.look ? [mix(from.look?.[0] ?? 0, to.look?.[0] ?? 0, w), mix(from.look?.[1] ?? 0, to.look?.[1] ?? 0, w)] : undefined,
  };
}

/**
 * One frame of the layer: given what the worker is doing now (`key`: its pose, or "walk" on a trip) and the targets that says (`T`, the pose's alone — gestures go over it
 * afterwards), the targets to show. `prev`: what was shown the frame before. A change of `key` starts a blend from `prev`; a `jump` (a seek, the tab coming back) resets it.
 */
export function layerStep(layer: Layer | null, key: string, T: Targets, prev: Targets | null, wall: number, jump: boolean, k = 1): { layer: Layer; T: Targets } {
  if (!layer || jump || !prev) return { layer: { key, at: -Infinity, kind: "swap", from: null }, T };
  const l = key === layer.key ? layer : { key, at: wall, kind: kindOf(layer.key, key), from: prev };
  if (!l.from) return { layer: l, T };
  const u = (wall - l.at) / durationOf(l.kind);
  if (u >= 1) return { layer: { ...l, from: null }, T };
  return { layer: l, T: mixTargets(l.kind, l.from, T, Math.max(0, u), k) };
}

export type { Pose };
