// The timeline's time axis (web/docs/workstation.md §时间线): real time where someone is working,
// and a fixed-width break for any stretch where nobody did anything for longer than `gapMs`
// (including the idle tail up to now). Activity always fills the width however long the page
// stays open; the idle time is still stated in words. Ticks adapt to the pixels per second. Pure.

export type Piece = { kind: "act" | "gap" | "tail"; a: number; b: number; x0: number; x1: number };
export type Axis = {
  start: number;
  end: number;
  pieces: Piece[];
  /** px per ms inside activity. */
  pps: number;
  width: number;
  toPx: (t: number) => number;
  fromPx: (px: number) => number;
  /** The collapsed stretch t falls in, if any. */
  gapAt: (t: number) => Piece | null;
};

export type AxisOpts = { gapMs?: number; gapPx?: number; minActiveMs?: number };

/** One axis for all lanes over the activity intervals [a, b] (ms) up to `now`, `width` px wide. */
export function buildAxis(intervals: readonly (readonly [number, number])[], now: number, width: number, o: AxisOpts = {}): Axis {
  const gapMs = o.gapMs ?? 20_000;
  const gapPx = o.gapPx ?? 64;
  const minActive = o.minActiveMs ?? 30_000;
  const iv = intervals.filter(([a]) => a < now).map(([a, b]) => [a, Math.min(b, now)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const runs: [number, number][] = [];
  for (const [a, b] of iv) {
    const r = runs[runs.length - 1];
    if (r && a <= r[1] + gapMs) r[1] = Math.max(r[1], b);
    else runs.push([a, b]);
  }
  if (!runs.length) runs.push([now - minActive, now]);
  const pieces: Piece[] = [];
  runs.forEach((r, i) => {
    if (i) pieces.push({ kind: "gap", a: runs[i - 1][1], b: r[0], x0: 0, x1: 0 });
    pieces.push({ kind: "act", a: r[0], b: r[1], x0: 0, x1: 0 });
  });
  const last = runs[runs.length - 1];
  if (now - last[1] > gapMs) pieces.push({ kind: "tail", a: last[1], b: now, x0: 0, x1: 0 });
  else last[1] = Math.max(last[1], now);
  const act = pieces.filter((p) => p.kind === "act").reduce((s, p) => s + (p.b - p.a), 0);
  const nGap = pieces.filter((p) => p.kind !== "act").length;
  // Breaks never take more than 40% of the width together (a sparse history stays readable).
  const gw = nGap ? Math.min(gapPx, Math.max(10, (width * 0.4) / nGap)) : gapPx;
  const pps = Math.max(1e-6, (width - nGap * gw - 10) / Math.max(act, minActive));
  let x = 0;
  for (const p of pieces) {
    p.x0 = x;
    x += p.kind === "act" ? (p.b - p.a) * pps : gw;
    p.x1 = x;
  }
  const toPx = (t: number) => {
    if (t <= pieces[0].a) return 0;
    for (const p of pieces) if (t <= p.b) return p.x0 + ((t - p.a) / Math.max(1e-6, p.b - p.a)) * (p.x1 - p.x0);
    return pieces[pieces.length - 1].x1;
  };
  const fromPx = (px: number) => {
    if (px <= 0) return pieces[0].a;
    for (const p of pieces) if (px <= p.x1) return p.a + ((px - p.x0) / Math.max(1e-6, p.x1 - p.x0)) * (p.b - p.a);
    return now;
  };
  return { start: pieces[0].a, end: now, pieces, pps, width, toPx, fromPx, gapAt: (t) => pieces.find((p) => p.kind !== "act" && t > p.a && t < p.b) ?? null };
}

export type Tick = { t: number; x: number; major: boolean; label: string };
const STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const pad = (n: number) => String(n).padStart(2, "0");
export const hhmmss = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * Ticks: the step comes from pixels per second so labels are ≥ ~72 px apart; minor ticks get a
 * short ":ss" label only when there is room; a label that would overlap another, or run into a
 * break, is dropped (the tick stays).
 */
export function ticks(A: Axis, fmt: (t: number) => string = hhmmss): Tick[] {
  const ppsS = A.pps * 1000;
  const major = STEPS_S.find((s) => s * ppsS >= 72) ?? STEPS_S[STEPS_S.length - 1];
  const minor = [...STEPS_S].reverse().find((s) => s < major && major % s === 0 && s * ppsS >= 10);
  const step = (minor ?? major) * 1000;
  const out: Tick[] = [];
  let lastR = -1e9;
  // Wall-clock seconds, so ticks land on round local times.
  const off = new Date(A.start).getTimezoneOffset() * 60_000;
  for (const p of A.pieces) {
    if (p.kind !== "act") continue;
    for (let k = Math.ceil((p.a - off) / step) * step + off; k <= p.b; k += step) {
      const x = A.toPx(k);
      const isMaj = Math.round((k - off) / 1000) % major === 0;
      const text = isMaj ? fmt(k) : step / 1000 * ppsS >= 46 ? `:${pad(new Date(k).getSeconds())}` : "";
      const w = isMaj ? 56 : 22;
      let label = "";
      if (text && x - w / 2 >= lastR + 10 && x - w / 2 >= Math.max(0, p.x0 - 4) && x + w / 2 <= Math.min(A.width, p.x1 + 4)) {
        label = text;
        lastR = x + w / 2;
      }
      out.push({ t: k, x, major: isMaj, label });
    }
  }
  return out;
}

/**
 * Replay position after `elapsed` ms of playback from `at`, skipping collapsed stretches (pure):
 * playing through an hour's lunch break takes no time.
 */
export function advance(at: number, elapsed: number, gaps: readonly { a: number; b: number }[]): number {
  let t = at;
  let left = elapsed;
  for (const g of [...gaps].sort((x, y) => x.a - y.a)) {
    if (g.b <= t) continue;
    if (g.a <= t) {
      t = g.b; // starting inside a break: jump out of it
      continue;
    }
    if (t + left < g.a) return t + left;
    left -= g.a - t;
    t = g.b;
  }
  return t + left;
}
