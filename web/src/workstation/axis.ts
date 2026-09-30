// Replay time (web/docs/workstation.md §3 时间线): playback that skips collapsed idle stretches. Pure.

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
