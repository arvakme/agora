// How long the figure really takes (web/docs/share-build-replay.md §5): the walks of ./plan.ts measured on the canvases' own geometry —
// the same docks, bridges, ladders and scaffolds the 工位视图 walks (../workstation/geometry.ts, place.ts `planFor`), on every canvas with everything it ever
// had. So when the canvas changes "as the figure gets there", it has got there.
import { buildGeometry, type Geometry } from "../workstation/geometry";
import { planFor } from "../workstation/place";
import { entranceOf } from "../workstation/scenePlaces";
import { everScenes, type PlanOptions } from "./plan";
import { worldId, worldScene } from "./sources";
import type { BuildTimeline } from "./types";

export function geometryWalk(tl: BuildTimeline): Pick<Required<PlanOptions>, "walk" | "entrance"> {
  const ever = everScenes(tl);
  const scenes = new Map([...ever].map(([c, els]) => [worldId(c), worldScene(c, els)] as const));
  const titles = (id: string) => tl.canvases[id.replace(/^build~/, "")]?.title;
  const geo = new Map<string, Geometry>();
  for (const [c] of ever) {
    const els = scenes.get(worldId(c)) ?? [];
    geo.set(c, buildGeometry(worldId(c), els, new Map(els.map((e) => [e.id, e])), scenes, titles));
  }
  const memo = new Map<string, number>();
  return {
    walk(canvas, from, to) {
      const g = geo.get(canvas);
      if (!g || !from || from === to || !g.boxOf(from) || !g.boxOf(to)) return 500;
      const key = `${canvas}|${from}|${to}`;
      let ms = memo.get(key);
      if (ms == null) {
        const trip = planFor({ from, to, t: 0, slot: 0 }, g);
        memo.set(key, (ms = trip.t1 - trip.t0));
      }
      return ms;
    },
    entrance: (canvas) => (geo.get(canvas) ? (entranceOf(geo.get(canvas)!.boxes) ?? null) : null),
  };
}
