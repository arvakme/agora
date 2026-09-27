// Compiles a validated script into keyframe states (one per step boundary) and interpolates
// between them. Pure and engine-agnostic: engines only ever receive a Frame to draw.
import { NODE_H, NODE_W, type AnimScript, type Step, type Tone } from "./script.ts";

export type NodeState = { x: number; y: number; text: string; tone: Tone | null };
export type KeyState = { nodes: Record<string, NodeState>; caption: string };

/** What an engine draws for one node in one frame. `mix` is the tone blend (0 = base fill). */
export type NodeFrame = { id: string; x: number; y: number; text: string; from: Tone | null; to: Tone | null; mix: number };
export type Frame = { nodes: NodeFrame[]; caption: string; step: number; t: number };

export type Timeline = {
  script: AnimScript;
  states: KeyState[]; // states[i] = scene before step i; states[steps.length] = final
  /** Node ids that swap in each step (they arc past each other instead of colliding). */
  arcs: Map<string, number>[];
};

export function compile(script: AnimScript): Timeline {
  const first: KeyState = {
    nodes: Object.fromEntries(script.nodes.map((n) => [n.id, { x: n.x, y: n.y, text: n.text, tone: null }])),
    caption: "",
  };
  const states = [first];
  const arcs: Map<string, number>[] = [];
  for (const step of script.steps) {
    const { next, arc } = applyStep(states[states.length - 1], step);
    states.push(next);
    arcs.push(arc);
  }
  return { script, states, arcs };
}

function applyStep(prev: KeyState, step: Step) {
  const nodes: Record<string, NodeState> = {};
  for (const [id, n] of Object.entries(prev.nodes)) nodes[id] = { ...n };
  const arc = new Map<string, number>();
  let caption = prev.caption;
  // Unhighlights apply first so a same-step highlight wins ("clear, then colour").
  for (const a of step.actions) if (a.do === "unhighlight") for (const id of a.ids ?? Object.keys(nodes)) nodes[id].tone = null;
  for (const a of step.actions) {
    switch (a.do) {
      case "swap": {
        const pa = prev.nodes[a.a], pb = prev.nodes[a.b];
        Object.assign(nodes[a.a], { x: pb.x, y: pb.y });
        Object.assign(nodes[a.b], { x: pa.x, y: pa.y });
        arc.set(a.a, -1).set(a.b, 1); // one hops over, the other dips under
        break;
      }
      case "move":
        Object.assign(nodes[a.id], { x: a.x, y: a.y });
        break;
      case "highlight":
        for (const id of a.ids) nodes[id].tone = a.color;
        break;
      case "set_label":
        nodes[a.id].text = a.text;
        break;
      case "caption":
        caption = a.text;
        break;
    }
  }
  return { next: { nodes, caption }, arc };
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Frame for "step `step`, progress t∈[0,1]". step = steps.length means the final state. */
export function frameAt(tl: Timeline, step: number, t: number): Frame {
  const last = tl.script.steps.length;
  if (step >= last) return still(tl, last, 0);
  const a = tl.states[step], b = tl.states[step + 1];
  const e = easeInOut(t);
  const arc = tl.arcs[step];
  const nodes = tl.script.nodes.map(({ id, h }) => {
    const p = a.nodes[id], q = b.nodes[id];
    const lift = (arc.get(id) ?? 0) * Math.sin(Math.PI * e) * (h ?? NODE_H) * 0.9;
    return {
      id,
      x: p.x + (q.x - p.x) * e,
      y: p.y + (q.y - p.y) * e + lift,
      text: e < 0.5 ? p.text : q.text,
      from: p.tone,
      to: q.tone,
      mix: p.tone === q.tone ? 1 : e,
    };
  });
  return { nodes, caption: t > 0 ? b.caption : a.caption, step, t };
}

function still(tl: Timeline, step: number, t: number): Frame {
  const s = tl.states[step];
  return {
    nodes: tl.script.nodes.map(({ id }) => ({ id, x: s.nodes[id].x, y: s.nodes[id].y, text: s.nodes[id].text, from: s.nodes[id].tone, to: s.nodes[id].tone, mix: 1 })),
    caption: s.caption,
    step,
    t,
  };
}

/** Bounding box of every position any node visits (so the region never clips the motion). */
export function extent(tl: Timeline) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const size = new Map(tl.script.nodes.map((n) => [n.id, { w: n.w ?? NODE_W, h: n.h ?? NODE_H }]));
  tl.states.forEach((s, i) => {
    for (const [id, n] of Object.entries(s.nodes)) {
      const { w, h } = size.get(id)!;
      const lift = tl.arcs[i - 1]?.has(id) ? h : 0;
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y - lift);
      x1 = Math.max(x1, n.x + w);
      y1 = Math.max(y1, n.y + h + lift);
    }
  });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Palette shared by both engines: [fill, stroke] per tone. */
export const TONE_COLORS: Record<Tone | "base", [string, string]> = {
  base: ["#f6f8fa", "#1f2328"],
  compare: ["#fff1c2", "#b7791f"],
  swap: ["#ffd8cc", "#c2410c"],
  done: ["#d3f2dd", "#2f7d4f"],
  focus: ["#e3dcff", "#6d5bd0"],
  visited: ["#dbeafe", "#2563eb"],
  muted: ["#eeeeec", "#a3a3a3"],
};

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function mixHex(a: string, b: string, t: number) {
  const [p, q] = [hex(a), hex(b)];
  return "#" + p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
/** [fill, stroke] for a node frame. */
export function colorsOf(n: NodeFrame): [string, string] {
  const [f0, s0] = TONE_COLORS[n.from ?? "base"], [f1, s1] = TONE_COLORS[n.to ?? "base"];
  return [mixHex(f0, f1, n.mix), mixHex(s0, s1, n.mix)];
}
