// What a share covers (server/canvas/share.py `scope`): one canvas and what is nested below it, or every canvas of the project.
import { tr } from "../i18n";

export type ShareScope = "canvas" | "project";
/** From GET /api/share: what a project share would cover now (children are counted in canvases). */
export type ProjectSummary = { canvases: number; children: number };

export const projectNote = (s: ProjectSummary) =>
  tr(
    `整个项目：${s.canvases} 张画布（含 ${s.children} 张子图）。之后新建的画布也自动可见。`,
    `The whole project: ${s.canvases} ${s.canvases === 1 ? "canvas" : "canvases"} (${s.children} ${s.children === 1 ? "is a sub-diagram" : "are sub-diagrams"}). Canvases created later become visible too.`,
  );

/** The name a share goes by in the lists. */
export const shareLabel = (r: { scope?: ShareScope; canvasTitle: string; canvasId: string }) => (r.scope === "project" ? tr("整个项目", "Whole project") : r.canvasTitle || r.canvasId);
