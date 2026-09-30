// What counts as one diagram node when a person selects something. A plain box
// is its own node; a group (an inserted library icon, or shapes the person grouped) is one node,
// whatever part of it is selected; a bound label stands for its box. The node is the element that
// carries the node's data (`customData.codePaths`, `customData.childCanvas`) and the id the model
// view exposes (modelView.ts): a library icon's transparent root, or for a plain group its main
// shape. Pure (type-only imports), so it runs under vitest in node.
import { labelOf } from "../nested/graph";
import { footprint, type Box } from "./clearance";
import { isJunction } from "./lines";
import type { El } from "./scene";

const live = (e: El | undefined): e is El => !!e && !e.isDeleted;
const isNode = (e: El) => (e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" || e.type === "frame") && !isJunction(e); // a junction dot is where lines meet, not a node
const meta = (e: El | undefined) => (e?.customData as { agora?: { library?: string; group?: string } } | undefined)?.agora;
const libGroup = (e: El | undefined) => (meta(e)?.library ? meta(e)?.group : undefined);
const cd = (e: El) => (e.customData ?? {}) as { childCanvas?: unknown; codePaths?: unknown };
const hasChild = (e: El) => typeof cd(e).childCanvas === "string" && !!cd(e).childCanvas;
const hasPaths = (e: El) => Array.isArray(cd(e).codePaths) && (cd(e).codePaths as unknown[]).length > 0;
/** The outermost group an element belongs to (Excalidraw lists groups innermost first). */
export const outerGroup = (e: El): string | undefined => e.groupIds?.at(-1);

/**
 * The element that stands for group `g` as a node: the library icon whose group it is; else, of
 * the group's nodes (shapes and frames, a library icon counting once by its root), the one that
 * already opens a child canvas, then one with code paths, then the largest.
 */
export function groupNode(g: string, all: readonly El[]): El | undefined {
  const members = all.filter((m) => live(m) && m.groupIds?.includes(g));
  const root = members.find((m) => libGroup(m) === g);
  if (root) return root;
  const icons = new Set(members.map(libGroup).filter((x): x is string => !!x));
  const nodes = members.filter((m) => isNode(m) && (libGroup(m) || !m.groupIds.some((x) => icons.has(x))));
  const area = (m: El) => Math.abs(m.width * m.height);
  return nodes.find(hasChild) ?? nodes.find(hasPaths) ?? nodes.reduce<El | undefined>((best, m) => (!best || area(m) > area(best) ? m : best), undefined);
}

/** The library icon an element is a part of (its transparent root), if any. */
function iconOf(e: El, all: readonly El[]): El | undefined {
  if (libGroup(e) || !e.groupIds?.length) return undefined;
  const gs = new Set(e.groupIds);
  return all.find((m) => live(m) && m !== e && !!libGroup(m) && gs.has(libGroup(m)!));
}

/**
 * How groups are read: "all" — any outermost group is one node (what a click selects on the
 * canvas); "icons" — only a library icon is one node, shapes the person grouped stay separate
 * nodes (what the model view lists, and what the canvas shows while editing inside a group).
 */
export type Grouping = "all" | "icons";

/** The node an element is part of (itself, its label's box, or its group's node), if any. */
export function nodeOf(el: El | undefined, map: ReadonlyMap<string, El>, all: readonly El[], grouping: Grouping = "all"): El | undefined {
  if (!live(el)) return undefined;
  let e = el;
  if (e.type === "text" && e.containerId) {
    const c = map.get(e.containerId);
    if (!live(c) || c.type === "arrow") return undefined; // an arrow's label is not a node
    e = c;
  }
  if (grouping === "icons") {
    const icon = iconOf(e, all);
    if (icon) return icon;
    if (isNode(e)) return e;
    const g = outerGroup(e); // a free caption grouped with its shape
    return g ? groupNode(g, all) : undefined;
  }
  const g = outerGroup(e);
  if (g) return groupNode(g, all);
  return isNode(e) ? e : undefined;
}

/**
 * The one node a selection stands for, or undefined when it spans several nodes (or none).
 * Elements that are not part of any node (a loose arrow, free text) don't count.
 */
export function selectedNode(ids: Iterable<string>, map: ReadonlyMap<string, El>, all: readonly El[], grouping: Grouping = "all"): El | undefined {
  const byGroup = new Map<string, El | undefined>();
  const found = new Set<El>();
  for (const id of ids) {
    const e = map.get(id);
    if (!live(e)) continue;
    const c = e.type === "text" && e.containerId ? map.get(e.containerId) : e;
    const g = grouping === "all" && c ? outerGroup(c) : undefined;
    let n: El | undefined;
    if (g) {
      if (!byGroup.has(g)) byGroup.set(g, groupNode(g, all));
      n = byGroup.get(g);
    } else n = nodeOf(e, map, all, grouping);
    if (n) found.add(n);
    if (found.size > 1) return undefined;
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** What the node looks like on the canvas: its box, label and every part of its group (scene units). */
export const nodeBox = (node: El, map: Map<string, El>, all: readonly El[]): Box => footprint(node, map, all);

/**
 * What an agent names with `--node` (agora canvas link / child): an element id — a library icon's
 * part or label stands for the icon, a label for its box —, a group id, or the exact label of one
 * node (case-insensitive). Resolves to the id the model view lists for that node.
 */
export function resolveNode(ref: string, scene: readonly El[]): { id?: string; error?: string } {
  const map = new Map(scene.map((e) => [e.id, e]));
  const direct = nodeOf(map.get(ref), map, scene, "icons");
  if (direct) return { id: direct.id };
  if (scene.some((e) => live(e) && e.groupIds?.includes(ref))) {
    const g = groupNode(ref, scene);
    if (g) return { id: g.id };
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = (e: El) => live(e) && isNode(e) && !iconOf(e, scene);
  const hits = scene.filter((e) => target(e) && norm(labelOf(e, map)) === norm(ref));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `"${ref}" matches ${hits.length} elements (${hits.map((h) => h.id).join(", ")}): pass an id` };
  return { error: `no box or frame with id or label "${ref}" (see \`agora canvas read\`)` };
}
