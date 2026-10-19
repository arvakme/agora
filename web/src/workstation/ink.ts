// 分站揭示: drawing a station (web/docs/workstation.md §17; the timing is ./reveal.ts `inkPlan`, the page is ./RevealLayer.tsx).
// A station's elements are exported on their own (../buildreplay/scenePicture.ts), each carrying a link that names its place in the list (`tagged`), so
// every node Excalidraw's export makes for an element sits in one <a> and is known as that element's (the export only marks nodes with ids in tests).
// What Excalidraw's export makes of each element, and how it is drawn here:
// - rectangle, ellipse, diamond: a group of the fill (solid: a path filled; hachure, cross-hatch, zigzag: strokes in the fill colour) and, last, the
//   outline: one path, which Rough.js draws in pieces, each piece twice (two passes, one after the other with the same ends), going clockwise from the
//   top-left (a rounded or roughness-0 outline is one piece). Each pass of each piece becomes a path of its own, drawn on with a dash offset, the pieces
//   in turn and a piece's passes together; then the fill fades in. A dashed or dotted outline keeps its dashes: it is drawn through a mask, the mask
//   holding a solid copy of its path drawn on the same way. A shape filled but not outlined (a transparent stroke: many icons) is wiped on instead.
// - line, arrow (straight, curved, elbow, many points): a group of drawables — the first the line (its fill first, when it is a closed shape), the rest
//   its head(s). The line is traced as an outline is; the head fades in as the stroke gets to it; a label is written after.
// - freedraw: a filled outline (the ink) after its fill: drawn through a mask holding a thick line along the element's points, drawn on.
// - frame: its outline (a rect) traced; its name (a label the editor puts on the page, outside the canvas) is written after (./RevealLayer.tsx).
// - image: wiped on, left to right. Embed: its box traced, its placeholder written, its content faded.
// - text, on its own or in a box or on a line: written — each line wiped on from where it starts (left, or right for right-to-left), one after another.
// A group (a library component) is one unit: its elements drawn one after another, overlapping, in their order (./reveal.ts `unitWindows`).
import type { El } from "../canvas/scene";
import { inkAt, inkPlan, inkUnits, unitWindows, type InkKind, type InkStep } from "./reveal";

const NS = "http://www.w3.org/2000/svg";
const TAG = "https://ink.invalid/";
const EMBED = new Set(["iframe", "embeddable"]);

/** The station's elements as the ink picture is exported from: each carries a link naming its place (not an embed: its link is what it shows). */
export function tagged(els: readonly El[]): El[] {
  return els.map((e, i) => (EMBED.has(e.type) ? e : ({ ...e, link: TAG + i } as El)));
}

/** Ids in an exported picture made its own (`prefix`), with what refers to them: pictures on one page must not share a mask's or a clip's id. */
export function scopeIds(html: string, prefix: string): string {
  return html
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`);
}

/** How an element is drawn: its strokes traced, traced through a mask (dashed, dotted, freehand), wiped on (image, text, filled without outline), faded (cannot be drawn: `reason`), or nothing (the export has nothing of it). */
export type InkHow = "trace" | "mask" | "wipe" | "fade" | "none";
type Pass = { el: SVGGeometryElement; len: number };
/** One piece of a stroke: its passes, drawn together; `from`, `to`: its place along the whole stroke (0 → 1). */
type Piece = { passes: Pass[]; from: number; to: number };
type Wipe = { rect: SVGRectElement; x: number; y: number; w: number; h: number; rtl: boolean };
export type InkPart = {
  id: string;
  type: string;
  how: InkHow;
  reason?: string;
  /** how much it has to draw (its strokes' length, or a wiped part's width and height): its share of its unit's time */
  len: number;
  pieces: Piece[];
  wipes: Wipe[];
  fills: Element[];
  heads: Element[];
  texts: Wipe[];
  /** drawn by fading in (what could not be drawn: `reason`) */
  fades: Element[];
  textFades: Element[];
};
export type Ink = { units: { kind: InkKind; parts: InkPart[]; windows: [number, number][] }[]; parts: InkPart[]; strays: Element[] };

let seq = 0;
const make = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
function maskIn(svg: SVGSVGElement, b: { x: number; y: number; width: number; height: number }, pad: number): SVGMaskElement {
  const defs = svg.querySelector(":scope > defs") ?? svg.insertBefore(make("defs", {}), svg.firstChild);
  const m = make("mask", { id: `ink-${++seq}`, maskUnits: "userSpaceOnUse", x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });
  defs.appendChild(m);
  return m;
}
const hide = (el: SVGGeometryElement): Pass => {
  const len = el.getTotalLength();
  el.style.strokeDasharray = `${len} ${len + 1}`;
  el.style.strokeDashoffset = String(len);
  el.style.opacity = "0";
  return { el, len };
};

const ends = (d: string) => {
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  return n.length >= 4 ? [n[0], n[1], n[n.length - 2], n[n.length - 1]] : null;
};
const near = (a: number[] | null, b: number[] | null) => !!a && !!b && a.every((x, i) => Math.abs(x - b[i]) < 2);

/** Subpaths as pieces (a subpath with the ends of the one before it is that piece's second pass), each pass made by `pass`. */
function piecesOf(d: string, pass: (d: string) => SVGGeometryElement): Piece[] {
  const parts = d.split(/(?=M)/).filter((x) => x.trim());
  const groups: Pass[][] = [];
  let last: number[] | null = null;
  for (const part of parts) {
    const p = hide(pass(part));
    const e = ends(part);
    if (groups.length && near(e, last)) groups[groups.length - 1].push(p);
    else groups.push([p]);
    last = e;
  }
  return spread(groups);
}
function spread(groups: Pass[][]): Piece[] {
  const lens = groups.map((ps) => Math.max(...ps.map((x) => x.len)));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return groups.map((passes, i) => {
    const from = at / total;
    at += lens[i];
    return { passes, from, to: at / total };
  });
}

/** A stroke path's pieces: solid, drawn itself (each pass a copy of it); dashed or dotted, drawn through a mask of solid copies (its dashes stay as they are). */
function strokeOf(svg: SVGSVGElement, path: SVGPathElement): { pieces: Piece[]; how: InkHow } | { reason: string } {
  const stroke = path.getAttribute("stroke");
  if (!stroke || stroke === "none") return { reason: "outline has no stroke" };
  const d = path.getAttribute("d") ?? "";
  if (!d.trim()) return { reason: "outline is empty" };
  if (!path.getAttribute("stroke-dasharray")) {
    const pieces = piecesOf(d, (part) => {
      const p = path.cloneNode() as SVGPathElement;
      p.setAttribute("d", part);
      return path.parentNode!.insertBefore(p, path);
    });
    path.remove();
    return { pieces, how: "trace" };
  }
  const sw = Number(path.getAttribute("stroke-width")) || 1;
  const m = maskIn(svg, path.getBBox(), sw + 8);
  const pieces = piecesOf(d, (part) => m.appendChild(make("path", { d: part, fill: "none", stroke: "#fff", "stroke-width": sw + 6, "stroke-linecap": "round", "stroke-linejoin": "round" })));
  path.setAttribute("mask", `url(#${m.id})`);
  return { pieces, how: "mask" };
}

/** `node` wiped on: wrapped in a group masked by a rect that grows over it (in the group's space, which is the node's parent's). */
function wipeOf(svg: SVGSVGElement, nodes: Element[], rtl = false): Wipe | null {
  if (!nodes.length) return null;
  const g = make("g", {});
  nodes[0].parentNode!.insertBefore(g, nodes[0]);
  nodes.forEach((n) => g.appendChild(n));
  const b = g.getBBox();
  // the box leaves out strokes: a dot (a line of no length, drawn as its round cap) has none, so the pad is the widest stroke in it
  const sw = Math.max(1, ...[...g.querySelectorAll("[stroke-width]")].map((n) => Number(n.getAttribute("stroke-width")) || 0));
  const pad = 2 + sw / 2;
  const m = maskIn(svg, b, pad + 2);
  const w = { x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad };
  const rect = m.appendChild(make("rect", { x: w.x, y: w.y, width: 0, height: w.h, fill: "#fff" }));
  g.setAttribute("mask", `url(#${m.id})`);
  return { rect, ...w, rtl };
}
const setWipe = (w: Wipe, q: number) => {
  w.rect.setAttribute("width", String(w.w * q));
  w.rect.setAttribute("x", String(w.rtl ? w.x + w.w * (1 - q) : w.x));
};

const visible = (e: El) => e.strokeColor !== "transparent" && e.strokeWidth > 0;
const blank = (e: El, nodes: Element[]): InkPart => ({ id: e.id, type: e.type, how: nodes.length ? "fade" : "none", len: 0, pieces: [], wipes: [], fills: [], heads: [], texts: [], fades: nodes, textFades: [] });
const fallback = (e: El, nodes: Element[], reason: string): InkPart => ({ ...blank(e, nodes), reason });
const contents = (nodes: Element[]) => (nodes.length === 1 && nodes[0].tagName.toLowerCase() === "a" ? [...nodes[0].children] : nodes);
const paths = (nodes: Element[]) => nodes.flatMap((n) => (n.tagName.toLowerCase() === "path" ? [n as SVGPathElement] : [...n.querySelectorAll<SVGPathElement>("path")]));
const textWipes = (svg: SVGSVGElement, nodes: Element[]): Wipe[] =>
  nodes
    .flatMap((n) => [...n.querySelectorAll("text")])
    .map((t) => wipeOf(svg, [t], t.getAttribute("direction") === "rtl"))
    .filter((w): w is Wipe => !!w);

/** How an element is drawn, from the nodes the export made for it. */
function partOf(svg: SVGSVGElement, e: El, nodes: Element[]): InkPart {
  if (!nodes.length) return blank(e, nodes);
  const part = blank(e, []);
  // nothing to see (a library component's own transparent root box, a line drawn in no colour): nothing to draw
  if (!visible(e) && e.backgroundColor === "transparent" && e.type !== "text" && e.type !== "image" && !/frame$|embeddable|iframe/.test(e.type)) return { ...part, how: "none", reason: "invisible: no stroke, no fill" };
  const wholeWipe = (): InkPart => {
    const w = wipeOf(svg, contents(nodes));
    return w ? { ...part, how: "wipe", wipes: [w], len: w.w + w.h } : fallback(e, nodes, "nothing in the export to wipe");
  };
  const traced = (outline: SVGPathElement | undefined, rest: Element[]): InkPart => {
    if (!outline) return fallback(e, nodes, "no outline path in the export");
    const s = strokeOf(svg, outline);
    if ("reason" in s) return fallback(e, nodes, s.reason);
    return { ...part, how: s.how, pieces: s.pieces, fills: rest, len: lengthOf(s.pieces) };
  };
  switch (e.type) {
    case "text": {
      const texts = textWipes(svg, nodes);
      return texts.length ? { ...part, how: "wipe", texts, len: 0 } : fallback(e, nodes, "text has no line to write");
    }
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const ps = paths(nodes);
      if (!ps.length) return fallback(e, nodes, "no path in the export");
      if (!visible(e)) return wholeWipe();
      return traced(ps[ps.length - 1], ps.slice(0, -1));
    }
    case "line":
    case "arrow": {
      const group = nodes.flatMap((n) => [n, ...n.querySelectorAll("g")]).find((g) => g.tagName.toLowerCase() === "g" && g.children.length > 0 && [...g.children].every((c) => c.tagName.toLowerCase() === "g"));
      if (!group) return fallback(e, nodes, "no line group in the export");
      const lp = (e as El & { points?: readonly (readonly [number, number])[] }).points ?? [];
      const span = lp.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - lp[i][0], p[1] - lp[i][1]), 0);
      // no stroke to follow (or a line of no length: a dot): wiped on
      if (!visible(e) || span < 1.5) return wholeWipe();
      const [body, ...heads] = [...group.children];
      const bp = paths([body]);
      return { ...traced(bp[bp.length - 1], bp.slice(0, -1)), heads };
    }
    case "freedraw": {
      const ps = paths(nodes);
      const ink = ps[ps.length - 1];
      const pts = (e as El & { points?: readonly (readonly [number, number])[] }).points ?? [];
      if (!ink) return fallback(e, nodes, "no ink path in the export");
      const size = e.strokeWidth * 4.25;
      // a dot (a tap of the pen: its points all but on one spot): nothing to follow, wiped on
      const run = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
      if (pts.length < 2 || run < Math.max(2, size / 2)) return wholeWipe();
      const m = maskIn(svg, ink.getBBox(), size + 8);
      const d = `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")}`;
      const pass = hide(m.appendChild(make("path", { d, fill: "none", stroke: "#fff", "stroke-width": size * 1.3 + 6, "stroke-linecap": "round", "stroke-linejoin": "round" })));
      ink.setAttribute("mask", `url(#${m.id})`);
      const pieces = spread([[pass]]);
      return { ...part, how: "mask", pieces, fills: ps.slice(0, -1), len: pass.len };
    }
    case "frame":
    case "magicframe": {
      const r = nodes.flatMap((n) => (n.tagName.toLowerCase() === "rect" ? [n] : [...n.querySelectorAll("rect")]))[0] as SVGRectElement | undefined;
      if (!r) return fallback(e, nodes, "frame outline not in the export");
      const pieces = spread([[hide(r)]]);
      return { ...part, how: "trace", pieces, len: lengthOf(pieces) };
    }
    case "image": {
      if (!nodes.some((n) => n.querySelector("use"))) return fallback(e, nodes, "image without its file");
      return wholeWipe();
    }
    case "embeddable":
    case "iframe": {
      const [shape, label, ...rest] = contents(nodes);
      const ps = shape ? paths([shape]) : [];
      const p = traced(ps[ps.length - 1], [...ps.slice(0, -1), ...rest]);
      return label ? { ...p, texts: textWipes(svg, [label]) } : p;
    }
  }
  return fallback(e, nodes, `type ${e.type} not known`);
}
const lengthOf = (pieces: Piece[]) => pieces.reduce((a, p) => a + Math.max(...p.passes.map((x) => x.len)), 0);

/** Each element's nodes in the export: by the link it carries; an embed (drawn last, its own link kept) takes what follows untagged, one <a> or three nodes. */
function nodesOf(svg: SVGSVGElement, els: readonly El[]): { byId: Map<string, Element[]>; strays: Element[] } {
  const byId = new Map<string, Element[]>();
  const strays: Element[] = [];
  const embeds = els.filter((e) => EMBED.has(e.type));
  const push = (id: string, n: Element) => (byId.get(id) ?? byId.set(id, []).get(id)!).push(n);
  for (const n of [...svg.children]) {
    const tag = n.tagName.toLowerCase();
    if (tag === "defs" || tag === "metadata" || tag === "style") continue;
    const href = tag === "a" ? n.getAttribute("href") : null;
    if (href?.startsWith(TAG)) {
      const e = els[Number(href.slice(TAG.length))];
      if (e) push(e.id, n);
      else strays.push(n);
      continue;
    }
    const em = embeds[0];
    if (em) {
      push(em.id, n);
      if (tag === "a" || byId.get(em.id)!.length >= 3) embeds.shift();
      continue;
    }
    strays.push(n);
  }
  return { byId, strays };
}

/** A station's ink picture (the export of `tagged(els)`) made ready to draw: every element's strokes hidden, its parts known, its units in order. */
export function prepareInk(svg: SVGSVGElement, els: readonly El[]): Ink {
  const { byId, strays } = nodesOf(svg, els);
  const byEl = new Map(els.map((e) => [e.id, e]));
  const bound = new Map<string, El[]>();
  for (const e of els) if (e.type === "text" && e.containerId && byEl.has(e.containerId)) (bound.get(e.containerId) ?? bound.set(e.containerId, []).get(e.containerId)!).push(e);
  const parts: InkPart[] = [];
  const units = inkUnits(els).map((u) => {
    const ps = u.ids.map((id) => {
      const p = partOf(svg, byEl.get(id)!, byId.get(id) ?? []);
      parts.push(p);
      for (const t of bound.get(id) ?? []) {
        const tp = partOf(svg, t, byId.get(t.id) ?? []);
        parts.push(tp);
        p.texts.push(...tp.texts);
        p.textFades.push(...tp.fades);
      }
      return p;
    });
    const kind: InkKind = ps.every((p) => p.how === "fade" || p.how === "none") ? "fade" : u.kind;
    return { kind, parts: ps, windows: unitWindows(ps.map((p) => p.len)) };
  });
  return { units, parts, strays };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The ink `ms` after the station's moment, by `steps` (./reveal.ts `inkPlan` of its units). Returns how far each frame's name is written. */
export function paintInk(ink: Ink, steps: readonly InkStep[], ms: number): Map<string, number> {
  const names = new Map<string, number>();
  ink.units.forEach((u, k) => {
    const s = inkAt(steps[k], ms);
    u.parts.forEach((pt, j) => {
      const [a, b] = u.windows[j];
      const f = clamp01((s.stroke - a) / (b - a || 1));
      for (const pc of pt.pieces) {
        const q = clamp01((f - pc.from) / (pc.to - pc.from || 1));
        for (const p of pc.passes) {
          p.el.style.strokeDashoffset = String(p.len * (1 - q));
          p.el.style.opacity = q > 0 ? "1" : "0";
        }
      }
      for (const w of pt.wipes) setWipe(w, f);
      for (const x of pt.fades) (x as SVGElement).style.opacity = String(f);
      for (const x of pt.fills) (x as SVGElement).style.opacity = String(s.fill);
      for (const x of pt.heads) (x as SVGElement).style.opacity = String(clamp01((f - 0.8) / 0.2));
      // the lines of its text one after another, each over its share by width
      const total = pt.texts.reduce((a, w) => a + w.w, 0) || 1;
      let at = 0;
      for (const w of pt.texts) {
        setWipe(w, clamp01((s.text * total - at) / (w.w || 1)));
        at += w.w;
      }
      for (const x of pt.textFades) (x as SVGElement).style.opacity = String(s.text);
      if (pt.type === "frame" || pt.type === "magicframe") names.set(pt.id, s.text);
    });
  });
  for (const x of ink.strays) (x as SVGElement).style.opacity = String(clamp01(ms / 400));
  return names;
}

const inks = new WeakMap<Element, { svg: Element; ink: Ink; steps: InkStep[] }>();
/** What a station draws, `ms` after its moment, in `budget` ms at most (the rest of the figure's stop): prepared the first time its picture is shown. */
export function drawInk(div: HTMLDivElement, els: readonly El[], ms: number, budget: number): Map<string, number> {
  const svg = div.querySelector("svg");
  if (!svg) return new Map();
  let c = inks.get(div);
  if (!c || c.svg !== svg) {
    const ink = prepareInk(svg, els);
    inks.set(div, (c = { svg, ink, steps: inkPlan(ink.units.map((u) => u.kind), budget).steps }));
  }
  return paintInk(c.ink, c.steps, ms);
}
