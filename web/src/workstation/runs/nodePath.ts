// A node of a canvas as the place a call is at (web/docs/workstation.md §2, 智能体改图). A file's place is the node that claims it; a canvas edit an agent
// makes through the page has no file, only the nodes it changed: the run's segment says `nodePath(canvas, id)` and every place that turns a
// path into a place (./place.ts `where` → geometry.ts `locate`, subview.ts `levelsOf`) understands it. Not a project path: it never starts
// with "/" (so it is not "outside the project"), and it names no file (`pathLabel`).
const PREFIX = "agora-node:";

export const nodePath = (canvas: string, id: string): string => `${PREFIX}${canvas}/${id}`;
export const isNodePath = (path: string): boolean => path.startsWith(PREFIX);
/** The canvas and node id a node path names, or null for a file path. */
export function parseNodePath(path: string): { canvas: string; id: string } | null {
  if (!isNodePath(path)) return null;
  const rest = path.slice(PREFIX.length);
  const i = rest.indexOf("/");
  return i > 0 ? { canvas: rest.slice(0, i), id: rest.slice(i + 1) } : null;
}
/** The path as a person reads it: a file's own, nothing for a node path (the segment's `say` speaks for it). */
export const pathLabel = (path: string | undefined): string => (!path || isNodePath(path) ? "" : path);
