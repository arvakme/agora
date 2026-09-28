// A time-lapse clip of the 工位视图 (web/docs/workstation.md「新想法」): replay a stretch of the
// timeline at a speed — idle stretches skipped, exactly as the timeline's own replay skips them — and
// save the canvas pane as MP4 or GIF.
//
//   node scripts/clip.ts <url> <out.mp4|out.gif> [--from <t>] [--to <t>] [--speed 8] [--dark]
//
// <t>: seconds after the first activity on the page (12.5), a wall-clock time on that day (15:04,
// 15:04:30) or an ISO time. Defaults: from the first activity to now. A --to still ahead is waited for
// (?mock=runs plays its ~46 s script live from page load). Playwright's Chromium at 1440×900 records
// the page; ffmpeg cuts the replay out and crops it to the canvas. Needs the dev server: it drives the
// page's own clock module (clock.ts), which a built bundle does not expose. The page does not
// hot-reload while it records (Vite's HMR socket is held open, silent): an edit elsewhere would
// reload it and lose the replay. It never writes to the project: every /api request but a GET is
// refused (the page's own workspace autosave included).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [url, out] = argv.filter((a, i) => !a.startsWith("--") && !["--from", "--to", "--speed"].includes(argv[i - 1]));
const speed = Number(opt("--speed") ?? 8);
const dark = argv.includes("--dark");
if (!url || !out || !/\.(mp4|gif)$/i.test(out) || !(speed > 0)) {
  console.error("usage: node scripts/clip.ts <url> <out.mp4|out.gif> [--from <t>] [--to <t>] [--speed 8] [--dark]");
  process.exit(2);
}

/** A time on the command line, given the first activity. */
function when(s: string | undefined, first: number): number | undefined {
  if (s == null) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return first + Number(s) * 1000;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(first).setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`not a time: ${s}`);
  return t;
}

const VIEW = { width: 1440, height: 900 };
const PANE = '[data-pane]:not([data-hidden="true"])';
const tmp = mkdtempSync(join(tmpdir(), "agora-clip-"));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: dark ? "dark" : "light", recordVideo: { dir: tmp, size: VIEW } });
  // every module the dev server sends is a resource entry: keep them all, to reach the app's own instances
  await ctx.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  await ctx.routeWebSocket((u) => u.searchParams.has("token"), () => {});
  await ctx.route("**/api/**", (r) => (r.request().method() === "GET" ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const born = Date.now(); // the recording starts with the page
  await page.goto(url);
  const slider = page.locator(`${PANE} .ws-tl [role="slider"]`).first();
  await slider.waitFor({ timeout: 30_000 });
  const first = await page.evaluate(async () => {
    // the app's instance of a module: the URL it was loaded from (?t= and all)
    const mod = (p: string) => import(performance.getEntriesByType("resource").map((e) => e.name).filter((n) => new URL(n).pathname === p).pop() ?? p);
    const { runs } = await mod("/src/workstation/runs/store.ts");
    const ts: number[] = runs.get().flat.flatMap((f: { run: { segs: { start: number }[]; spawnAt?: number } }) => [f.run.segs[0]?.start, f.run.spawnAt]).filter((x: number | undefined) => x != null);
    return ts.length ? Math.min(...ts) : null;
  });
  if (first == null) throw new Error("nothing on this page's timeline to replay");
  const from = when(opt("--from"), first) ?? first;
  const to = when(opt("--to"), first) ?? Date.now();
  if (!(to > from)) throw new Error(`--to must come after --from (${new Date(from).toISOString()} → ${new Date(to).toISOString()})`);
  if (to > Date.now()) await page.waitForTimeout(to - Date.now() + 300);
  // Space on the strip starts the timeline's own replay (its idle gaps); the clock then plays the
  // chosen stretch at the chosen speed, keeping those gaps
  await slider.focus();
  await page.keyboard.press(" ");
  await page.evaluate(
    async ({ from, to, speed }) => {
      const mod = (p: string) => import(performance.getEntriesByType("resource").map((e) => e.name).filter((n) => new URL(n).pathname === p).pop() ?? p);
      const { clock } = await mod("/src/workstation/clock.ts");
      clock.play(from, to, speed, clock.get()?.gaps);
      Object.assign(window, { __clipClock: clock });
    },
    { from, to, speed },
  );
  const t0 = (Date.now() - born) / 1000 + 0.3;
  // playing into its end, the overlay goes back to live
  await page.waitForFunction(
    (end) => {
      const c = (window as unknown as { __clipClock: { get(): unknown; time(): number } }).__clipClock;
      return !c.get() || c.time() >= end - 1;
    },
    to,
    { polling: 50, timeout: (to - from) / speed + 60_000 },
  );
  const t1 = (Date.now() - born) / 1000;
  const b = await page.locator(`${PANE} .canvas-layers`).first().boundingBox();
  if (!b) throw new Error("no canvas on the page");
  const video = await page.video()!.path();
  await ctx.close(); // writes the recording out
  const even = (n: number) => Math.floor(n / 2) * 2;
  const crop = `crop=${even(b.width)}:${even(b.height)}:${Math.round(b.x)}:${Math.round(b.y)}`;
  const cut = ["-y", "-loglevel", "error", "-ss", t0.toFixed(2), "-t", (t1 - t0).toFixed(2), "-i", video];
  if (/\.gif$/i.test(out)) execFileSync("ffmpeg", [...cut, "-vf", `${crop},fps=15,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`, out]);
  else execFileSync("ffmpeg", [...cut, "-vf", `${crop},fps=30`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  console.log(JSON.stringify({ out, from: new Date(from).toISOString(), to: new Date(to).toISOString(), speed, dark, seconds: +(t1 - t0).toFixed(1), crop }));
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
