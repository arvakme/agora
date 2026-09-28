// Motion evidence for the 工位视图 (web/docs/workstation.md §动效).
//
//   node scripts/motion-capture.ts <page url> <out dir> [--dark] [--reduced]
//
// Opens `<url>/?mock=runs&perf` (the prototype's scripted scenario: one main agent, a Seedmux
// worker with tool calls, a receipts-only worker, a Claude Task sub-agent) in Playwright's
// Chromium at 1440×900, and records, frame by frame with requestAnimationFrame timestamps, the
// on-screen box of every figure and bubble and the playhead's transform. Windows: a walk, a pose
// change, bubbles entering / leaving (dispatch, hand-back), and replay scrubbing on the timeline.
// Per window it reports
//   frames, dropped      frames the display should have shown but the page missed (60 Hz)
//   maxGap               the longest time between two frames
//   jank25               frame gaps longer than 25 ms
//   maxStep              the largest one-frame move of any tracked element (screen px)
//   snaps (> 2 px)       one-frame position discontinuities: this frame's move minus the previous
//                        frame's (time-corrected) — a sudden change of velocity (a pop), not
//                        steady motion; moves while the element is below 25% opacity (a
//                        cross-fade) are not counted
// and saves a video of the whole run plus an MP4 and a GIF per window (ffmpeg).
import { chromium, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, out = "evidence/focus/motion"] = process.argv.slice(2);
const dark = process.argv.includes("--dark");
const reduced = process.argv.includes("--reduced");
if (!url) {
  console.error("usage: node scripts/motion-capture.ts <url> [out dir] [--dark] [--reduced]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const vidDir = join(out, ".video");
mkdirSync(vidDir, { recursive: true });

type Sample = { t: number; els: Record<string, [number, number, number]> };

async function startSampler(page: Page) {
  await page.evaluate(() => {
    type S = { t: number; els: Record<string, [number, number, number]> };
    const w = window as unknown as { __samples: S[]; __sampling: boolean };
    w.__samples = [];
    w.__sampling = true;
    const tick = (t: number) => {
      if (!w.__sampling) return;
      const els: S["els"] = {};
      document.querySelectorAll<SVGGElement>(".ws-worker").forEach((g) => {
        const r = g.querySelector(".ws-hit")!.getBoundingClientRect();
        els[`fig:${g.dataset.run}`] = [r.x + r.width / 2, r.y + r.height, Number(g.getAttribute("opacity") ?? 1)];
      });
      document.querySelectorAll<HTMLElement>(".ws-bub-pos").forEach((b, i) => {
        const inner = b.firstElementChild as HTMLElement;
        const r = inner.getBoundingClientRect();
        const key = inner.querySelector(".who")?.textContent ?? String(i);
        els[`bub:${key}`] = [r.x, r.y, b.style.visibility === "hidden" ? 0 : Number(getComputedStyle(b).opacity) * Number(getComputedStyle(inner).opacity)];
      });
      const ph = document.querySelector<HTMLElement>(".ws-tl .mph, .ws-tl .ph");
      if (ph) {
        const r = ph.getBoundingClientRect();
        els.playhead = [r.x, r.y, 1];
      }
      w.__samples.push({ t, els });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
async function stopSampler(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __sampling: boolean };
    w.__sampling = false;
    return w.__samples;
  });
}

function analyse(samples: Sample[], opts: { expectJumps?: string[] } = {}) {
  const iv = samples.slice(1).map((s, i) => s.t - samples[i].t);
  const dropped = iv.reduce((n, x) => n + Math.max(0, Math.round(x / (1000 / 60)) - 1), 0);
  let maxStep = 0;
  let maxSnap = 0;
  const snaps: { el: string; at: number; px: number; abc: number[][] }[] = [];
  const keys = new Set(samples.flatMap((s) => Object.keys(s.els)));
  for (const k of keys) {
    if (opts.expectJumps?.some((p) => k.startsWith(p))) continue;
    for (let i = 2; i < samples.length; i++) {
      const a = samples[i - 2].els[k];
      const b = samples[i - 1].els[k];
      const c = samples[i].els[k];
      if (!a || !b || !c) continue;
      // A move made while the element is faded below 25% is a cross-fade (reduced motion: fade out
      // where it was, fade in where it goes), not a pop anyone sees.
      if (c[2] < 0.25 || b[2] < 0.25 || a[2] < 0.25) continue;
      const step = Math.hypot(c[0] - b[0], c[1] - b[1]);
      maxStep = Math.max(maxStep, step);
      const dtb = samples[i - 1].t - samples[i - 2].t || 1;
      const dtc = samples[i].t - samples[i - 1].t;
      const vx = ((b[0] - a[0]) / dtb) * dtc;
      const vy = ((b[1] - a[1]) / dtb) * dtc;
      const snap = Math.hypot(c[0] - b[0] - vx, c[1] - b[1] - vy);
      maxSnap = Math.max(maxSnap, snap);
      if (snap > 2) snaps.push({ el: k, at: Math.round(samples[i].t - samples[0].t), px: +snap.toFixed(2), abc: [a, b, c].map((p) => p.map((x) => +x.toFixed(1))) });
    }
  }
  return {
    frames: samples.length,
    seconds: +((samples.at(-1)!.t - samples[0].t) / 1000).toFixed(2),
    dropped,
    maxGap: +Math.max(...iv).toFixed(1),
    jank25: iv.filter((x) => x > 25).length,
    maxStep: +maxStep.toFixed(2),
    maxSnap: +maxSnap.toFixed(2),
    snaps: snaps.length,
    snapList: [...snaps].sort((x, y) => y.px - x.px).slice(0, 10),
    tracked: [...keys].filter((k) => !opts.expectJumps?.some((p) => k.startsWith(p))),
  };
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: dark ? "dark" : "light",
  reducedMotion: reduced ? "reduce" : "no-preference",
  recordVideo: { dir: vidDir, size: { width: 1440, height: 900 } },
});
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(`${url.replace(/\/$/, "")}/?mock=runs&perf`);
await page.waitForFunction(() => (window as unknown as { __mockBase?: number }).__mockBase, undefined, { timeout: 30_000 });
const base = await page.evaluate(() => (window as unknown as { __mockBase: number }).__mockBase);
const at = async (sec: number) => {
  const wait = base + sec * 1000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
};
type Win = ReturnType<typeof analyse> & { from: number; to: number };
const windows: Record<string, Win> = {};
const capture = async (name: string, from: number, to: number, during?: () => Promise<void>, expectJumps?: string[]) => {
  await at(from);
  await startSampler(page);
  const v0 = (Date.now() - t0) / 1000;
  if (during) await during();
  await at(to);
  const s = await stopSampler(page);
  windows[name] = { ...analyse(s, { expectJumps }), from: v0, to: (Date.now() - t0) / 1000 };
  console.log(name, JSON.stringify({ ...windows[name], tracked: undefined }));
};
// The scenario (runs/fixtures.ts): Claude Code walks from Web to the API node at 5.5 s; Pi walks to
// the DB node at 6.5 s and back to write at 12 s; sub-agents are dispatched at 19.6–20.5 s; Codex
// claims done at 33.6 s and walks back to hand over; the worker exits at 38 s.
await capture("walk", 4.8, 9.5);
await capture("pose", 11, 15.5);
await capture("bubbles-enter", 18.8, 23.5);
await capture("handoff-exit", 33, 39.5);
// Replay: drag the strip's playhead from near now back to the start, then forward again.
await at(41);
const box = await page.locator(".ws-tl .mini").boundingBox();
await capture(
  "replay-scrub",
  41.2,
  45.5,
  async () => {
    if (!box) return;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.95, y);
    await page.mouse.down();
    for (let i = 0; i <= 90; i++) {
      await page.mouse.move(box.x + box.width * (0.95 - (0.9 * i) / 90), y);
      await page.waitForTimeout(16);
    }
    for (let i = 0; i <= 60; i++) {
      await page.mouse.move(box.x + box.width * (0.05 + (0.5 * i) / 60), y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  },
  // while the person drags through time the figures follow the playhead: their jumps are the point
  ["fig:", "bub:", "playhead"],
);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await ctx.close();
await browser.close();

// Videos: the whole run, and one short clip (MP4 + GIF) per window.
const raw = readdirSync(vidDir).find((f) => f.endsWith(".webm"));
const suffix = `${dark ? "-dark" : ""}${reduced ? "-reduced" : ""}`;
if (raw) {
  const full = join(vidDir, `full${suffix}.webm`);
  renameSync(join(vidDir, raw), full);
  for (const [name, w] of Object.entries(windows)) {
    const mp4 = join(out, `${name}${suffix}.mp4`);
    const gif = join(out, `${name}${suffix}.gif`);
    const len = String(Math.max(1, w.to - w.from + 0.4));
    const ss = String(Math.max(0, w.from - 0.2));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", ss, "-t", len, "-i", full, "-vf", "crop=1000:620:440:150,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", ss, "-t", len, "-i", full, "-vf", "crop=1000:620:440:150,fps=20,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", gif]);
  }
}
writeFileSync(join(out, `motion${suffix}.json`), JSON.stringify({ url, dark, reduced, at: new Date().toISOString(), windows }, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(windows).map(([k, v]) => [k, { dropped: v.dropped, maxGap: v.maxGap, jank25: v.jank25, snaps: v.snaps, maxSnap: v.maxSnap }]))));
