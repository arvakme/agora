// Synthetic load for the overlay frame-rate budget (docs: web/docs/workstation.md §性能):
// `?fresh&bench=18x500` replaces the first canvas with a ~500-element diagram whose nodes are
// linked to code paths, and injects 18 running agent sessions whose transcripts keep reading,
// writing and running commands on those nodes for the next 20 minutes. Nothing is persisted and
// no server is needed (`?fresh`). scripts/bench-overlay.ts drives it with CDP tracing.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { buildArrow, buildShape, type El } from "../canvas/scene";
import { handleEvent, type AgentKind, type Item } from "../session/agents";

const spec = new URLSearchParams(location.search).get("bench");
export const BENCH = spec ? { agents: Number(spec.split("x")[0]) || 18, elements: Number(spec.split("x")[1]) || 500 } : null;

/** A seeded PRNG, so every run of the bench draws the same scene and the same work. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** About `n` elements: a grid of linked boxes (box + label), arrows between neighbours, small notes to fill up. */
export function benchScene(n: number): El[] {
  const nodes = Math.max(4, Math.round(n / 5));
  const cols = Math.ceil(Math.sqrt(nodes));
  const out: El[] = [];
  const boxes: El[] = [];
  for (let i = 0; i < nodes; i++) {
    const x = (i % cols) * 260;
    const y = Math.floor(i / cols) * 180;
    const els = buildShape({ id: `bn${i}`, shape: "rectangle", x, y, width: 170, height: 64, label: `模块 ${i}`, base: { customData: { codePaths: [`bench/n${i}/**`] } } as never });
    boxes.push(els[0]);
    out.push(...els);
  }
  for (let i = 0; i < nodes && out.length < n - 2; i++) {
    const j = i + 1 < nodes && (i + 1) % cols ? i + 1 : i + cols;
    if (j >= nodes) continue;
    out.push(...buildArrow({ id: `ba${i}`, from: boxes[i], to: boxes[j] }).filter((e) => e.type === "arrow"));
  }
  const r = rng(7);
  for (let k = 0; out.length < n; k++) {
    const b = boxes[k % boxes.length];
    out.push(...buildShape({ id: `bd${k}`, shape: "ellipse", x: b.x + 180 + r() * 40, y: b.y + r() * 40, width: 14, height: 14, label: "" }));
  }
  return out.slice(0, n);
}

const KINDS: AgentKind[] = ["pi", "claude", "codex"];

/** How far back the synthetic sessions' history reaches when the bench starts. */
const HISTORY_MS = 3 * 60_000;

/** One synthetic session's transcript: a user message, then tool calls every 2–4 s from 3 min ago to 20 min ahead. */
export function benchItems(i: number, nodes: number, now: number): Item[] {
  const r = rng(100 + i);
  const items: Item[] = [{ id: `u${i}`, kind: "user", text: `bench ${i}`, at: now - HISTORY_MS, source: "agora" }];
  let t = now - HISTORY_MS + 1000;
  let node = Math.floor(r() * nodes);
  for (let k = 0; t < now + 20 * 60_000; k++) {
    if (r() < 0.35) node = Math.floor(r() * nodes);
    const kind = r();
    const dur = 900 + r() * 2200;
    const path = `bench/n${node}/file${k % 5}.ts`;
    const tool =
      kind < 0.4
        ? { name: "Read", input: path }
        : kind < 0.8
          ? { name: "Edit", input: path, files: [{ path, op: "edit" as const }], output: "ok" }
          : { name: "Bash", input: `pytest bench/n${node}`, output: "ok" };
    items.push({ id: `t${i}-${k}`, kind: "tool", at: t, endAt: t + dur, msg: `m${i}-${k}`, tool });
    t += dur + 400 + r() * 900;
  }
  return items;
}

/** Load the bench scene into the canvas and start the synthetic sessions. */
export async function installBench(api: ExcalidrawImperativeAPI) {
  if (!BENCH) return;
  const scene = benchScene(BENCH.elements);
  api.updateScene({ elements: scene as never, captureUpdate: CaptureUpdateAction.NEVER });
  api.scrollToContent(undefined, { fitToContent: true, animate: false });
  const nodes = scene.filter((e) => e.id.startsWith("bn") && e.type === "rectangle").length;
  const now = Date.now();
  const all: { sessionId: string; items: Item[] }[] = [];
  for (let i = 0; i < BENCH.agents; i++) {
    const sessionId = `bench-${i}`;
    await handleEvent({
      t: "status",
      sessionId,
      binding: { agent: KINDS[i % 3], model: "", effort: "", nativeId: null, createdAt: now - 60_000 },
      running: true,
      busy: false,
      queued: 0,
      held: null,
      activity: null,
      error: null,
      terminal: { alive: false, attach: "", clients: 0, app: null },
    });
    all.push({ sessionId, items: benchItems(i, nodes, now) });
  }
  // Like a live session: the log only holds what has started. New calls arrive as their time
  // comes (once a second), each already carrying its end, as a finished call would.
  const sent = new Map<string, number>();
  const push = async () => {
    const at = Date.now();
    for (const { sessionId, items } of all) {
      const from = sent.get(sessionId) ?? 0;
      let to = from;
      while (to < items.length && items[to].at <= at) to++;
      if (to > from) await handleEvent({ t: "transcript", sessionId, items: items.slice(from, to), reset: from === 0 });
      sent.set(sessionId, to);
    }
  };
  await push();
  setInterval(() => void push(), 1000);
  Object.assign(window, { __bench: { ready: true, elements: scene.length, agents: BENCH.agents } });
}
