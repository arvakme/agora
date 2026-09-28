// Nested canvases (web/docs/nested-canvas.md): a diagram node can stand for a whole canvas one
// level down. The link lives on the parent node only — `customData.childCanvas = "<canvas id>"`
// (the id, never a path or file name) — so a child is an ordinary canvas and everything else
// (parents, breadcrumbs, roll-ups) is derived from the scenes. Pure functions only.
import type { El } from "../canvas/scene";
import { elementFor, type Link } from "../pointer/codeLinks";
import type { FileTouch } from "../session/trajectoryModel";

export type Scenes = ReadonlyMap<string, readonly El[]>;
export type ParentRef = { canvasId: string; elementId: string };

// Pure (type-only imports from scene.ts, which pulls in Excalidraw), so it runs under vitest in node.
const live = (e: El | undefined): e is El => !!e && !e.isDeleted;
const NODE = (e: El) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" || e.type === "frame";
const codePathsOf = (el: El): string[] => {
  const v = (el.customData as { codePaths?: unknown } | undefined)?.codePaths;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
};
/** Same as scene.ts labelOf for boxes, frames and library components. */
export function labelOf(el: El, map: ReadonlyMap<string, El>): string {
  const text = (id: string | undefined) => {
    const t = id ? map.get(id) : undefined;
    return t && !t.isDeleted && t.type === "text" ? (t as unknown as { text: string }).text : undefined;
  };
  const lib = (el.customData as { agora?: { library?: string; name?: string; label?: string } } | undefined)?.agora;
  if (lib?.library) return text(lib.label) ?? lib.name ?? "";
  if (el.type === "frame") return (el as unknown as { name?: string }).name ?? "";
  return text(el.boundElements?.find((b) => b.type === "text")?.id) ?? "";
}

/** The canvas a node opens into, if any. */
export function childOf(el: El | undefined): string | null {
  const v = (el?.customData as { childCanvas?: unknown } | undefined)?.childCanvas;
  return typeof v === "string" && v ? v : null;
}

/** Live nodes of a scene that link to a child canvas that exists. */
export function childLinks(scene: readonly El[], exists: (id: string) => boolean = () => true): { elementId: string; canvasId: string }[] {
  const out: { elementId: string; canvasId: string }[] = [];
  for (const e of scene) {
    const c = childOf(e);
    if (c && live(e) && NODE(e) && exists(c)) out.push({ elementId: e.id, canvasId: c });
  }
  return out;
}

/**
 * child canvas → the node that opens it. A child linked from two nodes (a copied node carries
 * its customData) takes the first in canvas order, then scene order; self links are ignored.
 */
export function parentIndex(scenes: Scenes): Map<string, ParentRef> {
  const out = new Map<string, ParentRef>();
  for (const [canvasId, scene] of scenes)
    for (const l of childLinks(scene, (id) => scenes.has(id)))
      if (l.canvasId !== canvasId && !out.has(l.canvasId)) out.set(l.canvasId, { canvasId, elementId: l.elementId });
  return out;
}

/** Root → … → `id` (cycle-safe: a loop stops where it would repeat). */
export function ancestry(id: string, index: ReadonlyMap<string, ParentRef>): string[] {
  const chain = [id];
  const seen = new Set(chain);
  for (let p = index.get(id); p && !seen.has(p.canvasId); p = index.get(p.canvasId)) {
    chain.unshift(p.canvasId);
    seen.add(p.canvasId);
  }
  return chain;
}

/** Every canvas reachable downwards from `id` (not including it). */
export function descendants(id: string, scenes: Scenes): Set<string> {
  const out = new Set<string>();
  const walk = (c: string) => {
    for (const l of childLinks(scenes.get(c) ?? [], (x) => scenes.has(x)))
      if (l.canvasId !== id && !out.has(l.canvasId)) (out.add(l.canvasId), walk(l.canvasId));
  };
  walk(id);
  return out;
}

/** Linking `child` under a node of `parent` would make a loop. */
export const wouldCycle = (parent: string, child: string, scenes: Scenes) => parent === child || descendants(child, scenes).has(parent);

export type NestedLink = Link & { own: string[]; child?: string };

/**
 * The code-path links of a canvas as the pointer sees them: each node's own globs, plus, for a
 * node that opens a child canvas, every glob anywhere below it. So a file the child's finer nodes
 * claim still lights the parent node on the overview (docs/progress-pointer.md §3).
 */
export function effectiveLinks(canvasId: string, scenes: Scenes, seen: Set<string> = new Set()): NestedLink[] {
  const scene = scenes.get(canvasId) ?? [];
  const map = new Map(scene.map((e) => [e.id, e]));
  seen.add(canvasId);
  const out: NestedLink[] = [];
  for (const e of scene) {
    if (!live(e) || !NODE(e)) continue;
    const own = codePathsOf(e);
    const child = childOf(e);
    const below = child && scenes.has(child) && !seen.has(child) ? effectiveLinks(child, scenes, new Set(seen)).flatMap((l) => l.globs) : [];
    const globs = [...new Set([...own, ...below])];
    if (!globs.length) continue;
    out.push({ id: e.id, label: labelOf(e, map).replace(/\s+/g, " ").trim() || e.id, globs, own, ...(child ? { child } : {}) });
  }
  return out;
}

/** When a canvas was last drawn: the newest element change (Excalidraw's `updated`). */
export const drawnAt = (scene: readonly El[]) => scene.reduce((m, e) => Math.max(m, live(e) ? (e.updated ?? 0) : 0), 0);

export type Staleness = {
  /** Writes to code the child covers that happened after the child was last drawn (or reviewed). */
  files: FileTouch[];
  /** Child nodes whose own code changed after the node itself was last changed. */
  nodes: string[];
};

/**
 * A child canvas may be out of date when code it describes was written after it was drawn.
 * `parentGlobs` are the parent node's own paths (they count as the child's area too);
 * `reviewedAt` is when the person said "still fine" (it moves the drawing time forward).
 */
export function staleness(childId: string, scenes: Scenes, writes: readonly FileTouch[], parentGlobs: string[] = [], reviewedAt = 0): Staleness {
  const scene = scenes.get(childId) ?? [];
  const since = Math.max(drawnAt(scene), reviewedAt);
  const links = effectiveLinks(childId, scenes);
  const area: Link[] = [...links, ...(parentGlobs.length ? [{ id: "\u0000parent", label: "", globs: parentGlobs }] : [])];
  const files = writes.filter((w) => w.at > since && elementFor(w.path, area));
  const map = new Map(scene.map((e) => [e.id, e]));
  const nodes = new Set<string>();
  for (const w of writes) {
    const hit = elementFor(w.path, links);
    if (!hit) continue;
    const el = map.get(hit.link.id);
    if (el && w.at > Math.max(el.updated ?? 0, reviewedAt)) nodes.add(el.id);
  }
  return { files, nodes: [...nodes] };
}

/** Open comment threads in a set of canvases (unresolved, not deleted, with a visible message). */
export const openThreads = (threads: readonly { resolved: boolean; deleted?: boolean; messages: { deleted?: boolean }[] }[]) =>
  threads.filter((t) => !t.resolved && !t.deleted && t.messages.some((m) => !m.deleted)).length;
