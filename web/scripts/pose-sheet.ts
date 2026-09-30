// The 姿势体检 frames drawn by the real figure drawing (src/workstation/figureNode.ts), as a contact sheet in the browser — what
// `scripts/pose-check.ts --sheet` sketches with plain lines, here with the app's own bones, colours and cut lines.
//
//   cd web && npx vite            then open  /scripts/pose-sheet.html?match=door&every=100&from=0&to=2000&cols=10
//
// `match`: a substring of "scenario | label"; `every` (ms between the frames drawn), `from`, `to`, `cols`. A red tile breaks a rule of
// poseHealth.ts (its name is under the time). One <h3> per scenario-label group.
import "../src/app/tokens.css";
import "../src/app/styles.css";
import { cutLine } from "../src/workstation/hatch";
import { FigureNode } from "../src/workstation/figureNode";
import { checkJoints, frames, type Frame } from "../src/workstation/poseHealth";
import { DOOR_H } from "../src/workstation/rig";

const q = new URLSearchParams(location.search);
const match = q.get("match");
const every = Number(q.get("every") ?? 100);
const from = Number(q.get("from") ?? -Infinity);
const to = Number(q.get("to") ?? Infinity);
const cols = Number(q.get("cols") ?? 0);
const NS = "http://www.w3.org/2000/svg";
const SCALE = 2.3;
const W = 150;
const GROUND = 128;

// ?track=1: no sheet — every frame goes through ONE figure, as in the app, and the elbows are read back from its drawing (the path of each
// upper arm), for the frame-to-frame step of the elbow in a real browser: window.__track = [{ label, t, near: [x, y], far: [x, y] }]
const track = q.get("track");

const all = frames().filter((f) => !match || `${f.scenario} | ${f.label}`.includes(match));
const root = document.getElementById("sheet")!;
if (track) runTrack();

if (cols) root.style.width = `${cols * (W + 6) + 12}px`;

let last = -Infinity;
let group = "";
for (const fr of track ? [] : all) {
  const g = `${fr.scenario} | ${fr.label}`;
  if (g !== group) {
    group = g;
    last = -Infinity;
    const h = document.createElement("h3");
    h.textContent = g;
    h.style.flexBasis = "100%";
    root.appendChild(h);
  }
  if (fr.t < from || fr.t > to || fr.t - last < every - 1e-6) continue;
  last = fr.t;
  root.appendChild(tile(fr));
}
document.title = "ready";
document.body.dataset.ready = "1";

function tile(fr: Frame): HTMLElement {
  const issues = checkJoints(fr.joints, fr.expect);
  const d = document.createElement("div");
  d.className = "tile";
  if (issues.length) d.dataset.bad = "1";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(W));
  d.appendChild(svg);
  const line = (y: number, stroke: string, w = 1.5) => {
    const l = document.createElementNS(NS, "line");
    for (const [k, v] of Object.entries({ x1: 0, x2: W, y1: y, y2: y, stroke, "stroke-width": w })) l.setAttribute(k, String(v));
    svg.appendChild(l);
  };
  line(GROUND, "#111");
  const dir = fr.ladder?.dir;
  if (dir) {
    // a door's rails: on the parent's canvas standing HATCH_POST above the floor, on the sub-diagram's hanging from one figure's height above
    for (const dx of [-2.6, 2.6]) {
      const l = document.createElementNS(NS, "line");
      const top = dir === 1 ? -34 : -DOOR_H;
      for (const [k, v] of Object.entries({ x1: W / 2 + dx * SCALE, x2: W / 2 + dx * SCALE, y1: GROUND + top * SCALE, y2: GROUND + (dir === 1 ? DOOR_H : 0) * SCALE, stroke: "#777" })) l.setAttribute(k, String(v));
      svg.appendChild(l);
    }
  }
  const node = new FigureNode(`f${fr.t}`, "claude", { label: "" });
  const rootY = dir ? fr.joints.root.y / fr.k : 0;
  node.place(W / 2, GROUND + rootY * SCALE, SCALE, 1, false);
  if (dir) node.cut(dir === 1 ? "above" : "below", dir === 1 ? -rootY : -DOOR_H - rootY);
  node.draw(fr.joints, fr.t, false);
  svg.appendChild(node.g);
  const label = document.createElement("span");
  label.textContent = `${Math.round(fr.t)} ms${issues.length ? " · " + [...new Set(issues.map((i) => i.rule))].join(",") : ""}`;
  d.appendChild(label);
  void cutLine;
  return d;
}

function runTrack() {
  const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
  // a capsule's two ends from its path: the same reading as the evidence of BP1 (web/docs/workstation.md §16)
  const ends = (d: string) => {
    const n = nums(d);
    return n.length < 13 ? null : { a: [(n[0] + n[11]) / 2, (n[1] + n[12]) / 2], b: [(n[2] + n[9]) / 2, (n[3] + n[10]) / 2] };
  };
  const out: { label: string; t: number; near: number[] | null; far: number[] | null; f: number; skip: boolean }[] = [];
  const svg = document.createElementNS(NS, "svg");
  document.body.appendChild(svg);
  const node = new FigureNode("track", "claude", { label: "" });
  svg.appendChild(node.g);
  node.place(80, 120, 2, 1, false);
  let label = "";
  for (const fr of all) {
    const g = `${fr.scenario} | ${fr.label}`;
    if (g !== label) {
      label = g;
      node.draw(fr.joints, fr.t, true); // a new run: the frame before is not this one's
    }
    node.draw(fr.joints, fr.t, false);
    const paths = [...(node.g.children[1]?.children ?? [])].filter((c) => c.tagName === "path");
    const up = ends(paths[9]?.getAttribute("d") ?? "");
    const upF = ends(paths[0]?.getAttribute("d") ?? "");
    out.push({ label: g, t: fr.t, near: up?.b ?? null, far: upF?.b ?? null, f: fr.joints.f, skip: fr.expect.turning || !!fr.hidden });
  }
  (window as unknown as { __track: typeof out }).__track = out;
  document.body.dataset.ready = "1";
}
