// Footprints on the diagram (web/docs/workstation.md「新想法」): along each node's top edge, where the
// workers stand, a short trail of faint purple prints — more of them, and a little darker, where
// workers stood and wrote longer (./footprints.ts), up to the time shown: a replay counts only what
// had happened by the playhead. World coordinates: mount it first inside the overlay's world group, so
// it shares the figures' transform and lies under the rings and the figures. Rebuilt when the runs
// refresh or the replay moves (≤ 4 Hz), never per frame. On by default; ⋯ →「小人的脚印」turns it off.
import { memo, useMemo } from "react";
import { usePrefs } from "../app/prefs";
import type { Box } from "../canvas/clearance";
import { useReplayAt, useWorkstation } from "./clock";
import { footprints } from "./footprints";
import type { Ctx } from "./place";
import { useRuns } from "./runs/store";

/** Prints along the busiest node; every other node has fewer, by density (at least two). */
const MAX = 12;
/** World units from one print to the next. */
const STEP = 8;

export function FootprintLayer({ ctx, boxOf }: { ctx: Ctx; boxOf: (place: string) => Box | undefined }) {
  const p = usePrefs();
  const ws = useWorkstation();
  const runs = useRuns();
  const replayAt = useReplayAt();
  // live: the runs refresh every second while anyone works (a running segment ends at "now")
  const t = Math.floor((replayAt ?? runs.at) / 1000) * 1000;
  const on = p.footprints && ws;
  const list = useMemo(() => (on ? footprints(runs.flat.map((f) => f.run), ctx, -Infinity, t) : []), [on, runs, ctx, t]);
  if (!list.length) return null;
  return (
    <g className="ws-prints" aria-hidden>
      {list.map((f) => {
        const b = boxOf(f.place);
        if (!b) return null;
        // from where the first worker stands (docks.ts: 24 in from the left), never past the right end
        const x0 = b.x + Math.min(24, b.w / 4) - STEP / 2;
        const room = Math.max(2, Math.floor((b.x + b.w - 6 - x0) / STEP) + 1);
        const n = Math.min(room, Math.max(2, Math.round(f.density * MAX)));
        return <Prints key={f.place} x0={x0} y={b.y} n={n} a={Math.round((0.12 + 0.26 * f.density) * 50) / 50} />;
      })}
    </g>
  );
}

/** One node's trail: left and right prints by turns just above its top edge, fading toward its end. */
const Prints = memo(function Prints({ x0, y, n, a }: { x0: number; y: number; n: number; a: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <ellipse key={i} cx={x0 + i * STEP} cy={y - (i % 2 ? 5.2 : 2.8)} rx={2.3} ry={1.2} fill="var(--accent)" opacity={(a * (1 - (0.55 * i) / MAX)).toFixed(3)} />
      ))}
    </>
  );
});
