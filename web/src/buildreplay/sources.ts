// The replay's own world (web/docs/share-build-replay.md §5): the canvases as they are at the moment shown and the actors'
// runs, in the shapes the 工位视图 reads from its stores (../nested/store.ts, ../workstation/runs/store.ts) — offered to the replay's
// subtree through their `Source` contexts, so the page's own canvases and sessions are never touched. Canvas ids get a prefix
// so that nothing here can be taken for (or clash with) a canvas of the project.
import type { El } from "../canvas/scene";
import { parentIndex } from "../nested/graph";
import type { NestedState } from "../nested/store";
import type { Runs } from "../workstation/runs/store";
import { flatten } from "../workstation/runs/types";
import { everScenes, Scenes, runsOf, withPlaces, type Plan } from "./plan";
import type { BuildTimeline } from "./types";

const WORLD = "build~";
export const worldId = (canvas: string) => WORLD + canvas;
export const realId = (id: string) => (id.startsWith(WORLD) ? id.slice(WORLD.length) : id);

/** A canvas's elements as the world reads them: every node stands for a file (so the figure can go to it), and a child link points into the world. */
export function worldScene(canvas: string, els: readonly El[]): El[] {
  return withPlaces(canvas, els).map((e) => {
    const c = (e.customData as { childCanvas?: string } | undefined)?.childCanvas;
    return c ? ({ ...e, customData: { ...e.customData, childCanvas: worldId(c) } } as El) : e;
  });
}

type Source<T> = { subscribe: (l: () => void) => () => void; get: () => T };

export class BuildWorld {
  readonly scenes: Scenes;
  readonly runs: Source<Runs>;
  /** The places: every canvas with everything it will ever have, each node standing for a "file" (../workstation/geometry.ts reads it as a project's canvases). Constant: the figures walk to what is not drawn yet. */
  readonly nested: Source<NestedState>;
  /** The pictures: each canvas's elements that have landed by the time shown (world ids, as they are, for the SVG). */
  readonly visible: Source<ReadonlyMap<string, readonly El[]>>;
  private shown: ReadonlyMap<string, readonly El[]>;
  private key = "";
  private listeners = new Set<() => void>();

  constructor(
    private tl: BuildTimeline,
    private plan: Plan,
    readonly epoch: number,
  ) {
    this.scenes = new Scenes(tl, plan);
    const roots = runsOf(plan, epoch);
    const flat = flatten(roots);
    const value: Runs = { roots, flat, byId: new Map(flat.map((f) => [f.run.id, f.run])), at: epoch };
    this.runs = { subscribe: () => () => {}, get: () => value };
    const scenes = new Map([...everScenes(tl)].map(([c, els]) => [worldId(c), worldScene(c, els)] as const));
    const titles = Object.fromEntries(Object.entries(tl.canvases).map(([c, m]) => [worldId(c), m.title || c]));
    const state: NestedState = { scenes, titles, reviewed: {}, index: parentIndex(scenes) };
    this.nested = { subscribe: () => () => {}, get: () => state };
    this.shown = this.at(0);
    this.key = this.keyAt(0);
    this.visible = {
      subscribe: (l) => (this.listeners.add(l), () => void this.listeners.delete(l)),
      get: () => this.shown,
    };
  }

  private at(t: number): ReadonlyMap<string, readonly El[]> {
    return new Map(Object.keys(this.tl.canvases).map((c) => [worldId(c), this.scenes.at(c, t)] as const));
  }

  private keyAt(t: number): string {
    return Object.keys(this.tl.canvases)
      .map((c) => `${c}:${this.scenes.count(c, t)}`)
      .join("|");
  }

  /** The play time (ms from the opening) now: the pictures change when a beat has landed. */
  setTime(t: number): void {
    const key = this.keyAt(t);
    if (key === this.key) return;
    this.key = key;
    this.shown = this.at(t);
    this.listeners.forEach((l) => l());
  }
}
