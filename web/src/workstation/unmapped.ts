// Files off the diagram (web/docs/workstation.md「新想法」): the files agents wrote that no node claims
// (they stand on the 图外 tray while writing them), grouped by their nearest common folder; a folder
// with more than two becomes a suggestion to draw it in. Deepest folders first, each file counted
// once; top-level files and reads never count (reading docs/ is not a reason to redraw the diagram).
// Shown by ./TrayHint.tsx, which only copies the words: nothing changes the diagram. Pure.
import type { Locate } from "./place";
import type { WorkRun } from "./runs/types";

export type DrawInHint = { dir: string; files: string[]; text: string };

/** More than this many files in one folder make a suggestion. */
const MIN = 2;

export function drawInHints(runs: readonly WorkRun[], locate: Locate): DrawInHint[] {
  const files = new Set<string>();
  for (const r of runs) for (const g of r.segs) if (g.kind === "write" && g.path?.includes("/") && !locate(g.path)) files.add(g.path);
  // every folder above each file ("a/b/c.py" → "a/", "a/b/"), deepest first
  const under = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = `${parts.slice(0, i).join("/")}/`;
      under.set(dir, [...(under.get(dir) ?? []), f]);
    }
  }
  const taken = new Set<string>();
  const out: DrawInHint[] = [];
  for (const dir of [...under.keys()].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1))) {
    const mine = under.get(dir)!.filter((f) => !taken.has(f));
    if (mine.length <= MIN) continue;
    for (const f of mine) taken.add(f);
    out.push({ dir, files: mine.sort(), text: `${dir} 有 ${mine.length} 个新文件，要画进图里吗？` });
  }
  return out.sort((a, b) => b.files.length - a.files.length || (a.dir < b.dir ? -1 : 1));
}
