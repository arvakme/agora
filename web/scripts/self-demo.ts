// The self-architecture demo: Agora drawing Agora, through the same path an agent uses (`agora canvas …`), on a built page.
//
//   node scripts/self-demo.ts <page url> <work dir> hold <seconds>
//   node scripts/self-demo.ts <page url> <work dir> record <build command…>
//
// Both start on a fresh project (`agora up` on an empty .agora/): the page's first run makes a blank canvas and a 新会话; this binds
// that session to Claude Code through the picker (「用 Claude Code 开始」, the person's own click: no turn is started), closes the session
// pane so the canvas has the window, renames the canvas to 「Agora 总架构」 and writes <work dir>/page.json ({sid, top}).
//   hold:   then keeps the page open (it executes the edits) for <seconds>, for building by hand from a shell.
//   record: then runs `<build command> top`, `… top2`, `… children` (scripts/self-demo/build.py draws through the CLI with
//           AGORA_SESSION / TOP set) while Chrome's screencast records every painted frame with its time, then reloads on the
//           overview with only its tab open (a child open in a tab is not zoomed into), zooms into 「服务端」 with Ctrl+wheel
//           (stopping once it has switched and is back near 90%), flies into 「派发」 with its entry mark and goes back out twice
//           with Ctrl+↑. Writes
//           <work dir>/frames/*.jpg and <work dir>/take.json (each frame's time and the marks: when each part began and ended),
//           which scripts/self-demo-cut.ts turns into the video.
// The Chromium is Playwright's, or `CHROMIUM=<path>`.
import { chromium, type CDPSession, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const [url, work, which, ...rest] = args;
if (!url || !work || !which) {
  console.error("usage: node scripts/self-demo.ts <url> <work dir> hold <s> | record <build command…>");
  process.exit(2);
}
const VIEW = { width: 1920, height: 1080 };
mkdirSync(work, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "no-preference" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.log("console error:", m.text().slice(0, 300)));
await page.goto(url);
await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

const api = (path: string) => page.evaluate(async (path) => (await fetch(path)).json(), path);

// the picker's own button binds the session
await page.screenshot({ path: join(work, "boot.png") });
await page.locator("button", { hasText: "用 Claude Code 开始" }).first().click({ timeout: 15_000 });
let sid = "";
for (let i = 0; i < 60 && !sid; i++) {
  await page.waitForTimeout(250);
  const snap = await api("/api/project/snapshot");
  sid = Object.keys(snap.bindings ?? {})[0] ?? "";
}
if (!sid) throw new Error("the session was not bound");
const snap = await api("/api/project/snapshot");
const top = Object.keys(snap.canvases ?? {})[0];
console.log("session", sid, "binding", JSON.stringify(snap.bindings[sid]), "canvas", top);
await page.waitForTimeout(800);
// the session pane closed (a closed tab is not deleted): the canvas gets the window
for (const b of await page.locator("button.wm-tab-close").all()) {
  const label = (await b.getAttribute("aria-label")) ?? "";
  if (!label.includes("agora")) await b.click();
}
await page.waitForTimeout(800);
// the canvas renamed
await page.locator(".wm-tab", { hasText: "agora" }).first().dblclick();
await page.waitForTimeout(300);
await page.keyboard.press("Control+A");
await page.keyboard.type("Agora 总架构");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
writeFileSync(join(work, "page.json"), JSON.stringify({ sid, top }));

if (which === "hold") {
  await page.screenshot({ path: join(work, "hold-start.png") });
  const until = Date.now() + Number(rest[0] ?? 600) * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(5000);
    try {
      await page.screenshot({ path: join(work, "hold-now.png") });
    } catch {
      /* the page is busy */
    }
  }
  await browser.close();
  process.exit(0);
}

type Api = { getSceneElements(): El[]; getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; offsetLeft: number; offsetTop: number; width: number; height: number } };
type El = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; text?: string; boundElements?: { id: string; type: string }[] | null };

const inFront = (p: Page) => p.evaluate(() => new URL(location.href).searchParams.get("canvas"));
/** A node of the canvas in front whose label starts with `label`: where it is on the page and how much of the pane it fills. */
const nodeAt = (p: Page, label: string) =>
  p.evaluate((label) => {
    const w = window as unknown as { __agora: { handles: Map<string, { api: Api }> } };
    const id = new URL(location.href).searchParams.get("canvas") ?? [...w.__agora.handles.keys()][0];
    const api = w.__agora.handles.get(id)!.api;
    const els = api.getSceneElements();
    const text = (e: El) => els.find((t) => t.id === e.boundElements?.find((b) => b.type === "text")?.id)?.text;
    const e = els.find((x) => x.type === "rectangle" && !x.isDeleted && (text(x) ?? "").startsWith(label))!;
    const a = api.getAppState();
    const z = a.zoom.value;
    return { x: a.offsetLeft + (e.x + e.width / 2 + a.scrollX) * z, y: a.offsetTop + (e.y + e.height / 2 + a.scrollY) * z, fill: Math.max((e.width * z) / a.width, (e.height * z) / a.height) };
  }, label);

/** The zoom of the canvas in front. */
const zoomOf = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __agora: { handles: Map<string, { api: Api }> } };
    const id = new URL(location.href).searchParams.get("canvas") ?? [...w.__agora.handles.keys()][0];
    return w.__agora.handles.get(id)?.api.getAppState().zoom.value ?? 0;
  });

/** ⌘/Ctrl+wheel steps, `dy` each, every `ms`: until the canvas in front has changed `switches` times, then `after` more (at most `max`). */
async function zoom(p: Page, dy: number, o: { switches: number; after: number; max?: number; ms?: number; untilZoom?: number }) {
  let seen = 0;
  let last = await inFront(p);
  let more = -1;
  await p.keyboard.down("Control");
  for (let i = 0; i < (o.max ?? 160) && more !== 0; i++) {
    await p.mouse.wheel(0, dy);
    await p.waitForTimeout(o.ms ?? 30);
    const now = await inFront(p);
    if (now !== last) (seen++, (last = now));
    if (o.untilZoom && seen >= o.switches && (await zoomOf(p)) >= o.untilZoom) break;
    if (more > 0) more--;
    else if (more < 0 && seen >= o.switches) more = o.after;
  }
  await p.keyboard.up("Control");
}

// every painted frame, with its time, and the canvas in front on the same clock
const logSwitches = () => page.evaluate(() => {
  const log: { t: number; canvas: string }[] = [];
  (window as unknown as { __switches: typeof log }).__switches = log;
  let last = "";
  const tick = () => {
    const c = new URL(location.href).searchParams.get("canvas") ?? "";
    if (c !== last) log.push({ t: performance.timeOrigin + performance.now(), canvas: (last = c) });
    requestAnimationFrame(tick);
  };
  tick();
});
const switchesSoFar: { t: number; canvas: string }[] = [];
const takeSwitches = async () => switchesSoFar.push(...(await page.evaluate(() => (window as unknown as { __switches: { t: number; canvas: string }[] }).__switches)));
await logSwitches();
const dir = join(work, "frames");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const cdp: CDPSession = await ctx.newCDPSession(page);
const frames: number[] = [];
cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
  const t = (f.metadata.timestamp ?? Date.now() / 1000) * 1000;
  writeFileSync(join(dir, `${String(frames.length).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
  frames.push(t);
  void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
});
const marks: Record<string, number> = {};
const mark = (k: string) => ((marks[k] = Date.now()), console.log("mark", k));
const env = { ...process.env } as Record<string, string>;
env.AGORA_SESSION = sid;
env.TOP = top;
const build = (step: string) => execFileSync(rest[0], [...rest.slice(1), step], { env, stdio: "inherit" });

// the view where the overview will be drawn (its boxes span about x −20…1340, y −60…720 in scene units): centred at 90 %
await page.evaluate(() => {
  const w = window as unknown as { __agora: { handles: Map<string, { api: { getAppState(): { width: number; height: number }; updateScene(x: unknown): void } }> } };
  const api = [...w.__agora.handles.values()][0].api;
  const a = api.getAppState();
  const z = 0.9;
  api.updateScene({ appState: { zoom: { value: z }, scrollX: a.width / 2 / z - 660, scrollY: a.height / 2 / z - 330 } });
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1, maxWidth: VIEW.width, maxHeight: VIEW.height });
await page.waitForTimeout(1500);
mark("draw");
build("top");
await page.waitForTimeout(13_000);
build("top2");
await page.waitForTimeout(3000);
mark("drawn");
await cdp.send("Page.stopScreencast");
build("children");
await page.waitForTimeout(2500);
// back on the overview (the page may have followed the agent into a child canvas): the page reloaded on it — this is a cut in the video
mark("reload");
await takeSwitches();
await page.goto(`${url}?canvas=${top}`);
await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
await page.waitForTimeout(2500);
await logSwitches();
// drawing into the child canvases opened them as tabs: closed again (a closed tab is not deleted), since zooming into a node
// whose child is open in a tab switches to that tab instead (web/docs/nested-canvas.md §2)
for (let i = 0; i < 8; i++) {
  const close = page.locator("button.wm-tab-close").filter({ hasNot: page.locator("xx") });
  let done = true;
  for (const b of await close.all()) {
    const label = (await b.getAttribute("aria-label")) ?? "";
    if (!label.includes("Agora 总架构")) {
      await b.click();
      await page.waitForTimeout(300);
      done = false;
      break;
    }
  }
  if (done) break;
}
// the whole overview in view, nothing selected
await page.evaluate(() => {
  const w = window as unknown as { __agora: { handles: Map<string, { api: { scrollToContent(a?: unknown, o?: unknown): void } }> } };
  w.__agora.handles.get(new URL(location.href).searchParams.get("canvas") ?? "c1")?.api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85 });
});
await page.mouse.click(VIEW.width - 80, VIEW.height - 160);
await page.waitForTimeout(500);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1, maxWidth: VIEW.width, maxHeight: VIEW.height });
await page.waitForTimeout(1200);
mark("zoom");
const s = await nodeAt(page, "本项目 Agora 服务");
await page.mouse.move(s.x, s.y, { steps: 12 });
await page.waitForTimeout(400);
await zoom(page, -10, { switches: 1, after: 40, untilZoom: 0.9 });
console.log("after wheel:", await inFront(page));
await page.waitForTimeout(1800);
mark("fly");
await page.locator('button.nest-mark[aria-label^="进入子图 派发"]').click();
await page.waitForTimeout(3200);
console.log("after mark:", await inFront(page));
mark("up");
await page.mouse.click(VIEW.width - 60, VIEW.height / 2); // nothing selected: Ctrl+↑ is ours
await page.waitForTimeout(300);
await page.keyboard.press("Control+ArrowUp");
await page.waitForTimeout(2200);
console.log("after up 1:", await inFront(page));
await page.keyboard.press("Control+ArrowUp");
await page.waitForTimeout(2500);
console.log("after up 2:", await inFront(page));
mark("end");
await cdp.send("Page.stopScreencast");
await takeSwitches();
const switches = switchesSoFar;
writeFileSync(join(work, "take.json"), JSON.stringify({ frames, marks, switches }, null, 1));
await browser.close();
console.log("frames", frames.length);
