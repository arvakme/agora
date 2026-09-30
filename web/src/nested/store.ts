// The page's view of every canvas's scene, for nesting (parents, breadcrumbs, roll-ups) across
// canvases that are not open. The app shell feeds it (App.tsx); layers read it. Also the
// navigation actions the shell provides (enter a child, go back up) and the URL they keep in sync.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { El } from "../canvas/scene";
import { parentIndex, type ParentRef } from "./graph";

export type NestedState = {
  scenes: ReadonlyMap<string, readonly El[]>;
  titles: Readonly<Record<string, string>>;
  /** When the person marked a child canvas "still current" (canvas doc `reviewedAt`). */
  reviewed: Readonly<Record<string, number>>;
  index: ReadonlyMap<string, ParentRef>;
};

let scenes = new Map<string, readonly El[]>();
let titles: Record<string, string> = {};
let reviewed: Record<string, number> = {};
let state: NestedState = { scenes, titles, reviewed, index: new Map() };
const ls = new Set<() => void>();
/** A child that just lost its parent node (the node was deleted): the shell tells the person. */
const lostLs = new Set<(lost: { child: string; parent: string }) => void>();

function publish(prev: ReadonlyMap<string, ParentRef>) {
  const index = parentIndex(scenes);
  state = { scenes, titles, reviewed, index };
  for (const [child, p] of prev)
    if (!index.has(child) && scenes.has(child) && scenes.has(p.canvasId)) lostLs.forEach((f) => f({ child, parent: p.canvasId }));
  ls.forEach((l) => l());
}

export const nested = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  onLost: (f: (lost: { child: string; parent: string }) => void) => (lostLs.add(f), () => void lostLs.delete(f)),
  /** Replace everything (boot). */
  reset(all: Iterable<[string, readonly El[]]>, t: Record<string, string>, r: Record<string, number> = {}) {
    scenes = new Map(all);
    titles = t;
    reviewed = r;
    state = { scenes, titles, reviewed, index: parentIndex(scenes) };
    ls.forEach((l) => l());
  },
  setScene(id: string, elements: readonly El[]) {
    const prev = state.index;
    scenes = new Map(scenes).set(id, elements);
    publish(prev);
  },
  /** A deleted canvas: its children become top-level canvases (they are not deleted). */
  remove(id: string) {
    if (!scenes.has(id)) return;
    scenes = new Map(scenes);
    scenes.delete(id);
    publish(new Map()); // no "lost" notice: deleting a canvas is its own, confirmed action
  },
  setMeta(t: Record<string, string>, r: Record<string, number>) {
    if (JSON.stringify(t) === JSON.stringify(titles) && JSON.stringify(r) === JSON.stringify(reviewed)) return;
    titles = t;
    reviewed = r;
    state = { ...state, titles, reviewed };
    ls.forEach((l) => l());
  },
};
/** Where a subtree gets its canvases from: the page's own (default), or another set — the build replay's (../buildreplay/). */
export const NestedSource = createContext<{ subscribe: (l: () => void) => () => void; get: () => NestedState } | null>(null);
export const useNested = () => {
  const source = useContext(NestedSource) ?? nested;
  return useSyncExternalStore(source.subscribe, source.get);
};

/** Filled in by the app shell (or the guest page). */
export const nav = {
  /** Show `to` in place of `from` (same tab), pushing a history entry. */
  go: (_from: string, _to: string) => {},
  /** Make a new blank canvas for a node's child (no tab); resolves with its id. */
  createChild: async (_title: string): Promise<string | undefined> => undefined,
  /** Remember that the person checked a child canvas against the code at this time. */
  review: (_canvasId: string, _at: number) => {},
};

/**
 * 新建空白子图: make the canvas, link the node to it, then go there — in that order, so the link
 * is in the parent's scene when `go` takes the parent's live scene with it (App.tsx) and the
 * parent's view unmounts.
 */
export async function blankChild(canvasId: string, title: string, link: (child: string) => unknown, shell: Pick<typeof nav, "createChild" | "go"> = nav): Promise<string | undefined> {
  const id = await shell.createChild(title);
  if (!id) return undefined;
  link(id);
  shell.go(canvasId, id);
  return id;
}

/** `?canvas=<id>` in the address bar, keeping every other parameter. */
export function urlFor(canvasId: string, href = location.href): string {
  const u = new URL(href);
  u.searchParams.set("canvas", canvasId);
  return `${u.pathname}${u.search}${u.hash}`;
}
export const canvasFromUrl = (href = location.href) => new URL(href).searchParams.get("canvas");
