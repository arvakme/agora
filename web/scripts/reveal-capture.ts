// Evidence for 分站揭示 (web/docs/workstation.md §2 智能体改图): an agent's one `agora canvas apply` that draws a whole diagram, on a fresh canvas,
// as the live 工位视图 shows it.
//
//   node scripts/reveal-capture.ts <dev page url> <out.mp4> [--library] [--dark] [--reduced] [--frames <dir> [--every <ms>]] [--click <s>]
//
// Needs the vite dev server (the page's own modules are imported to stand in for the agent: a Pi session is bound on the first canvas and
// `applyFromAgent` — the page executor `agora canvas apply` runs through — is called with one batch of 12 nodes and 8 arrows) and a backend on an empty
// project (each run adds the diagram to the first canvas: start the backend on a fresh project for each). Records the page from just before the batch
// until the figure is done, crops nothing, writes an MP4 (ffmpeg) and, with --frames, a PNG a second (or every `--every` ms, named by ms after the batch); `--click <s>`: click the canvas that many seconds in.
// At the end it prints whether the page's own picture is gone and the opacities of the elements in the saved canvas (the agent's: never the page's).
// The Chromium is Playwright's, or `CHROMIUM=<path>` when the installed Playwright's own build is not there.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const [url, out] = args;
if (!url || !out) {
  console.error("usage: node scripts/reveal-capture.ts <url> <out.mp4> [--dark] [--reduced] [--frames <dir>]");
  process.exit(2);
}
const dark = args.includes("--dark");
const reduced = args.includes("--reduced");
const framesDir = args.includes("--frames") ? args[args.indexOf("--frames") + 1] : null;
const clickAt = args.includes("--click") ? Number(args[args.indexOf("--click") + 1]) : null;
const every = args.includes("--every") ? Number(args[args.indexOf("--every") + 1]) : 1000;
const library = args.includes("--library");
const VIEW = { width: 1280, height: 800 };
/** --library: when the second batch (the synthetic scene) is applied, after the first. */
const SECOND_AT_MS = 13_000;
const RECORD_MS = library ? 28_000 : 14_000;
/** --library: the components placed, chosen to cover the libraries (official ones, community ones, Lucide icons) and their odd elements. */
const LIBRARY_ITEMS = [
  "lucide/r#51",
  "official/drwnio/drwnio#1",
  "official/pclainchard/it-logos#4",
  "official/excacomp/mobile-kit#0",
  "official/cloud/cloud#1",
  "official/drwnio/storytelling#4",
  "official/youritjang/software-architecture#1",
  "jonra-agentic-flows/agentic-flows-casual#0",
  "marcrow-pentest/pentest#0",
  "hon668-hvac/library/hvac-excalidraw-library-zh-v1.0.0#0",
  "w-gitops/homelab-icons-symbols#0",
  "lucide/d#0",
];

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const tmp = mkdtempSync(join(tmpdir(), "reveal-"));
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: dark ? "dark" : "light", reducedMotion: reduced ? "reduce" : "no-preference", recordVideo: { dir: tmp, size: VIEW } });
const t0 = Date.now();
const page = await ctx.newPage();
await page.goto(url);
await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

// A Pi session on the first canvas, and the batch it applies: an architecture (12 nodes, 8 arrows) in one call; or (--library) a grid of library
// components in one call (insert_library_item, as an agent places them), then a second batch with the synthetic scene of every element type
// (scripts/ink-scenes.ts: it is not something ops can make, so it is applied the way applyFromAgent applies a batch: the figure is told, the reveal
// holds what it adds, the scene changes).
const startAt = await page.evaluate(async ({ library, items }) => {
  const imp = (p: string) => import(/* @vite-ignore */ p);
  const { agents } = await imp("/src/session/agents.ts");
  const { sessions } = await imp("/src/session/store.ts");
  const { applyFromAgent } = await imp("/src/session/agentBridge.ts");
  const w = window as unknown as { __agora: { handles: Map<string, unknown> } };
  const canvasId = [...w.__agora.handles.keys()][0];
  const s = sessions.create(canvasId);
  sessions.commit?.(s.id);
  agents.hydrateBindings({ [s.id]: { agent: "pi", model: "", effort: "", nativeId: null, createdAt: Date.now(), started: true } });
  (window as unknown as { __sid: string }).__sid = s.id;
  const col = (i: number) => 60 + i * 300;
  const row = (j: number) => 60 + j * 200;
  const shape = (ref: string, text: string, i: number, j: number) => ({ op: "add_shape", ref, shape: "rectangle", text, x: col(i), y: row(j), width: 200, height: 80 });
  const ops = library
    ? items.map((item: string, k: number) => ({ op: "insert_library_item", ref: `lib${k}`, item, at: { x: 40 + (k % 4) * 300, y: 40 + Math.floor(k / 4) * 240 }, width: 170 }))
    : [
        shape("web", "Web 前端", 0, 0),
        shape("mobile", "移动端", 1, 0),
        shape("admin", "管理后台", 2, 0),
        shape("gw", "API 网关", 1, 1),
        shape("auth", "认证服务", 0, 2),
        shape("order", "订单服务", 1, 2),
        shape("pay", "支付服务", 2, 2),
        shape("search", "搜索服务", 3, 2),
        shape("pg", "Postgres", 0, 3),
        shape("redis", "Redis 缓存", 1, 3),
        shape("mq", "消息队列", 2, 3),
        shape("es", "Elasticsearch", 3, 3),
        { op: "add_arrow", from: "web", to: "gw" },
        { op: "add_arrow", from: "mobile", to: "gw" },
        { op: "add_arrow", from: "admin", to: "gw" },
        { op: "add_arrow", from: "gw", to: "order" },
        { op: "add_arrow", from: "order", to: "pg" },
        { op: "add_arrow", from: "order", to: "mq" },
        { op: "add_arrow", from: "pay", to: "mq" },
        { op: "add_arrow", from: "search", to: "es" },
      ];
  // a fresh project opens a 新会话 pane beside the canvas once there is a session: closed, so the canvas has the window
  await new Promise((r) => setTimeout(r, 600));
  document.querySelector<HTMLButtonElement>('.wm-tab[data-kind="session"] button.wm-tab-close')?.click(); // by kind, not by its (translated) name
  await new Promise((r) => setTimeout(r, 600));
  console.log("pane closed:", !document.querySelector('.wm-tab[data-kind="session"]'));
  // the components' grid in view
  if (library) (w.__agora.handles.get(canvasId) as { api: { updateScene(x: unknown): void } }).api.updateScene({ appState: { scrollX: 30, scrollY: 40, zoom: { value: 0.82 } } });
  await new Promise((r) => setTimeout(r, 1200));
  const at = Date.now();
  const res = await applyFromAgent({ canvasId, sessionId: s.id, plan: { ops, note: library ? "放一组素材库组件" : "画出这个项目的架构" }, versions: {} });
  console.log("apply", JSON.stringify(res).slice(0, 400));
  return at;
}, { library, items: LIBRARY_ITEMS });
const second = (async () => {
  if (!library) return;
  // the second batch, once the first is drawn: the synthetic scene, below the components, the view moved to it
  const due = startAt + SECOND_AT_MS - Date.now();
  if (due > 0) await page.waitForTimeout(due);
  await page.evaluate(async () => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { syntheticScene } = await imp("/scripts/ink-scenes.ts");
    const { touches, touchNodesOf } = await imp("/src/workstation/runs/touch.ts");
    const { holdReveal } = await imp("/src/workstation/RevealLayer.tsx");
    const w = window as unknown as { __agora: { handles: Map<string, { api: { getSceneElements(): { id: string }[]; updateScene(x: unknown): void; addFiles(f: unknown[]): void } }> }; __sid: string };
    const [canvasId, h] = [...w.__agora.handles.entries()][0];
    const api = h.api;
    const { elements, files } = syntheticScene("syn", 40, 820);
    api.addFiles(Object.values(files));
    api.updateScene({ appState: { scrollX: 20, scrollY: -780, zoom: { value: 0.58 } } });
    await new Promise((r) => setTimeout(r, 800));
    const after = [...api.getSceneElements(), ...elements];
    const map = new Map(after.map((e) => [e.id, e]));
    const at = Date.now();
    touches.record({ session: w.__sid, canvas: canvasId, at, until: at, nodes: touchNodesOf(elements.map((e: { id: string }) => e.id), map), say: "每种元素各画一个" });
    const held = holdReveal(canvasId, at, elements.map((e: { id: string }) => e.id), map);
    api.updateScene({ elements: after, captureUpdate: "IMMEDIATELY" });
    for (const ms of [300, 1000, 2500]) {
      await new Promise((r) => setTimeout(r, ms));
      console.log(`second batch: held ${held}, ${ms} ms on: revealing ${!!document.querySelector(".canvas-layers[data-revealing]")}, pictures ${document.querySelectorAll(".ws-reveal-pic").length}`);
    }
  });
})();
page.on("console", (m) => console.log("[page]", m.text()));
const shots: Promise<unknown>[] = [];
if (framesDir) {
  mkdirSync(framesDir, { recursive: true });
  for (let s = 0; s * every < RECORD_MS; s++) {
    const due = startAt + s * every - Date.now();
    if (due > 0) await page.waitForTimeout(due);
    shots.push(page.screenshot({ path: join(framesDir, `t${String(s * every).padStart(5, "0")}.png`) }));
  }
}
if (clickAt != null) {
  // a person clicks an empty spot of the canvas mid-way: everything shows at once
  const due = startAt + clickAt * 1000 - Date.now();
  if (due > 0) await page.waitForTimeout(due);
  await page.mouse.click(120, 700);
  await page.waitForTimeout(50);
  console.log("after click: revealing =", await page.evaluate(() => !!document.querySelector(".canvas-layers[data-revealing]")));
}
const left = startAt + RECORD_MS - Date.now();
if (left > 0) await page.waitForTimeout(left);
await Promise.all(shots);
await second;
// at the end: the page's own picture is gone (Excalidraw's static canvas is back), and the saved canvas has every element as the agent made it
const end = await page.evaluate(async () => {
  const w = window as unknown as { __agora: { handles: Map<string, unknown> } };
  const id = [...w.__agora.handles.keys()][0];
  await new Promise((r) => setTimeout(r, 1500)); // the save queue
  const saved = await (await fetch(`/api/project/canvases/${encodeURIComponent(id)}`)).json();
  const els = (saved.elements ?? saved.scene?.elements ?? []) as { opacity: number; isDeleted?: boolean }[];
  return { revealing: !!document.querySelector(".canvas-layers[data-revealing]"), saved: els.filter((e) => !e.isDeleted).length, opacities: [...new Set(els.map((e) => e.opacity))] };
});
console.log("end:", JSON.stringify(end));
await ctx.close();
await browser.close();
const [video] = readdirSync(tmp).filter((f) => f.endsWith(".webm"));
// the batch lands about this far into the recording; start a second before it
const from = Math.max(0, (startAt - t0) / 1000 - 1);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", from.toFixed(2), "-i", join(tmp, video), "-t", String(RECORD_MS / 1000 + 1), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", out]);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out} (from ${from.toFixed(2)} s)`);
