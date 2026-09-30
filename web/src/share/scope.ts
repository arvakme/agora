// What a share covers (server/canvas/share.py `scope`): one canvas and what is nested below it, or every canvas of the project.

export type ShareScope = "canvas" | "project";
/** From GET /api/share: what a project share would cover now (children are counted in canvases). */
export type ProjectSummary = { canvases: number; children: number };

export const projectNote = (s: ProjectSummary) => `整个项目：${s.canvases} 张画布（含 ${s.children} 张子图）。之后新建的画布也自动可见。`;

/** The name a share goes by in the lists. */
export const shareLabel = (r: { scope?: ShareScope; canvasTitle: string; canvasId: string }) => (r.scope === "project" ? "整个项目" : r.canvasTitle || r.canvasId);
