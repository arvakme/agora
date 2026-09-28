// One worker as SVG nodes, created once and then only updated in place (setAttribute) by the frame
// loop — no markup strings, no React per frame. Drawn in figure space: the root on the ground at
// (0, 0), up is −y; the overlay places the whole group with one transform.
import codex128 from "../app/agents/codex-128.png";
import type { Joints } from "./rig";

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** The agent's mark inside a disc of radius r at (0, 0), as SVG (symbols come from <WorkerDefs/>). */
export function mark(agent: string, r: number, parent: Element) {
  if (agent === "pi") el("use", { href: "#ws-m-pi", x: -r * 0.5, y: -r * 0.5, width: r, height: r }, parent);
  else if (agent === "claude") el("use", { href: "#ws-m-claude", x: -r * 0.7, y: -r * 0.7, width: r * 1.4, height: r * 1.4 }, parent);
  else if (agent === "codex") el("image", { href: codex128, x: -r * 0.72, y: -r * 0.72, width: r * 1.44, height: r * 1.44 }, parent);
  else {
    const t = el("text", { x: 0, y: r * 0.36, "text-anchor": "middle", "font-size": r, "font-weight": 600, fill: "var(--fg-muted)", "font-family": "var(--font-sans)" }, parent);
    t.textContent = agent === "worker" ? "W" : (agent[0] ?? "?").toUpperCase();
  }
}

export class FigureNode {
  readonly g: SVGGElement;
  private body: SVGGElement;
  private shadow: SVGEllipseElement;
  private desk: SVGGElement;
  private deskStand: SVGPathElement;
  private deskTop: SVGRectElement;
  private screen: SVGRectElement;
  private line1: SVGRectElement;
  private line2: SVGRectElement;
  private prompt: SVGPathElement;
  private cursor: SVGRectElement;
  private legF: SVGPathElement;
  private footF: SVGPathElement;
  private armF: SVGPathElement;
  private torso: SVGPathElement;
  private legN: SVGPathElement;
  private footN: SVGPathElement;
  private head: SVGGElement;
  private prop: SVGGElement;
  private propRect: SVGRectElement;
  private propLines: SVGPathElement;
  private armN: SVGPathElement;
  private badge: SVGGElement | null = null;
  private markG: SVGGElement;
  private markC: SVGCircleElement;
  private markT: SVGTextElement;
  private last: Record<string, string> = {};

  constructor(readonly id: string, agent: string, o: { parentAgent?: string; label: string }) {
    this.g = el("g", { class: "ws-worker", "data-run": id, role: "button", tabindex: 0, "aria-label": o.label });
    el("rect", { x: -14, y: -64, width: 32, height: 66, fill: "transparent", class: "ws-hit" }, this.g);
    this.body = el("g", {}, this.g);
    const b = this.body;
    this.shadow = el("ellipse", { cy: 0.6, rx: 9.5, ry: 1.8, fill: "var(--line-strong)", opacity: 0.7 }, b);
    this.desk = el("g", {}, b);
    this.deskStand = el("path", { stroke: "var(--fg-faint)", "stroke-width": 1.6, "stroke-linecap": "round", fill: "none" }, this.desk);
    this.deskTop = el("rect", { width: 15, height: 1.8, rx: 0.9, fill: "var(--fg-muted)" }, this.desk);
    this.screen = el("rect", { width: 11, height: 11.4, rx: 1.6 }, this.desk);
    this.line1 = el("rect", { width: 5, height: 1.3, rx: 0.6, fill: "#fff", opacity: 0.9 }, this.desk);
    this.line2 = el("rect", { height: 1.3, rx: 0.6, fill: "#fff", opacity: 0.75 }, this.desk);
    this.prompt = el("path", { fill: "none", stroke: "var(--accent-on-chrome)", "stroke-width": 1.1, "stroke-linecap": "round", "stroke-linejoin": "round" }, this.desk);
    this.cursor = el("rect", { width: 3.2, height: 1.1, fill: "var(--accent-on-chrome)" }, this.desk);
    const limb = (w: number, c: string) => el("path", { fill: "none", stroke: c, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }, b);
    this.legF = limb(3.6, "var(--fig-far)");
    this.footF = limb(3.2, "var(--fig-far)");
    this.armF = limb(3, "var(--fig-far)");
    this.torso = limb(8.2, "var(--fig)");
    this.legN = limb(3.8, "var(--fig)");
    this.footN = limb(3.2, "var(--fig)");
    this.head = el("g", {}, b);
    el("circle", { r: 8.6, fill: "var(--avatar-tile)", stroke: "var(--avatar-edge)", "stroke-width": 0.9 }, this.head);
    mark(agent, 8.6, this.head);
    this.prop = el("g", {}, b);
    this.propRect = el("rect", { rx: 1, fill: "var(--surface)", stroke: "var(--fg-muted)", "stroke-width": 0.8 }, this.prop);
    this.propLines = el("path", { stroke: "var(--fg-faint)", "stroke-width": 0.8 }, this.prop);
    this.armN = limb(3.2, "var(--fig)");
    if (o.parentAgent) {
      // who sent it: the dispatcher's mark on a small badge
      this.badge = el("g", {}, b);
      el("circle", { r: 4.6, fill: "var(--avatar-tile)", stroke: "var(--bg)", "stroke-width": 1.2 }, this.badge);
      mark(o.parentAgent, 4.6, this.badge);
    }
    this.markG = el("g", {}, b);
    this.markC = el("circle", { r: 5.4 }, this.markG);
    this.markT = el("text", { y: 2.6, "text-anchor": "middle", "font-size": 7.5, "font-weight": 600, fill: "#fff", "font-family": "var(--font-sans)" }, this.markG);
  }

  private set(node: Element, key: string, attr: string, v: string) {
    const k = `${key}.${attr}`;
    if (this.last[k] === v) return;
    this.last[k] = v;
    node.setAttribute(attr, v);
  }

  /** Update every part from solved joints. `t` (ms) drives the small screen and cursor blinks. */
  draw(j: Joints, t: number, still: boolean) {
    const L = (x: number) => x * j.f;
    const S = (n: Element, k: string, a: string, v: number | string) => this.set(n, k, a, typeof v === "number" ? f2(v) : v);
    const d = (x0: number, y0: number, b: { jx: number; jy: number; ex: number; ey: number }) => `M${f2(x0)} ${f2(y0)}L${f2(b.jx)} ${f2(b.jy)}L${f2(b.ex)} ${f2(b.ey)}`;
    const foot = (b: { ex: number; ey: number }) => `M${f2(b.ex - L(0.6))} ${f2(b.ey)}h${f2(L(3.6))}`;
    S(this.shadow, "sh", "cx", j.px * 0.3);
    const desk = !j.walking && (j.prop === "laptop" || j.prop === "terminal");
    S(this.desk, "dk", "display", desk ? "inline" : "none");
    if (desk) {
      const top = -20.5;
      S(this.deskStand, "ds", "d", `M${f2(L(16.5))} ${top}V0M${f2(L(12.5))} 0h${f2(L(8))}`);
      S(this.deskTop, "dt", "x", Math.min(L(9), L(24)));
      S(this.deskTop, "dt", "y", top - 1.6);
      const sx = Math.min(L(15), L(26));
      S(this.screen, "sc", "x", sx);
      S(this.screen, "sc", "y", top - 13);
      const laptop = j.prop === "laptop";
      S(this.screen, "sc", "fill", laptop ? "var(--accent-fill)" : "var(--chrome-bg)");
      S(this.line1, "l1", "display", laptop ? "inline" : "none");
      S(this.line2, "l2", "display", laptop ? "inline" : "none");
      S(this.prompt, "pr", "display", laptop ? "none" : "inline");
      if (laptop) {
        const on = still ? 1 : 0.75 + 0.25 * Math.sin((t / 1000) * 7);
        S(this.line1, "l1", "x", sx + 2);
        S(this.line1, "l1", "y", top - 10.5);
        S(this.line2, "l2", "x", sx + 2);
        S(this.line2, "l2", "y", top - 7.8);
        S(this.line2, "l2", "width", 7 * on);
        S(this.cursor, "cu", "display", "none");
      } else {
        S(this.prompt, "pr", "d", `M${f2(sx + 2)} ${top - 10.2}l2 1.6-2 1.6`);
        S(this.cursor, "cu", "display", still || Math.floor(t / 500) % 2 ? "inline" : "none");
        S(this.cursor, "cu", "x", sx + 5);
        S(this.cursor, "cu", "y", top - 7.4);
      }
    }
    S(this.legF, "lf", "d", d(j.hipF.x, j.hipF.y, j.legF));
    S(this.footF, "ff", "d", foot(j.legF));
    S(this.armF, "af", "d", d(j.shF.x, j.shF.y, j.armF));
    S(this.torso, "to", "d", `M${f2(j.px)} ${f2(j.py + 1)}L${f2(j.nx)} ${f2(j.ny + 2)}`);
    S(this.legN, "ln", "d", d(j.hipN.x, j.hipN.y, j.legN));
    S(this.footN, "fn", "d", foot(j.legN));
    S(this.head, "hd", "transform", `translate(${f2(j.hx)} ${f2(j.hy)})`);
    const hold = j.prop === "sheet" || j.prop === "carry";
    S(this.prop, "pp", "display", hold ? "inline" : "none");
    if (hold) {
      const u = (t % 1800) / 1800;
      const flip = still ? 1 : Math.cos((u < 0.12 ? u / 0.12 : 0) * Math.PI);
      const w = j.prop === "carry" ? 6 : 8.5;
      const h = j.prop === "carry" ? 8 : 11;
      S(this.prop, "pp", "transform", `translate(${f2(j.armN.ex - (j.prop === "carry" ? 3 : 1) * j.f)} ${f2(j.armN.ey - h + 2)}) rotate(${-8 * j.f}) scale(${f2(flip * j.f)} 1)`);
      S(this.propRect, "pr0", "x", -w / 2);
      S(this.propRect, "pr0", "width", w);
      S(this.propRect, "pr0", "height", h);
      S(this.propLines, "pl", "d", j.prop === "sheet" ? `M${-w / 2 + 1.8} 2.8h5M${-w / 2 + 1.8} 5h4M${-w / 2 + 1.8} 7.2h5` : "");
    }
    S(this.armN, "an", "d", d(j.shN.x, j.shN.y, j.armN));
    if (this.badge) S(this.badge, "bd", "transform", `translate(${f2(j.hx + L(7))} ${f2(j.hy - 6.5)})`);
    S(this.markG, "mk", "display", j.mark ? "inline" : "none");
    if (j.mark) {
      S(this.markG, "mk", "transform", `translate(${f2(j.hx + L(this.badge ? -8 : 9))} ${f2(j.hy - 12)})`);
      S(this.markC, "mc", "fill", j.markMuted ? "var(--fg-faint)" : "var(--caution-dot)");
      if (this.markT.textContent !== j.mark) this.markT.textContent = j.mark;
    }
  }

  /** Place the figure (screen transform), fade it, dim it (trace). */
  place(x: number, y: number, scale: number, opacity: number, dim: boolean) {
    this.set(this.g, "g", "transform", `translate(${f2(x)} ${f2(y)}) scale(${f2(scale)})`);
    this.set(this.g, "g", "opacity", opacity >= 1 ? "1" : f2(opacity));
    this.set(this.g, "g", "data-dim", dim ? "1" : "0");
  }
}
