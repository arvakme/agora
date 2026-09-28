// Frame-rate budget for the canvas overlay (web/docs/workstation.md §性能).
//
//   node scripts/bench-overlay.ts <base url of a built page> [label] [--agents 18 --elements 500]
//
// Opens `<url>/?fresh&bench=<agents>x<elements>` in Playwright's Chromium (1440×900, dpr 1),
// with the 工位视图 on and off, idle (live animation only) and while panning (wheel), and records
// each 5 s window with CDP tracing (Tracing.start, devtools.timeline + user timing). Per window:
//   frames      animation frames the page got (an in-page rAF counter)
//   main ms/f   main-thread RunTask time on the renderer's main thread ÷ frames
//   p95 / >20ms frame intervals (from rAF timestamps): smoothness
//   ws ms/f     the overlay's own measured work per frame (performance.measure "ws:frame"), if any
// The overlay's cost is main ms/f with the view on minus with it off, for the same scene.
import { chromium, type CDPSession, type Page } from "playwright";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = args[0];
const label = args[1] && !args[1].startsWith("--") ? args[1] : "run";
const opt = (k: string, d: number) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const AGENTS = opt("agents", 18);
const ELEMENTS = opt("elements", 500);
const SECONDS = opt("seconds", 5);
const SCENARIOS = (args.includes("--scenarios") ? args[args.indexOf("--scenarios") + 1] : "idle,pan").split(",") as ("idle" | "pan")[];
const VIEWS = (args.includes("--views") ? args[args.indexOf("--views") + 1] : "on,off").split(",").map((v) => v === "on");
if (!url) {
  console.error("usage: node scripts/bench-overlay.ts <url> [label]");
  process.exit(2);
}

type TraceEvent = { name: string; cat: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string } };

async function trace(cdp: CDPSession, during: () => Promise<void>): Promise<TraceEvent[]> {
  const done = new Promise<string>((ok) => cdp.once("Tracing.tracingComplete", (e) => ok((e as { stream: string }).stream)));
  await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: ["toplevel", "blink.user_timing", "devtools.timeline"] } } as never);
  await during();
  await cdp.send("Tracing.end");
  const stream = await done;
  let text = "";
  for (;;) {
    const r = (await cdp.send("IO.read", { handle: stream, size: 1 << 20 } as never)) as { data: string; eof: boolean; base64Encoded?: boolean };
    text += r.base64Encoded ? Buffer.from(r.data, "base64").toString() : r.data;
    if (r.eof) break;
  }
  await cdp.send("IO.close", { handle: stream } as never);
  const parsed = JSON.parse(text) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
}

async function frames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __rafs: number[]; __rafOn: boolean };
    w.__rafs = [];
    w.__rafOn = true;
    const tick = (t: number) => {
      w.__rafs.push(t);
      if (w.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () =>
    page.evaluate(() => {
      const w = window as unknown as { __rafs: number[]; __rafOn: boolean };
      w.__rafOn = false;
      return w.__rafs;
    });
}

async function drive(page: Page, scenario: "idle" | "pan") {
  const box = await page.locator(".canvas-layers").first().boundingBox();
  const end = Date.now() + SECONDS * 1000;
  if (scenario === "idle") return page.waitForTimeout(SECONDS * 1000);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  let dir = 1;
  for (let i = 0; Date.now() < end; i++) {
    if (i % 60 === 0) dir = -dir;
    await page.mouse.wheel(dir * 6, dir * 4);
    await page.waitForTimeout(16);
  }
}

/** One window untraced (frame rate, frame intervals), then one traced (main-thread time per frame). */
async function measure(page: Page, cdp: CDPSession, scenario: "idle" | "pan") {
  let stop = await frames(page);
  await drive(page, scenario);
  const rafs = await stop();
  const iv = rafs.slice(1).map((t, i) => t - rafs[i]).sort((a, b) => a - b);
  const q = (x: number) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(x * iv.length))] : 0);
  await page.evaluate(() => performance.clearMeasures("ws:frame"));
  stop = await frames(page);
  const events = await trace(cdp, () => drive(page, scenario));
  const traced = Math.max(1, (await stop()).length);
  const wsMs = await page.evaluate(() => performance.getEntriesByName("ws:frame").reduce((n, e) => n + e.duration, 0));
  const wsN = await page.evaluate(() => performance.getEntriesByName("ws:frame").length);
  const threads = events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const count = (m: TraceEvent) => events.filter((e) => e.pid === m.pid && e.tid === m.tid).length;
  const main = threads.sort((a, b) => count(b) - count(a))[0];
  // top-level tasks only (a nested RunTask lies inside its parent)
  const tasks = events.filter((e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === "X" && /RunTask$/.test(e.name)).sort((a, b) => a.ts - b.ts);
  let busy = 0;
  let until = -Infinity;
  for (const e of tasks) {
    if (e.ts >= until) {
      busy += e.dur ?? 0;
      until = e.ts + (e.dur ?? 0);
    }
  }
  return {
    fps: +(rafs.length / SECONDS).toFixed(1),
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    over20ms: iv.filter((x) => x > 20).length,
    mainMsPerFrame: +(busy / 1000 / traced).toFixed(2),
    tracedFrames: traced,
    wsMsPerFrame: wsN ? +(wsMs / traced).toFixed(3) : null,
  };
}

const browser = await chromium.launch({ headless: true, args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"].slice(0, 0) });
const results: Record<string, unknown> = {};
for (const ws of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((on: boolean) => {
    try {
      localStorage.setItem("agora.workstation", JSON.stringify({ c1: on }));
      localStorage.setItem("agora.workstation.v2", on ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, ws);
  const page = await ctx.newPage();
  await page.goto(`${url.replace(/\/$/, "")}/?fresh&bench=${AGENTS}x${ELEMENTS}`);
  await page.waitForFunction(() => (window as unknown as { __bench?: { ready: boolean } }).__bench?.ready, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500); // let the first layout settle
  page.on("crash", () => console.log("crash at", new Date().toISOString()));
  const cdp = await ctx.newCDPSession(page);
  for (const scenario of SCENARIOS) {
    const r = await measure(page, cdp, scenario).catch((e: Error) => ({ error: String(e.message).split("\n")[0] }));
    results[`${ws ? "on" : "off"}/${scenario}`] = r;
    console.log(label, ws ? "工位视图开" : "工位视图关", scenario, JSON.stringify(r));
  }
  await ctx.close();
}
await browser.close();
const overlay = (s: "idle" | "pan") => {
  const on = results[`on/${s}`] as { mainMsPerFrame?: number };
  const off = results[`off/${s}`] as { mainMsPerFrame?: number };
  return on?.mainMsPerFrame == null || off?.mainMsPerFrame == null ? null : +(on.mainMsPerFrame - off.mainMsPerFrame).toFixed(2);
};
const summary = { label, agents: AGENTS, elements: ELEMENTS, seconds: SECONDS, results, overlayMsPerFrame: { idle: overlay("idle"), pan: overlay("pan") } };
console.log(JSON.stringify(summary.overlayMsPerFrame));
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
