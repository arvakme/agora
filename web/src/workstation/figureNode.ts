// One worker as SVG nodes, created once and then only updated in place (setAttribute) by the frame
// loop — no markup strings, no React per frame. Drawn in figure space: the root on the ground at
// (0, 0), up is −y; the overlay places the whole group with one transform.
//
// The look is Loom Studio's line figure (docs/workstation.md §小人). Each bone is a capsule: one
// closed path, paper inside and an ink outline that stays 1.1 screen px at any zoom (a non-scaling
// stroke), so a bone costs one element. Bones are drawn back to front — far arm, far leg, torso,
// near leg, near arm, head — so at a knee or an elbow the lower bone's outline lies over the upper
// one. The far limbs are filled a shade toward the ink. Colours are the --fig-* tokens (light and dark).
// Gestures (./gestures.ts) arrive with the joints: a landing's scale and lift, the head's look (on its
// own spring here: the head turns first), the save flash and a command's verdict on the screen.
import codex128 from "../app/agents/codex-128.png";
import { focus } from "./focus";
import { RIG, Spring, type Bone, type Joints, type Pt } from "./rig";

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Outlines in screen px (non-scaling strokes): bones, props and the page; the head's is a little bolder. */
const LINE = 1.1;
const HEAD_LINE = 1.4;
/** Loom's drawing numbers below are for its figure; ours is that figure scaled by K (rig.ts RIG), head excepted. */
const K = RIG.torso / 16.4;
/** The paper width of each bone inside its outline (Loom's, scaled). */
const WIDTH = { torso: 9.2, thigh: 4.7, shin: 4.3, foot: 3.2, upper: 4, fore: 3.6 };
/** A capsule's radius: half its paper width plus the half of the outline that lies inside it (~0.55 px at 100 %). */
const R = Object.fromEntries(Object.entries(WIDTH).map(([k, w]) => [k, (w * K) / 2 + 0.45])) as { [N in keyof typeof WIDTH]: number };
/** The standing desk's top above the ground (Loom's; the desk is drawn scaled by K). */
const DESK = -26.4;
/** The ! / ? dot sits up and in front of the head (Loom's place for it; the overlay leaves 9 units above the head for it). */
const MARK_UP = RIG.head + 4.2;
/** Selecting a figure swaps these three colours for the accent (see `draw`). */
const INK = "var(--wsf-ink, var(--fig-ink))";
const PAPER = "var(--wsf-fill, var(--fig-fill))";
const FAR = "var(--wsf-far, var(--fig-far))";
const SELECTED = "--wsf-ink: var(--accent); --wsf-fill: var(--fig-sel-fill); --wsf-far: var(--fig-sel-far)";
const outline = (w = LINE) => ({ stroke: INK, "stroke-width": w, "vector-effect": "non-scaling-stroke" });

/** A bone from a to b with round ends of radius r, as one closed path: two sides and two half circles. */
function capsule(ax: number, ay: number, bx: number, by: number, r: number): string {
  const len = Math.hypot(bx - ax, by - ay);
  const ux = len > 1e-3 ? (bx - ax) / len : 1;
  const uy = len > 1e-3 ? (by - ay) / len : 0;
  const nx = -uy * r;
  const ny = ux * r;
  const arc = `A${f2(r)} ${f2(r)} 0 0 0 `;
  return `M${f2(ax + nx)} ${f2(ay + ny)}L${f2(bx + nx)} ${f2(by + ny)}${arc}${f2(bx - nx)} ${f2(by - ny)}L${f2(ax - nx)} ${f2(ay - ny)}${arc}${f2(ax + nx)} ${f2(ay + ny)}Z`;
}

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
  private desk: SVGGElement;
  private deskPost: SVGPathElement;
  private deskTop: SVGPathElement;
  private screen: SVGRectElement;
  private code: SVGPathElement;
  private prompt: SVGPathElement;
  private upperF: SVGPathElement;
  private foreF: SVGPathElement;
  private thighF: SVGPathElement;
  private shinF: SVGPathElement;
  private footF: SVGPathElement;
  private torso: SVGPathElement;
  private thighN: SVGPathElement;
  private shinN: SVGPathElement;
  private footN: SVGPathElement;
  private sheet: SVGGElement;
  private sheetRect: SVGRectElement;
  private sheetLines: SVGPathElement;
  private upperN: SVGPathElement;
  private foreN: SVGPathElement;
  private head: SVGGElement;
  private badge: SVGGElement | null = null;
  private markG: SVGGElement;
  private markC: SVGCircleElement;
  private markT: SVGTextElement;
  private rigLines: SVGPathElement;
  private rigJoints: SVGPathElement;
  private shadow: SVGEllipseElement;
  private glow: SVGRectElement;
  private glyph: SVGPathElement;
  /** The head's look: an offset toward what it looks at, on a quick spring of its own. */
  private lookX = new Spring(4, 0.7, 0.6);
  private lookY = new Spring(4, 0.7, 0.6);
  private lastT: number | null = null;
  private last: Record<string, string> = {};
  /** Where the pointer is over this figure (figure space), or null: for the gesture that looks at it. */
  pointer: Pt | null = null;

  constructor(readonly id: string, agent: string, o: { parentAgent?: string; label: string }) {
    this.g = el("g", { class: "ws-worker", "data-run": id, role: "button", tabindex: 0, "aria-label": o.label });
    el("rect", { x: -14, y: -64, width: 32, height: 66, fill: "transparent", class: "ws-hit" }, this.g);
    // pointer events only (never per frame): where the pointer is, in figure space
    this.g.addEventListener("pointermove", (e) => {
      const m = this.g.getScreenCTM();
      if (!m) return;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      this.pointer = { x: p.x, y: p.y };
    });
    this.g.addEventListener("pointerleave", () => void (this.pointer = null));
    const b = (this.body = el("g", {}, this.g));
    this.shadow = el("ellipse", { cy: 0.5, rx: f2(9.5 * K), ry: f2(1.7 * K), fill: "var(--line-strong)" }, b);
    // the standing desk (write: a purple screen with code; exec: a terminal with a prompt)
    this.desk = el("g", { display: "none" }, b);
    this.deskPost = el("path", { fill: "none", "stroke-linecap": "round", ...outline(1.2), stroke: "var(--fig-ink)" }, this.desk);
    this.deskTop = el("path", { fill: "none", stroke: "var(--fig-ink)", "stroke-width": 1.6, "stroke-linecap": "round" }, this.desk);
    this.screen = el("rect", { y: f2(DESK - 10.4), width: 11.5, height: 9.2, rx: 1.2, ...outline(), stroke: "var(--fig-ink)" }, this.desk);
    this.code = el("path", { fill: "none", stroke: "var(--accent-fg)", "stroke-width": 1.1, "stroke-linecap": "round" }, this.desk);
    this.prompt = el("path", { fill: "none", stroke: "var(--accent-on-chrome)", "stroke-width": 1.1, "stroke-linecap": "round", "stroke-linejoin": "round" }, this.desk);
    // over the screen: the save flash, or a command's verdict (✓ / ✗ on a lit screen)
    this.glow = el("rect", { display: "none", y: f2(DESK - 10.4), width: 11.5, height: 9.2, rx: 1.2 }, this.desk);
    this.glyph = el("path", { display: "none", fill: "none", stroke: "var(--fig-mark-fg)", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, this.desk);
    const bone =(fill: string) => el("path", { fill, ...outline() }, b);
    this.upperF = bone(FAR);
    this.foreF = bone(FAR);
    this.thighF = bone(FAR);
    this.shinF = bone(FAR);
    this.footF = bone(FAR);
    this.torso = bone(PAPER);
    this.thighN = bone(PAPER);
    this.shinN = bone(PAPER);
    this.footN = bone(PAPER);
    // the page it reads or hands over, held in front of the body, behind the near hand
    this.sheet = el("g", { display: "none" }, b);
    this.sheetRect = el("rect", { rx: 0.6, fill: "var(--fig-fill)", ...outline(1) }, this.sheet);
    this.sheetLines = el("path", { fill: "none", "stroke-linecap": "round", ...outline(0.9), stroke: "var(--fg-faint)" }, this.sheet);
    this.upperN = bone(PAPER);
    this.foreN = bone(PAPER);
    this.head = el("g", {}, b);
    el("circle", { r: RIG.head, fill: PAPER, ...outline(HEAD_LINE) }, this.head);
    mark(agent, RIG.head * 0.9, this.head);
    if (o.parentAgent) {
      // who sent it: the dispatcher's mark on a small badge behind the head
      this.badge = el("g", {}, b);
      el("circle", { r: 3.7, fill: "var(--avatar-tile)", stroke: "var(--fig-fill)", "stroke-width": 1 }, this.badge);
      mark(o.parentAgent, 3.7, this.badge);
    }
    this.markG = el("g", { display: "none" }, b);
    this.markC = el("circle", { r: 4.7 }, this.markG);
    this.markT = el("text", { y: 2.5, "text-anchor": "middle", "font-size": 7, "font-weight": 700, fill: "var(--fig-mark-fg)", "font-family": "var(--font-sans)" }, this.markG);
    // selected: the skeleton over the figure — IK chains and joints (Loom's rig view)
    this.rigLines = el("path", { display: "none", fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.9, ...outline(1), stroke: "var(--accent)" }, b);
    this.rigJoints = el("path", { display: "none", fill: "var(--fig-fill)", ...outline(1), stroke: "var(--accent)" }, b);
  }

  private set(node: Element, key: string, attr: string, v: string) {
    const k = `${key}.${attr}`;
    if (this.last[k] === v) return;
    this.last[k] = v;
    node.setAttribute(attr, v);
  }

  /** Update every part from solved joints. `t` (ms) drives the small screen and cursor blinks and the page turns. */
  draw(j: Joints, t: number, still: boolean) {
    const f = j.f;
    const L = (x: number) => x * f;
    const S = (n: Element, k: string, a: string, v: number | string) => this.set(n, k, a, typeof v === "number" ? f2(v) : v);
    // Joints snap to 1/20 unit (under 0.1 px at any zoom): a part is rewritten only when it can visibly
    // move, not on every sub-pixel step of breathing or of a spring settling.
    const q = (v: number) => Math.round(v * 20) / 20;
    const bone = (n: SVGPathElement, k: string, ax: number, ay: number, bx: number, by: number, r: number) => S(n, k, "d", capsule(q(ax), q(ay), q(bx), q(by), r));
    // Selected (a figure or its bubble clicked): the outline in the accent, the paper tinted, the skeleton on top.
    const sel = focus.get().selected === this.id;
    S(this.body, "b", "style", sel ? SELECTED : "");
    // Turning: the whole body is mirrored through edge-on (−1 → 1) around its root. Landing: it is
    // scaled about its feet and raised.
    const scale = j.scale ?? 1;
    const lift = j.lift ?? 0;
    S(this.body, "b", "transform", `${lift ? `translate(0 ${f2(-lift)}) ` : ""}${j.turn < 0.999 || scale !== 1 ? `scale(${f2(j.turn * scale)} ${f2(scale)})` : ""}`.trim());
    // off the ground on a ladder: no shadow under the feet
    S(this.shadow, "sd", "opacity", 1 - j.climb);
    // the avatar mark, the dispatcher's badge and the ! / ? never read mirrored mid-turn
    const un = j.turn < 0 ? " scale(-1 1)" : "";
    const desk = !j.walking && (j.prop === "laptop" || j.prop === "terminal") && j.propAlpha > 0.01;
    S(this.desk, "dk", "display", desk ? "inline" : "none");
    if (desk) {
      // the standing desk fades and rises in / out (never pops)
      S(this.desk, "dk", "opacity", Math.min(1, j.propAlpha * 1.2));
      S(this.desk, "dk", "transform", `${j.propAlpha >= 0.999 ? "" : `translate(0 ${f2((1 - j.propAlpha) * 3)}) `}scale(${f2(K)})`);
      S(this.deskPost, "dp", "d", `M${f2(L(16.5))} 0V${DESK}M${f2(L(13))} 0H${f2(L(20))}`);
      S(this.deskTop, "dt", "d", `M${f2(L(7.5))} ${DESK}H${f2(L(26))}`);
      const sx = Math.min(L(14), L(25.5));
      S(this.screen, "sc", "x", sx);
      const laptop = j.prop === "laptop";
      S(this.screen, "sc", "fill", laptop ? "var(--accent-fill)" : "var(--chrome-bg)");
      S(this.code, "cd", "display", laptop ? "inline" : "none");
      S(this.prompt, "pr", "display", laptop ? "none" : "inline");
      if (laptop) {
        // code on the purple screen; its last line grows and shrinks as it types
        const on = still ? 1 : 0.7 + 0.3 * Math.sin((t / 1000) * 7);
        const x = f2(sx + 2);
        S(this.code, "cd", "d", `M${x} ${f2(DESK - 8)}h5.6M${x} ${f2(DESK - 5.6)}h7.4M${x} ${f2(DESK - 3.2)}h${f2(5 * on)}`);
      } else {
        // a prompt and a blinking cursor on the terminal
        const cursor = still || Math.floor(t / 500) % 2 ? `M${f2(sx + 5.2)} ${f2(DESK - 3.6)}h3` : "";
        S(this.prompt, "pr", "d", `M${f2(sx + 2.2)} ${f2(DESK - 7.8)}l1.9 1.5-1.9 1.5${cursor}`);
      }
      // a save flashes the screen white; a command's verdict lights it green ✓ or red ✗
      const res = !laptop && j.result && j.result.a > 0.01 ? j.result : null;
      const flash = laptop ? (j.flash ?? 0) : 0;
      S(this.glow, "gw", "display", res || flash > 0.01 ? "inline" : "none");
      S(this.glyph, "gy", "display", res ? "inline" : "none");
      if (res || flash > 0.01) {
        S(this.glow, "gw", "x", sx);
        S(this.glow, "gw", "fill", res ? (res.ok ? "var(--positive-dot)" : "var(--negative)") : "var(--accent-fg)");
        S(this.glow, "gw", "opacity", res ? 0.92 * res.a : 0.8 * flash);
      }
      if (res) {
        S(this.glyph, "gy", "opacity", res.a);
        S(this.glyph, "gy", "d", res.ok ? `M${f2(sx + 3.3)} ${f2(DESK - 5.9)}l2.1 2.1 4-4.4` : `M${f2(sx + 3.8)} ${f2(DESK - 8.2)}l3.9 3.9M${f2(sx + 7.7)} ${f2(DESK - 8.2)}l-3.9 3.9`);
      }
    }
    // Bones. An arm is shoulder → elbow → hand. A leg's IK ends at the sole: the drawn shin stops
    // RIG.ankle above it, where the foot starts — so a planted foot stays put while the body sways.
    const arm = (sh: Pt, a: Bone, upper: SVGPathElement, fore: SVGPathElement, k: string) => {
      bone(upper, `${k}u`, sh.x, sh.y, a.jx, a.jy, R.upper);
      bone(fore, `${k}f`, a.jx, a.jy, a.ex, a.ey, R.fore);
    };
    const leg = (hip: Pt, l: Bone, thigh: SVGPathElement, shin: SVGPathElement, foot: SVGPathElement, k: string) => {
      const ay = l.ey - RIG.ankle;
      bone(thigh, `${k}t`, hip.x, hip.y, l.jx, l.jy, R.thigh);
      bone(shin, `${k}s`, l.jx, l.jy, l.ex, ay, R.shin);
      bone(foot, `${k}f`, l.ex - L(1.1 * K), ay, l.ex + L(RIG.foot - 1.1 * K), ay + 0.5 * K, R.foot);
    };
    arm(j.shF, j.armF, this.upperF, this.foreF, "af");
    leg(j.hipF, j.legF, this.thighF, this.shinF, this.footF, "lf");
    bone(this.torso, "to", j.px, j.py + 0.6, j.nx, j.ny + 1.6, R.torso);
    leg(j.hipN, j.legN, this.thighN, this.shinN, this.footN, "ln");
    arm(j.shN, j.armN, this.upperN, this.foreN, "an");
    // The head's look (the pointer, the other writer): up to 2.4 units toward it, the head first.
    const dt = this.lastT == null ? -1 : (t - this.lastT) / 1000;
    this.lastT = t;
    let tx = 0;
    let ty = 0;
    if (j.look) {
      const dx = j.look.x - j.hx;
      const dy = j.look.y - j.hy;
      const d = Math.hypot(dx, dy) || 1;
      const m = Math.min(2.4, d * 0.1);
      tx = (dx / d) * m;
      ty = (dy / d) * m;
    }
    const jump = still || dt < 0 || dt > 1;
    const hx = q(j.hx + (jump ? this.lookX.reset(tx) : this.lookX.step(Math.min(dt, 0.05), tx)));
    const hy = q(j.hy + (jump ? this.lookY.reset(ty) : this.lookY.step(Math.min(dt, 0.05), ty)));
    S(this.head, "hd", "transform", `translate(${f2(hx)} ${f2(hy)})${un}`);
    // the page: its prop (read, carried, handed over), or one taken (at its desk, beside the desk) —
    // while it is being passed over, on its way from the hand that gives it
    const passing = (j.hold ?? 0) > 0.01 && !!j.holdFrom && (j.holdU ?? 1) < 0.999;
    const prop = !passing && (j.prop === "sheet" || j.prop === "carry") && j.propAlpha > 0.01;
    const taken = !prop && (j.hold ?? 0) > 0.01;
    S(this.sheet, "sh", "display", prop || taken ? "inline" : "none");
    if (prop || taken) {
      const carry = taken || j.prop === "carry";
      const alpha = taken ? (j.hold ?? 0) : j.propAlpha;
      const w = carry ? 5.6 : 6.8;
      const h = carry ? 7 : 8.8;
      S(this.sheetRect, "sr", "x", -w / 2);
      S(this.sheetRect, "sr", "y", -h / 2);
      S(this.sheetRect, "sr", "width", w);
      S(this.sheetRect, "sr", "height", h);
      const x0 = f2(-w / 2 + 1.4);
      S(this.sheetLines, "sl", "d", `M${x0} ${f2(-h / 2 + 2.2)}h${f2(w - 2.8)}M${x0} ${f2(-h / 2 + 4.2)}h${f2(w - 3.8)}M${x0} ${f2(-h / 2 + 6.2)}h${f2(w - 2.8)}`);
      // a page read in both hands; one carried or handed over in the near hand
      let mx = carry || j.walking ? j.armN.ex : (j.armN.ex + j.armF.ex) / 2;
      let my = carry || j.walking ? j.armN.ey : (j.armN.ey + j.armF.ey) / 2;
      if (passing && j.holdFrom) {
        const u = j.holdU ?? 1;
        mx = j.holdFrom.x + (mx - j.holdFrom.x) * u;
        my = j.holdFrom.y + (my - j.holdFrom.y) * u;
      }
      // it fades and grows in; while reading, now and then a page turns (edge-on and back)
      const u = (t % 1800) / 1800;
      const page = still || carry || u >= 0.12 ? 1 : Math.abs(Math.cos((u / 0.12) * Math.PI));
      const sc = (0.6 + 0.4 * alpha) * K;
      S(this.sheet, "sh", "opacity", Math.min(1, alpha * 1.2));
      S(this.sheet, "sh", "transform", `translate(${f2(q(mx + L(0.8 * K)))} ${f2(q(my + (1.4 - h / 2) * K))}) rotate(${-10 * f}) scale(${f2(page * sc)} ${f2(sc)})`);
    }
    if (this.badge) S(this.badge, "bg", "transform", `translate(${f2(hx - L(RIG.head + 1.2))} ${f2(hy - RIG.head * 0.85)})${un}`);
    S(this.markG, "mk", "display", j.mark ? "inline" : "none");
    if (j.mark) {
      S(this.markG, "mk", "transform", `translate(${f2(hx + L(RIG.head + 3.4))} ${f2(hy - MARK_UP)})${un}`);
      S(this.markC, "mc", "fill", j.markMuted ? "var(--fg-faint)" : "var(--caution-dot)");
      if (this.markT.textContent !== j.mark) this.markT.textContent = j.mark;
    }
    S(this.rigLines, "rl", "display", sel ? "inline" : "none");
    S(this.rigJoints, "rj", "display", sel ? "inline" : "none");
    if (sel) {
      const p = (x: number, y: number) => `${f2(x)} ${f2(y)}`;
      const aN = { x: j.legN.ex, y: j.legN.ey - RIG.ankle };
      const aF = { x: j.legF.ex, y: j.legF.ey - RIG.ankle };
      const chain = (a: Pt, b: Bone, end: Pt) => `M${p(a.x, a.y)}L${p(b.jx, b.jy)}L${p(end.x, end.y)}`;
      const hand = (b: Bone) => ({ x: b.ex, y: b.ey });
      const joint = (b: Bone) => ({ x: b.jx, y: b.jy });
      S(this.rigLines, "rl", "d", chain(j.hipN, j.legN, aN) + chain(j.hipF, j.legF, aF) + chain(j.shN, j.armN, hand(j.armN)) + chain(j.shF, j.armF, hand(j.armF)) + `M${p(j.px, j.py)}L${p(j.nx, j.ny)}L${p(j.hx, j.hy)}`);
      const pts = [j.hipN, joint(j.legN), aN, j.hipF, joint(j.legF), aF, j.shN, joint(j.armN), hand(j.armN), j.shF, joint(j.armF), hand(j.armF), { x: j.px, y: j.py }, { x: j.nx, y: j.ny }];
      S(this.rigJoints, "rj", "d", pts.map((q) => `M${p(q.x - 1.05, q.y)}a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0 -2.1 0`).join(""));
    }
  }

  /** Place the figure (screen transform), fade it, dim it (trace). */
  place(x: number, y: number, scale: number, opacity: number, dim: boolean, idle = false) {
    this.set(this.g, "g", "transform", `translate(${f2(x)} ${f2(y)}) scale(${f2(scale)})`);
    this.set(this.g, "g", "opacity", opacity >= 1 ? "1" : f2(opacity));
    this.set(this.g, "g", "data-dim", dim ? "1" : "0");
    if (this.last.idle !== String(idle)) {
      this.last.idle = String(idle);
      this.g.toggleAttribute("data-idle", idle);
    }
  }
}
