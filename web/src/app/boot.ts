// Settling the workspace before the first render (main.tsx → prepareBoot → App). Pure apart from
// the sessions store, so it is tested without the canvas (boot.test.ts).
import type { El } from "../canvas/scene";
import type { ThreadSnapshot } from "../comments/threads";
import type { FileError, LocalChange, ProjectInfo } from "../persist";
import { sessions } from "../session/store";
import { group, moveTab, type Node } from "../workspace/layout";
import { migrateDocs, recoverWorkspace, sessionDocId, type Doc } from "../workspace/model";

export type WorkspaceState = { v?: 2; docs: Doc[]; root: Node; focused: string };
export type Boot = {
  workspace?: WorkspaceState;
  canvases: Record<string, { elements: El[]; threads: ThreadSnapshot }>;
  project?: ProjectInfo;
  /** The server says the project has nothing yet (no workspace.json, no canvas file). Absent: not persisted (?fresh, ?eval). */
  empty?: boolean;
  /** Project files the server could not read. */
  errors?: FileError[];
  firstRun?: boolean;
  /** The list was rebuilt from the files on disk (recovery mode), and why. */
  recovered?: { canvases: number; sessions: number; why: "missing" | "unreadable" };
  /** This copy of the project was moved, copied or freshly cloned since the page last looked. */
  change?: LocalChange | null;
};

/** The first canvas of a new project has nothing on it (the example is a click away: session/firstDraw.ts). */
export const FIRST_SCENE: readonly El[] = [];

/** First run: an empty canvas named after the project on the left, a draft session docked on the right. Later canvases start blank. */
function defaults(projectName?: string): WorkspaceState {
  const s = sessions.create("c1", undefined, { draft: true });
  const p = sessionDocId(s.id);
  const docs: Doc[] = [{ id: "c1", kind: "canvas", title: projectName?.trim() || "画布" }, { id: p, kind: "session", sessionId: s.id, title: "" }];
  const g = group(["c1", p]);
  const root = moveTab(g, p, g.id, "right");
  return { v: 2, docs, root: root.kind === "split" ? { ...root, sizes: [0.6, 0.4] } : root, focused: "c1" };
}

/**
 * Settle the workspace before the first render: the first-run defaults and any session record an
 * older build never saved are created here, once, outside React. Doing it during App's render
 * (as a useMemo / useState initializer) wrote to the sessions store while rendering — and Fast
 * Refresh re-runs useMemo, so every edit created another session and React warned
 * "Cannot update SessionPane while rendering App".
 */
export function prepareBoot(boot: Boot): Boot {
  let workspace = boot.workspace;
  let firstRun = false;
  let recovered: Boot["recovered"];
  // Unreadable canvas files (a merge conflict, no permission) are on disk too: they count against
  // the first run and are listed (flagged) in recovery mode, never written from this page.
  const unreadable = (boot.errors ?? []).filter((e) => e.kind === "canvas" && e.id && !boot.canvases[e.id]).map((e) => e.id!);
  const onDisk = [...Object.keys(boot.canvases), ...unreadable];
  if (!workspace) {
    if (boot.empty !== false || !onDisk.length) {
      // Only a project the server calls empty gets the first canvas (and even then c1 is written with
      // base null, so an existing file is never overwritten).
      workspace = defaults(boot.project?.name);
      firstRun = true;
    } else {
      // workspace.json missing, empty or unreadable, canvases on disk: rebuild the list from them.
      const list = Object.values(sessions.get().sessions).map((s) => ({ id: s.id, canvasId: s.canvasId }));
      workspace = recoverWorkspace(onDisk, list, unreadable);
      recovered = { canvases: onDisk.length, sessions: list.length, why: boot.errors?.some((e) => e.file === "workspace.json") ? "unreadable" : "missing" };
    }
  }
  const docs = migrateDocs(workspace.docs);
  // A session listed without its record (.agora/sessions/ lost, a fresh clone): its canvas comes
  // from the entry itself (workspace.json carries it); older entries without one are shown
  // unlinked. Nothing is saved for it until something happens in it (docs/workspace-model.md §7).
  for (const d of docs) if (d.kind === "session" && !sessions.get().sessions[d.sessionId]) sessions.create(d.canvasId ?? "", d.sessionId, { placeholder: true, createdAt: d.createdAt });
  return { ...boot, workspace: { ...workspace, docs }, firstRun, recovered };
}

