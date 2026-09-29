// The follow view as a tab of the window manager (web/docs/workstation.md §10; the design in §9「跟随窗格」:
// a follow group type in the window manager). One virtual tab, `FOLLOW_TAB`, which is not a document: it is in
// the layout tree while an agent is followed and never in the project's saved layout (./model.ts
// `savedWorkspace` leaves it out). It opens cut off the top of the session group on the canvas's right (the
// canvas keeps its width), else in a column of its own to the canvas's right — and after the person has moved it, where it was put.
// Pure; ../workstation/FollowTabSync.tsx applies it.
import { addTab, groupOf, groups, layout, removeTab, splitOff, type Node, type Zone } from "./layout";

export const FOLLOW_TAB = "follow-pane";
export const isFollowTab = (id: string) => id === FOLLOW_TAB;

/** How much of the room the follow view takes: a column of its own to the right of the canvas / the top of the session group on its right. */
const SHARE_COLUMN = 0.4;
const SHARE_ABOVE_SESSION = 0.5;

export type Home = { action: "keep" } | { action: "split"; target: string; zone: Exclude<Zone, "center">; share: number };

/**
 * Where the follow tab goes: nowhere new when it is open already. With a session group already to the
 * right of the canvas's, it is cut off the top of that (the canvas is not made narrower — three columns
 * would leave a canvas too narrow for the diagram); with none, a column of its own to the canvas's right.
 * `isSession`: whether a tab is a session's.
 */
export function followHome(root: Node, canvasTab: string, isSession: (tab: string) => boolean = () => false): Home {
  if (groupOf(root, FOLLOW_TAB)) return { action: "keep" };
  const g = groupOf(root, canvasTab) ?? groups(root)[0];
  // "to the right": its left edge is at or beyond the canvas group's right edge, in the laid-out tree (a unit square is enough)
  const { rects } = layout(root, { x: 0, y: 0, w: 1, h: 1 }, 0);
  const at = rects.get(g.id);
  // the nearest such group: the one whose left edge is least far to the right
  const nearest = at
    ? groups(root)
        .filter((o) => o.id !== g.id && o.tabs.some(isSession) && (rects.get(o.id)?.x ?? -1) >= at.x + at.w - 1e-9)
        .sort((a, b) => rects.get(a.id)!.x - rects.get(b.id)!.x)[0]
    : undefined;
  if (nearest) return { action: "split", target: nearest.id, zone: "top", share: SHARE_ABOVE_SESSION };
  return { action: "split", target: g.id, zone: "right", share: SHARE_COLUMN };
}

/** Where the person left the tab: inside a group with other tabs, or in a group of its own beside another one. */
export type Spot = { kind: "joined"; groupId: string } | { kind: "split"; anchorTab: string; zone: Exclude<Zone, "center"> };

const firstGroup = (n: Node) => groups(n)[0];
function parentOf(root: Node, id: string): { parent: Node & { kind: "split" }; index: number } | null {
  if (root.kind === "group") return null;
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.id === id) return { parent: root, index: i };
    const deeper = parentOf(c, id);
    if (deeper) return deeper;
  }
  return null;
}

/** Where the tab is now, in terms that survive the group going away (a group holding only it is gone once it closes). */
export function spotOf(root: Node, tab: string): Spot | null {
  const g = groupOf(root, tab);
  if (!g) return null;
  if (g.tabs.length > 1) return { kind: "joined", groupId: g.id };
  const at = parentOf(root, g.id);
  if (!at) return null;
  const before = at.parent.children[at.index - 1];
  const after = at.parent.children[at.index + 1];
  const row = at.parent.dir === "row";
  if (before) return { kind: "split", anchorTab: firstGroup(before).active, zone: row ? "right" : "bottom" };
  if (after) return { kind: "split", anchorTab: firstGroup(after).active, zone: row ? "left" : "top" };
  return null;
}

/** The tree with the follow tab in it: at `spot` when it still makes sense, else in the default place. Unchanged if it is open. */
export function insertFollow(root: Node, canvasTab: string, spot?: Spot | null, isSession: (tab: string) => boolean = () => false): Node {
  if (groupOf(root, FOLLOW_TAB)) return root;
  if (spot?.kind === "joined" && groups(root).some((g) => g.id === spot.groupId)) return addTab(root, spot.groupId, FOLLOW_TAB);
  if (spot?.kind === "split") {
    const anchor = groupOf(root, spot.anchorTab);
    if (anchor) return splitOff(root, anchor.id, FOLLOW_TAB, spot.zone, SHARE_COLUMN);
  }
  const home = followHome(root, canvasTab, isSession);
  return home.action === "split" ? splitOff(root, home.target, FOLLOW_TAB, home.zone, home.share) : root;
}

/** The tree with `groupId`'s room handed to its neighbour (the one before it, else the one after), so removing it gives the room back. */
function giveRoom(n: Node, groupId: string): Node {
  if (n.kind === "group") return n;
  const i = n.children.findIndex((c) => c.id === groupId);
  if (i >= 0 && n.children.length > 1) {
    const to = i > 0 ? i - 1 : i + 1;
    const sizes = [...n.sizes];
    sizes[to] += sizes[i];
    sizes[i] = 0;
    return { ...n, sizes };
  }
  return { ...n, children: n.children.map((c) => giveRoom(c, groupId)) };
}

/** The tree without the follow tab (and without the group that only held it, whose room goes back to its neighbour). */
export function withoutFollow(root: Node): Node {
  const g = groupOf(root, FOLLOW_TAB);
  if (!g) return root;
  const roomy = g.tabs.length === 1 ? giveRoom(root, g.id) : root;
  return removeTab(roomy, FOLLOW_TAB) ?? root;
}

