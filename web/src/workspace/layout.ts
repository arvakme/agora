// Window-manager model: a split tree whose leaves are tab groups of canvas ids.
// Pure functions only; the Workspace component renders and animates the result.

export type Dir = "row" | "col";
export type Group = { kind: "group"; id: string; tabs: string[]; active: string };
export type Split = { kind: "split"; id: string; dir: Dir; sizes: number[]; children: Node[] };
export type Node = Group | Split;
export type Zone = "center" | "left" | "right" | "top" | "bottom";
export type Rect = { x: number; y: number; w: number; h: number };
export type Sash = { splitId: string; index: number; dir: Dir; rect: Rect; span: number };

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
export const group = (tabs: string[], active = tabs[0]): Group => ({ kind: "group", id: uid("g"), tabs, active });
const split = (dir: Dir, children: Node[], sizes = children.map(() => 1 / children.length)): Split => ({
  kind: "split",
  id: uid("s"),
  dir,
  sizes,
  children,
});

/** Two groups side by side, sharing the width as `sizes` says. */
export const columns = (left: Group, right: Group, sizes: [number, number]): Node => split("row", [left, right], sizes);

export function groups(n: Node): Group[] {
  return n.kind === "group" ? [n] : n.children.flatMap(groups);
}
export const groupOf = (root: Node, tab: string) => groups(root).find((g) => g.tabs.includes(tab));

/** Map over the tree bottom-up; `f` may return null to drop a node. Splits collapse as needed. */
function rebuild(n: Node, f: (n: Node) => Node | null): Node | null {
  if (n.kind === "group") return f(n);
  const kept: { child: Node; size: number }[] = [];
  n.children.forEach((c, i) => {
    const r = rebuild(c, f);
    if (r) kept.push({ child: r, size: n.sizes[i] });
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((a, k) => a + k.size, 0);
  // Flatten a child split running the same direction into this one.
  const children: Node[] = [], sizes: number[] = [];
  for (const k of kept) {
    if (k.child.kind === "split" && k.child.dir === n.dir) {
      k.child.children.forEach((c, i) => (children.push(c), sizes.push((k.size / total) * (k.child as Split).sizes[i])));
    } else children.push(k.child), sizes.push(k.size / total);
  }
  return f({ ...n, children, sizes });
}

export function activate(root: Node, groupId: string, tab: string): Node {
  return rebuild(root, (n) => (n.kind === "group" && n.id === groupId ? { ...n, active: tab } : n))!;
}

export function removeTab(root: Node, tab: string): Node | null {
  return rebuild(root, (n) => {
    if (n.kind !== "group" || !n.tabs.includes(tab)) return n;
    const i = n.tabs.indexOf(tab);
    const tabs = n.tabs.filter((t) => t !== tab);
    if (!tabs.length) return null;
    return { ...n, tabs, active: n.active === tab ? tabs[Math.max(0, i - 1)] : n.active };
  });
}

export function addTab(root: Node, groupId: string, tab: string, index?: number): Node {
  return rebuild(root, (n) => {
    if (n.kind !== "group" || n.id !== groupId) return n;
    const tabs = [...n.tabs];
    tabs.splice(index ?? tabs.length, 0, tab);
    return { ...n, tabs, active: tab };
  })!;
}

/** Drag-and-drop: move a tab into a group (center) or split a new group off one of its edges. */
export function moveTab(root: Node, tab: string, targetId: string, zone: Zone, index?: number): Node {
  const source = groupOf(root, tab)!;
  const target = groups(root).find((g) => g.id === targetId)!;
  if (source.id === target.id && (zone === "center" || source.tabs.length === 1)) {
    if (zone !== "center" || index === undefined) return activate(root, source.id, tab);
    const tabs = source.tabs.filter((t) => t !== tab);
    tabs.splice(Math.min(index > source.tabs.indexOf(tab) ? index - 1 : index, tabs.length), 0, tab);
    return rebuild(root, (n) => (n.id === source.id ? { ...source, tabs, active: tab } : n))!;
  }
  if (zone === "center") return addTab(removeTab(root, tab)!, target.id, tab, index);
  const dir: Dir = zone === "left" || zone === "right" ? "row" : "col";
  const fresh = group([tab]);
  const before = zone === "left" || zone === "top";
  const wrapped = rebuild(removeTab(root, tab)!, (n) =>
    n.id === target.id ? split(dir, before ? [fresh, n] : [n, fresh]) : n,
  );
  return wrapped!;
}

/**
 * A new group holding `tab`, cut off the `zone` side of group `targetId` (which gives it `share` of its room).
 * With the target's parent running the same way the new group goes in beside it there, so the neighbours are not moved.
 */
export function splitOff(root: Node, targetId: string, tab: string, zone: Exclude<Zone, "center">, share = 0.35): Node {
  const dir: Dir = zone === "left" || zone === "right" ? "row" : "col";
  const fresh = group([tab]);
  const before = zone === "left" || zone === "top";
  return rebuild(root, (n) => (n.id === targetId ? split(dir, before ? [fresh, n] : [n, fresh], before ? [share, 1 - share] : [1 - share, share]) : n))!;
}

export function resize(root: Node, splitId: string, index: number, delta: number, min: number): Node {
  return rebuild(root, (n) => {
    if (n.kind !== "split" || n.id !== splitId) return n;
    const sizes = [...n.sizes];
    const pair = sizes[index] + sizes[index + 1];
    const a = Math.min(pair - min, Math.max(min, sizes[index] + delta));
    sizes[index] = a;
    sizes[index + 1] = pair - a;
    return { ...n, sizes };
  })!;
}

export const equalize = (root: Node, splitId: string): Node =>
  rebuild(root, (n) => (n.kind === "split" && n.id === splitId ? { ...n, sizes: n.sizes.map(() => 1 / n.sizes.length) } : n))!;

export type Preset = "single" | "row" | "col" | "grid";
export function preset(tabs: string[], kind: Preset, active: string): Node {
  if (kind === "single" || tabs.length === 1) return group(tabs, active);
  if (kind === "row" || kind === "col") return split(kind, tabs.map((t) => group([t])));
  // Grid: rows of two.
  const rows: Node[] = [];
  for (let i = 0; i < tabs.length; i += 2) {
    const pair = tabs.slice(i, i + 2).map((t) => group([t]));
    rows.push(pair.length === 1 ? pair[0] : split("row", pair));
  }
  return rows.length === 1 ? rows[0] : split("col", rows);
}

/** Lays the tree out in `rect` with `gap` px gutters. */
export function layout(root: Node, rect: Rect, gap: number) {
  const rects = new Map<string, Rect>();
  const sashes: Sash[] = [];
  const walk = (n: Node, r: Rect) => {
    if (n.kind === "group") return void rects.set(n.id, r);
    const horizontal = n.dir === "row";
    const span = (horizontal ? r.w : r.h) - gap * (n.children.length - 1);
    let at = horizontal ? r.x : r.y;
    n.children.forEach((c, i) => {
      const len = span * n.sizes[i];
      walk(c, horizontal ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len });
      at += len;
      if (i < n.children.length - 1) {
        sashes.push({
          splitId: n.id,
          index: i,
          dir: n.dir,
          span,
          rect: horizontal ? { x: at, y: r.y, w: gap, h: r.h } : { x: r.x, y: at, w: r.w, h: gap },
        });
        at += gap;
      }
    });
  };
  walk(root, rect);
  return { rects, sashes };
}
