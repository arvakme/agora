// A walk is never cut short (./place.ts stateAt; web/docs/workstation.md §小人 时长): work that starts
// while the worker is still walking to the last place does not start another walk from where it
// would have arrived — the worker arrives first, then sets off for the new place: a chain of trips,
// each starting where the last ended. The position is continuous — no jump — at every frame. But never for long: a
// worker that would arrive more than CATCH_UP_MS after the new work began drops that stop and goes for the new
// place from where it is (a trip that takes over, faster), so it is never far behind the log.
import { describe, expect, it } from "vitest";
import { BOOST, CATCH_UP_MS, stateAt, type Ctx } from "./place.ts";
import { tripAt } from "./rig.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, path });
const run = (segs: RunSeg[]): WorkRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [] });
const DOCKS: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 400, y: 0 }, web: { x: 800, y: 0 } };
const at = (p: string) => (p.startsWith("db/") ? "db" : p.startsWith("web/") ? "web" : "api");
const ctx = (r: WorkRun): Ctx => ({ locate: (p) => ({ place: at(p) }), dock: (p) => DOCKS[p], reduced: false, run: (id) => (id === r.id ? r : undefined) });
const where = (r: WorkRun, t: number) => {
  const s = stateAt(r, t, ctx(r));
  return s.trip && s.w < 1 ? tripAt(s.trip, t).root : DOCKS[s.at];
};

describe("work that starts before the last walk is over", () => {
  // 2026-09-29 用户决定调慢走路: walks are now several seconds, so the next work often starts mid-walk.
  const r = run([seg("write", 0, 2, "api/a.py"), seg("write", 2, 10, "db/m.py"), seg("write", 3, 14, "web/w.ts")]);

  it("arrives first, then sets off: the second trip starts when the first ends, from where the first ended", () => {
    const c = ctx(r);
    const first = stateAt(r, 2.5 * S, c);
    expect(first).toMatchObject({ at: "db", from: "api", pose: "walk" });
    const arrive = first.trip!.t1;
    expect(arrive).toBeGreaterThan(3.5 * S); // web's work starts at 3 s, while it is still walking to db
    expect(stateAt(r, arrive - 1, c)).toMatchObject({ at: "db", pose: "walk" });
    const second = stateAt(r, arrive + 1, c);
    expect(second).toMatchObject({ at: "web", from: "db", pose: "walk" });
    expect(second.moves.map((m) => m.t)).toEqual([2 * S, arrive]);
    expect(second.trip!.t0).toBe(arrive);
    expect(stateAt(r, second.trip!.t1 + 1, c)).toMatchObject({ at: "web", pose: "write" });
  });

  it("no jump: the position changes by under 6 px a frame across both trips (a held-back trip walks 1.5× as fast: 5.5 px), at any frame phase", () => {
    for (let off = 0; off < 16; off += 5) {
      let prev = where(r, off);
      for (let t = off + 1000 / 60; t < 16 * S; t += 1000 / 60) {
        const p = where(r, t);
        expect(Math.hypot(p.x - prev.x, p.y - prev.y), `+${Math.round(t)} ms`).toBeLessThan(6);
        prev = p;
      }
    }
  });

  it("is a pure function of t: the same moment gives the same state whether reached by scrubbing or by playing", () => {
    const c = ctx(r);
    const played: unknown[] = [];
    for (let t = 0; t <= 9 * S; t += 250) played.push(stateAt(r, t, c));
    const scrubbed = [...played.keys()].reverse().map((i) => stateAt(r, i * 250, ctx(r)));
    expect(scrubbed.reverse()).toEqual(played);
  });
});

describe("catching up (2026-09-29: 走到再出发 must not pile up lag live)", () => {
  // ten segments 0.5 s apart, hopping between the near and the far place
  const HOP = ["web", "api", "web", "api", "db", "web", "api", "db", "web", "api"];
  const PATH: Record<string, string> = { api: "api/a.py", db: "db/m.py", web: "web/w.ts" };
  const burst = run(HOP.map((p, i) => seg("write", i * 0.5, i * 0.5 + 0.5, PATH[p])));
  const c = ctx(burst);
  const pos = (t: number) => {
    const s = stateAt(burst, t, c);
    return s.trip && s.w < 1 ? tripAt(s.trip, t).root : DOCKS[s.at];
  };
  const latest = (t: number) => {
    const i = Math.min(HOP.length - 1, Math.floor(t / (0.5 * S)));
    return { place: HOP[i], start: i * 0.5 * S };
  };

  it("is never more than 3 s behind: at any moment the newest work has been waiting for the worker to reach it for at most 3 s", () => {
    for (let t = 0; t < 20 * S; t += 1000 / 60) {
      const s = stateAt(burst, t, c);
      const L = latest(t);
      if (s.at === L.place && (!s.trip || t >= s.trip.t1)) continue;
      expect(t - L.start, `+${Math.round(t)} ms: at ${s.at}, newest work at ${L.place}`).toBeLessThanOrEqual(3 * S);
    }
  });

  it("is continuous: the position changes by under 6 px a frame, at any frame phase, through every hand-over", () => {
    for (let off = 0; off < 16; off += 5) {
      let prev = pos(off);
      for (let t = off + 1000 / 60; t < 20 * S; t += 1000 / 60) {
        const p = pos(t);
        expect(Math.hypot(p.x - prev.x, p.y - prev.y), `+${Math.round(t)} ms`).toBeLessThan(6);
        prev = p;
      }
    }
  });

  it("drops a stop that would leave it CATCH_UP_MS behind: the new trip starts at the new work, from where the worker is, faster; a stop under CATCH_UP_MS away is still waited for", () => {
    expect(CATCH_UP_MS).toBe(1500);
    const moves = stateAt(burst, 2 * S, c).moves;
    const cut = moves.find((m) => m.resume);
    expect(cut, "some trip takes over").toBeDefined();
    expect(cut!.boost).toBe(BOOST);
    expect(cut!.t % 500, "starts as its work starts").toBe(0);
    const now = tripAt(stateAt(burst, cut!.t - 1, c).trip!, cut!.t);
    expect(cut!.resume!.at).toEqual(now.root);
    // the short hop of the first test (arrival less than CATCH_UP_MS after the new work): no takeover
    const r = run([seg("write", 0, 2, "api/a.py"), seg("write", 2, 10, "db/m.py"), seg("write", 3, 14, "web/w.ts")]);
    expect(stateAt(r, 6 * S, ctx(r)).moves.every((m) => !m.resume)).toBe(true);
  });

  it("is a pure function of t: scrubbing to a moment gives what playing up to it gives", () => {
    const ts = [0.7, 1.3, 2.2, 3.1, 4.4, 6.9].map((x) => x * S);
    const played = ts.map((t) => stateAt(burst, t, c));
    expect(ts.map((t) => stateAt(burst, t, ctx(burst)))).toEqual(played);
  });
});
