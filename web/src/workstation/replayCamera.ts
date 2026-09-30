// The camera of a played turn (web/docs/workstation.md §11 按轮追踪): which canvas the main view shows at a moment of
// the play. Pure; ./replayMode.ts asks it every 250 ms and switches the view (as a click into a
// sub-diagram does) when the answer changes.

/** What the figure is doing on one canvas: behind the door of a node (gone in, out of sight), and the canvas that door leads to. */
export type DoorState = { behind: boolean; into: string | null };

/** The canvases from the root down to where the figure is: each one while it is behind a door on the one above. */
export function cameraPath(root: string, stateOf: (canvas: string) => DoorState): string[] {
  const path = [root];
  for (let c = root; ; ) {
    const s = stateOf(c);
    if (!s.behind || !s.into || path.includes(s.into)) break;
    path.push((c = s.into));
  }
  return path;
}

/** The canvas to show: the deepest of that path — or the root for the summary at the end. */
export function cameraCanvas(root: string, stateOf: (canvas: string) => DoorState, o: { summary?: boolean } = {}): string {
  if (o.summary) return root;
  return cameraPath(root, stateOf).at(-1)!;
}
