// Side-by-side fidelity captures: the approved 工位视图 prototype and real Agora, at the same
// moments of the same script, in the same viewport and theme (web/docs/workstation.md §8).
//
//   node scripts/fidelity/capture.ts <agora url> <prototype index.html | -> <out dir> [--times 5,14,24] [--themes light,dark]
//
// Agora runs the test project from ./setup.ts with `?mock=runs` (runs/fixtures.ts is the
// prototype's script). Both pages get a Playwright clock: the prototype is frozen at t with
// `#freeze=t`; Agora's clock is paused 1.2 s before t and then run up to t (+0.26 s, one 4 Hz structure pass) (so springs, glides and
// the 4 Hz structure pass settle as they would live). The mock's start is pinned to 15:57:20 local
// time, the prototype's BASE, so the clocks read the same. Agora's view is set to the prototype's
// zoom and position (measured from the prototype's API 服务 box), and both are cropped to the same
// world rectangle around the diagram. Writes <out>/<theme>/{proto,agora}-<t>.png, the timelines,
// and <out>/captures.json.
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODES } from "./setup.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args.splice(i, 2)[1] : d;
};
const times = opt("--times", "5,14,24,30,36,44").split(",").map(Number);
const themes = opt("--themes", "light,dark").split(",");
const [agora, proto, out] = args;
if (!agora || !proto || !out) {
  console.error("usage: node scripts/fidelity/capture.ts <agora url> <prototype index.html> <out dir> [--times …] [--themes …]");
  process.exit(2);
}
// The world rectangle compared (diagram + room for figures and bubbles above the top nodes).
const WORLD = { x: -10, y: -40, w: 900, h: 600 };
const api = NODES.find((n) => n.id === "api")!;

const d = new Date();
d.setHours(15, 57, 20, 0);
const BASE = d.getTime();

const browser = await chromium.launch({ headless: true });
const meta: Record<string, unknown> = { agora, proto, times, at: new Date().toISOString() };

type View = { z: number; rel: { x: number; y: number } };
async function protoShots(theme: string): Promise<Map<number, View>> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme as "light" | "dark" });
  const page = await ctx.newPage();
  const views = new Map<number, View>();
  for (const t of times) {
    await page.goto("about:blank");
    await page.goto(`file://${proto}#freeze=${t}&theme=${theme}&coach=0`);
    await page.waitForTimeout(700);
    const g = await geometry(page, "#canvas", '#diagram [data-node="api"] rect');
    // the prototype re-fits its view as the timeline grows: take it per moment
    const view = { z: g.node.w / api.w, rel: { x: g.node.x - g.canvas.x, y: g.node.y - g.canvas.y } };
    views.set(t, view);
    await shoot(page, g.canvas, view, join(out, theme, `proto-${t}.png`));
    await page.locator("#tl").screenshot({ path: join(out, theme, `proto-tl-${t}.png`) });
    if (t === times[times.length - 1]) await page.screenshot({ path: join(out, theme, `proto-page-${t}.png`) });
  }
  // the expanded timeline at the last moment
  await page.goto("about:blank");
  await page.goto(`file://${proto}#freeze=${times[times.length - 1]}&theme=${theme}&coach=0&full=1`);
  await page.waitForTimeout(700);
  await page.locator("#tl").screenshot({ path: join(out, theme, `proto-tlfull.png`) });
  await ctx.close();
  return views;
}

async function geometry(page: Page, canvasSel: string, nodeSel: string) {
  return page.evaluate(
    ([c, n]) => {
      const r = (el: Element | null) => {
        const b = el!.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      return { canvas: r(document.querySelector(c)), node: r(document.querySelector(n)) };
    },
    [canvasSel, nodeSel] as const,
  );
}

/** Crop the world rectangle out of a canvas whose view puts world (x, y) at canvas + rel + (x - api.x) · z. */
async function shoot(page: Page, canvas: { x: number; y: number; w: number; h: number }, v: View, path: string) {
  const sx = (x: number) => canvas.x + v.rel.x + (x - api.x) * v.z;
  const sy = (y: number) => canvas.y + v.rel.y + (y - api.y) * v.z;
  const x0 = Math.max(canvas.x, sx(WORLD.x));
  const y0 = Math.max(canvas.y, sy(WORLD.y));
  const x1 = Math.min(canvas.x + canvas.w, sx(WORLD.x + WORLD.w));
  const y1 = Math.min(canvas.y + canvas.h, sy(WORLD.y + WORLD.h));
  await page.screenshot({ path, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
}

async function agoraShots(theme: string, views: Map<number, View>) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme as "light" | "dark" });
  const page = await ctx.newPage();
  await page.clock.install({ time: BASE - 20_000 });
  await page.addInitScript((th) => {
    try {
      localStorage.setItem("agora.theme", th);
      localStorage.setItem("agora.workstation.v2", "on");
    } catch {}
  }, theme);
  await page.goto(`${agora.replace(/\/$/, "")}/?mock=runs&canvas=c1&mockBase=${BASE}`);
  await page.waitForFunction(() => (window as unknown as { __agora?: { api?: unknown } }).__agora?.api, undefined, { timeout: 60_000 });
  await page.waitForSelector(".canvas-view");
  await page.waitForTimeout(1500);
  // the prototype's zoom and position (relative to the canvas element) at each moment
  const setView = (v: View) =>
    page.evaluate(
      ({ z, rel, ax, ay }) => {
        const a = (window as unknown as { __agora: { api: { updateScene: (s: unknown) => void } } }).__agora.api;
        a.updateScene({ appState: { zoom: { value: z }, scrollX: rel.x / z - ax, scrollY: rel.y / z - ay } });
      },
      { z: v.z, rel: v.rel, ax: api.x, ay: api.y },
    );
  const tlShots: string[] = [];
  for (const t of times) {
    const v = views.get(t);
    if (v) await setView(v);
    else if (t === times[0])
      await page.evaluate(() => (window as unknown as { __agora: { api: { scrollToContent: (e?: unknown, o?: unknown) => void } } }).__agora.api.scrollToContent(undefined, { fitToContent: true, animate: false }));
    await page.clock.pauseAt(BASE + t * 1000 - 1200);
    await page.clock.runFor(700);
    await page.waitForTimeout(250);
    await page.clock.runFor(500);
    await page.waitForTimeout(250);
    // the structure is rebuilt at 4 Hz: one more pass so the words are from t, not up to 250 ms before
    await page.clock.runFor(260);
    await page.waitForTimeout(200);
    const cv = await page.evaluate(() => {
      const b = document.querySelector('[data-pane]:not([data-hidden="true"]) .canvas-view')!.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    if (v) await shoot(page, cv, v, join(out, theme, `agora-${t}.png`));
    else await page.screenshot({ path: join(out, theme, `agora-${t}.png`), clip: { x: cv.x, y: cv.y, width: cv.w, height: cv.h } });
    const tl = page.locator(".ws-tl").first();
    if (await tl.count()) {
      await tl.screenshot({ path: join(out, theme, `agora-tl-${t}.png`) });
      tlShots.push(`agora-tl-${t}.png`);
    }
    if (t === times[times.length - 1]) await page.screenshot({ path: join(out, theme, `agora-page-${t}.png`) });
    // what each bubble is doing (for the notes next to the sheet)
    meta[`bubbles-${theme}-${t}`] = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-pane]:not([data-hidden="true"]) .ws-bub-pos')].map((w) => {
        const b = w.firstElementChild as HTMLElement;
        return { who: b.querySelector(".who")?.textContent, folded: w.hasAttribute("data-folded"), chip: b.hasAttribute("data-chip"), tail: b.dataset.tail ?? null, opacity: getComputedStyle(w).opacity, vis: w.style.visibility, transform: w.style.transform };
      }),
    );
  }
  // the expanded lanes at the last moment
  // the expand button (or, on builds before the port, the strip's title)
  const expand = page.locator('.ws-tl .tl-head .ibtn[aria-label="展开成全宽"], .ws-tl .ttl').first();
  if (await expand.count()) {
    await expand.click();
    await page.clock.runFor(600);
    await page.waitForTimeout(300);
    await page.locator(".ws-tl").first().screenshot({ path: join(out, theme, `agora-tlfull.png`) });
  }
  await ctx.close();
}

for (const theme of themes) {
  mkdirSync(join(out, theme), { recursive: true });
  // `-` for the prototype: Agora alone, its canvas fitted (e.g. the user's own diagram)
  const v = proto === "-" ? new Map<number, View>() : await protoShots(theme);
  meta[`view-${theme}`] = Object.fromEntries(v);
  await agoraShots(theme, v);
  console.log(theme, "done");
}
writeFileSync(join(out, "captures.json"), JSON.stringify(meta, null, 2));
await browser.close();
