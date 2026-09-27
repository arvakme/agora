// Writing code paths onto diagram elements: one undoable scene update (⌘Z in the canvas) that
// also yields an undo batch for the session card when an agent did it (`agora canvas link`).
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { byId, codePathsOf, isShape, labelOf, live, type El } from "../canvas/scene";
import type { Batch } from "../ops/apply";
import type { Link } from "./codeLinks";

export const cleanGlobs = (globs: string[]) => [...new Set(globs.map((g) => g.trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean))];

/** Set each element's code paths (empty list removes them). Returns the undo batch, or null when nothing changed. */
export function writeCodePaths(api: ExcalidrawImperativeAPI, updates: Map<string, string[]>): Batch | null {
  const scene = api.getSceneElementsIncludingDeleted() as readonly El[];
  const before = new Map<string, El | null>();
  const next = scene.map((e) => {
    const paths = updates.get(e.id);
    if (!paths) return e;
    const clean = cleanGlobs(paths);
    if (JSON.stringify(clean) === JSON.stringify(codePathsOf(e))) return e;
    before.set(e.id, e);
    const { codePaths: _old, ...rest } = (e.customData ?? {}) as Record<string, unknown>;
    return {
      ...e,
      customData: clean.length ? { ...rest, codePaths: clean } : Object.keys(rest).length ? rest : undefined,
      version: e.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as El;
  });
  if (!before.size) return null;
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  const settled = byId(api.getSceneElementsIncludingDeleted() as readonly El[]);
  return { before, after: new Map([...before.keys()].map((id) => [id, settled.get(id)!.version])) };
}

/** Resolve what an agent named: an element id, or the exact label of one box / frame (case-insensitive). */
export function resolveElement(ref: string, scene: readonly El[]): { id?: string; error?: string } {
  const map = byId(scene);
  const target = (e: El | undefined) => live(e) && (isShape(e!) || e!.type === "frame");
  if (target(map.get(ref))) return { id: ref };
  const t = map.get(ref);
  if (live(t) && t.type === "text" && t.containerId && target(map.get(t.containerId))) return { id: t.containerId };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const hits = scene.filter((e) => target(e) && norm(labelOf(e, map)) === norm(ref));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `"${ref}" matches ${hits.length} elements (${hits.map((h) => h.id).join(", ")}): pass an id` };
  return { error: `no box or frame with id or label "${ref}" (see \`agora canvas read\`)` };
}

/** The elements that carry code paths (live boxes and frames). */
export function linksOf(elements: readonly El[]): Link[] {
  const map = new Map(elements.map((e) => [e.id, e]));
  return elements
    .filter((e) => !e.isDeleted && (isShape(e) || e.type === "frame") && codePathsOf(e).length)
    .map((e) => ({ id: e.id, label: labelOf(e, map).replace(/\s+/g, " ").trim() || e.id, globs: codePathsOf(e) }));
}

