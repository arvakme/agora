// Code paths on the architecture diagram, and where an agent's latest change lands on it.
//
// A diagram element (box or frame) stands for code paths — globs relative to the project root,
// kept in its `customData.codePaths` (so they travel with the canvas in .agora/). A file an
// agent wrote belongs to the element whose glob matches it most specifically; files no glob
// matches are "outside the diagram". The pointer sits on the element of the newest change that
// has one. Rules: docs/progress-pointer.md.
import type { FileTouch } from "../session/trajectoryModel";

export type Link = { id: string; label: string; globs: string[] };

/** A glob as a RegExp: `**` any depth, `*` within one segment, `?` one char, `{a,b}` either. A bare dir `server` or `server/` means `server/**`. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.startsWith("/")) g = g.slice(1);
  if (g.endsWith("/")) g += "**";
  else if (!/[*?[{]/.test(g) && !/\.[^/]*$/.test(g.split("/").pop() ?? "")) g += "/**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` also matches zero directories; a trailing `**` matches anything below.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // `server/**` also matches `server` itself.
  if (re.endsWith("/.*")) re = `${re.slice(0, -3)}(?:/.*)?`;
  return new RegExp(`^${re}$`);
}

/** How specific a glob is: literal characters before the first wildcard, then total length. */
export const specificity = (glob: string) => {
  const g = glob.trim();
  const w = g.search(/[*?[{]/);
  return (w < 0 ? g.length + 1000 : w) * 1000 + g.length;
};

/** The element a project-relative path belongs to (most specific matching glob), or null. */
export function elementFor(path: string, links: Link[]): { link: Link; glob: string } | null {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/")) return null; // outside the project
  let best: { link: Link; glob: string; s: number } | null = null;
  for (const link of links)
    for (const glob of link.globs) {
      if (!globToRegExp(glob).test(p)) continue;
      const s = specificity(glob);
      if (!best || s > best.s) best = { link, glob, s };
    }
  return best && { link: best.link, glob: best.glob };
}

export type Placed = FileTouch & { element: string | null; glob?: string };
export type PointerState = {
  /** Every change, oldest first, with the element it maps to. */
  placed: Placed[];
  /** The newest change that lands on an element. */
  current: Placed | null;
  /** Changes per element, newest first, one row per file. */
  byElement: Map<string, Placed[]>;
  /** Files no element claims, newest first (one row per file, every turn it was touched in). */
  outside: { path: string; at: number; turns: number[]; op: FileTouch["op"] }[];
};

export function place(files: FileTouch[], links: Link[]): PointerState {
  const placed: Placed[] = files.map((f) => {
    const hit = elementFor(f.path, links);
    return { ...f, element: hit?.link.id ?? null, ...(hit ? { glob: hit.glob } : {}) };
  });
  const current = [...placed].reverse().find((p) => p.element) ?? null;
  const byElement = new Map<string, Placed[]>();
  const outsideMap = new Map<string, PointerState["outside"][number]>();
  for (const p of [...placed].reverse()) {
    if (p.element) {
      const list = byElement.get(p.element) ?? [];
      if (!list.some((x) => x.path === p.path)) list.push(p);
      byElement.set(p.element, list);
    } else {
      const o = outsideMap.get(p.path);
      if (o) {
        if (!o.turns.includes(p.turn)) o.turns.push(p.turn);
      } else outsideMap.set(p.path, { path: p.path, at: p.at, turns: [p.turn], op: p.op });
    }
  }
  for (const o of outsideMap.values()) o.turns.sort((a, b) => a - b);
  return { placed, current, byElement, outside: [...outsideMap.values()] };
}
