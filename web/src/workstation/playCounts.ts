// Playing a turn (web/docs/workstation.md §11 按轮追踪): what the turn has changed so far, from the run's write
// segments inside the turn's window — the run's own and its sub-agents' — for the +N on each node and the
// summary at the end (「这一轮改了 X 个节点、Y 个文件」). Pure.
import { isNodePath } from "./runs/nodePath";
import type { RunSeg, WorkRun } from "./runs/types";

/** A turn's window on the timeline (`end` null: it is still going, up to now). */
export type Window = { start: number; end: number | null };
export type Write = { path: string; start: number; end: number; /** A canvas edit (./runs/touch.ts): the nodes it drew, not a file. */ edit?: { canvas: string; ids: string[] } };

function collect(run: WorkRun, win: Window, out: Write[]) {
  for (const s of run.segs as readonly RunSeg[]) if (s.kind === "write" && s.path && s.start >= win.start && (win.end == null || s.start < win.end)) out.push({ path: s.path, start: s.start, end: s.end, ...(s.edit ? { edit: s.edit } : {}) });
  for (const c of run.children) collect(c, win, out);
}

/** The files written inside the window (a file written twice appears twice). */
export function turnWrites(run: WorkRun, win: Window): Write[] {
  const out: Write[] = [];
  collect(run, win, out);
  return out;
}

/**
 * How many files each node shows at `t` (its +N): those whose write has started, a file counting once
 * however often it is written. `place` is the canvas's own: it names a file's node on that canvas (a parent
 * node takes its sub-diagram's files) or null (off the diagram: no badge).
 */
export function fileCounts(run: WorkRun, win: Window, t: number, place: (path: string) => string | null): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const w of turnWrites(run, win)) {
    if (w.start > t) continue;
    if (w.edit || isNodePath(w.path)) continue; // a canvas edit is nodes, not files: no +N
    const p = place(w.path);
    if (!p) continue;
    let set = seen.get(p);
    if (!set) seen.set(p, (set = new Set()));
    set.add(w.path);
  }
  return new Map([...seen].map(([p, set]) => [p, set.size]));
}

/** X nodes and Y files the turn changed (the files off the diagram count as files, not as nodes). */
export function summaryOf(run: WorkRun, win: Window, place: (path: string) => string | null): { nodes: number; files: number } {
  const files = new Set<string>();
  const nodes = new Set<string>();
  for (const w of turnWrites(run, win)) {
    if (w.edit) {
      // a canvas edit: every node it drew (one stop is a slice of them), and no file
      for (const id of w.edit.ids) nodes.add(id);
      continue;
    }
    if (isNodePath(w.path)) continue;
    files.add(w.path);
    const p = place(w.path);
    if (p) nodes.add(p);
  }
  return { nodes: nodes.size, files: files.size };
}
