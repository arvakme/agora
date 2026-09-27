// Model-facing projection of the scene. It uses Excalidraw's own skeleton vocabulary
// (the input format of convertToExcalidrawElements: type/x/y/width/height/label,
// arrows with start/end ids) and drops everything the model can't reason about
// (seeds, nonces, fractional indices, styles, bound-text elements).
import { byId, codePathsOf, isArrow, isShape, labelOf, libraryMeta, type El, type Scene } from "./scene";

export type SkeletonNode = { id: string; type: string; label: string; x: number; y: number; width: number; height: number; frameId?: string; component?: string; codePaths?: string[] };
export type SkeletonArrow = { id: string; type: "arrow"; start: { id: string } | null; end: { id: string } | null; label?: string; bothEnds?: true };
export type SkeletonFrame = { id: string; type: "frame"; name: string; x: number; y: number; width: number; height: number; children: string[]; codePaths?: string[] };
export type ModelView = { nodes: SkeletonNode[]; arrows: SkeletonArrow[]; frames: SkeletonFrame[] };

const r = Math.round;

export function toModelView(scene: Scene): ModelView {
  const map = byId(scene);
  // An inserted library component is one node (its transparent root); its parts are hidden.
  const libGroups = new Set(scene.filter((e) => !e.isDeleted).map((e) => libraryMeta(e)?.group).filter(Boolean));
  const inside = (e: El) => !libraryMeta(e) && e.groupIds.some((g) => libGroups.has(g));
  const liveEls = scene.filter((e) => !e.isDeleted && !inside(e));
  const nodes = liveEls.filter(isShape).map((e) => ({
    id: e.id,
    type: libraryMeta(e) ? "library" : e.type,
    ...(libraryMeta(e) ? { component: libraryMeta(e)!.name } : {}),
    label: labelOf(e, map),
    x: r(e.x),
    y: r(e.y),
    width: r(e.width),
    height: r(e.height),
    ...(e.frameId ? { frameId: e.frameId } : {}),
    ...(codePathsOf(e).length ? { codePaths: codePathsOf(e) } : {}),
  }));
  const arrows = liveEls.filter(isArrow).map((e) => {
    const label = labelOf(e, map);
    return {
      id: e.id,
      type: "arrow" as const,
      start: e.startBinding ? { id: e.startBinding.elementId } : null,
      end: e.endBinding ? { id: e.endBinding.elementId } : null,
      ...(label ? { label } : {}),
      ...(e.startArrowhead ? { bothEnds: true as const } : {}),
    };
  });
  const frames = liveEls
    .filter((e) => e.type === "frame")
    .map((e) => ({
      id: e.id,
      type: "frame" as const,
      name: labelOf(e, map),
      x: r(e.x),
      y: r(e.y),
      width: r(e.width),
      height: r(e.height),
      children: liveEls.filter((c) => c.frameId === e.id && isShape(c)).map((c) => c.id),
      ...(codePathsOf(e).length ? { codePaths: codePathsOf(e) } : {}),
    }));
  return { nodes, arrows, frames };
}
