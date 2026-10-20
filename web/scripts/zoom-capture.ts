// Evidence for zooming into sub-diagrams and back out (web/docs/nested-canvas.md §2 缩放进出).
//
//   node scripts/zoom-capture.ts <page url> <out dir> <setup|wheel|settle|fly> [--dark] [--reduced]
//
// setup (needs the vite dev server, `agora up --dev`, on an empty project): builds a tree on the first canvas — 总架构 › 后端 API ›
// 订单服务 — with the page's own modules (applyPlan, the shell's createChild, writeChildLink); it is saved with the project. The other
// scenarios work on the dev server or a built one (`agora up` after `npm run build`: the built page is the one to judge motion by),
// through the page and `window.__agora.handles` only. Each records the page with Chrome's screencast (every frame it paints, with
// its time) and writes <out>/<scenario>.mp4 plus <out>/<scenario>/frames/*.jpg and <out>/<scenario>/switches.json (when the canvas
// in front changed, on the same clock as the frames).
//   wheel:  ⌘/Ctrl+wheel over 「后端 API」 into it, on into 「订单服务」, then all the way back out to the top.
//   settle: zoom in over 「后端 API」 until it all but fills the pane and stop: the switch comes by itself, with nothing moving.
//   fly:    the entry mark into 「后端 API」, ⇧↵ into 「订单服务」, Ctrl+↑ out one level, the mark in again, the breadcrumb to the top.
// The Chromium is Playwright's, or `CHROMIUM=<path>`.
import { chromium, type CDPSession, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const [url, out, which] = args;
if (!url || !out || !which) {
  console.error("usage: node scripts/zoom-capture.ts <url> <out dir> <setup|wheel|settle|fly> [--dark] [--reduced]");
  process.exit(2);
}
const dark = args.includes("--dark");
const reduced = args.includes("--reduced");
const VIEW = { width: 1280, height: 800 };

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: dark ? "dark" : "light", reducedMotion: reduced ? "reduce" : "no-preference" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.log("console error:", m.text().slice(0, 300)));
await page.goto(url);
await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

type Api = { getSceneElements(): El[]; getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; offsetLeft: number; offsetTop: number; width: number; height: number }; scrollToContent(a?: unknown, o?: unknown): void };
type El = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; text?: string; boundElements?: { id: string; type: string }[] | null };

if (which === "setup") {
  const ids = await page.evaluate(async () => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { applyPlan } = await imp("/src/ops/apply.ts");
    const { nav } = await imp("/src/nested/store.ts");
    const { writeChildLink } = await imp("/src/nested/writeChild.ts");
    const { canvases } = await imp("/src/session/ui.ts");
    const { labelOf, byId } = await imp("/src/canvas/scene.ts");
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    document.querySelector<HTMLButtonElement>('button.wm-tab-close[aria-label^="关闭 新会话"]')?.click();
    const w = window as unknown as { __agora: { handles: Map<string, unknown> } };
    const top = [...w.__agora.handles.keys()][0];
    const apiOf = async (id: string) => {
      for (let i = 0; i < 100 && !canvases.get(id); i++) await wait(50);
      return canvases.get(id).api;
    };
    const shape = (ref: string, text: string, x: number, y: number, width = 200, height = 80) => ({ op: "add_shape", ref, shape: "rectangle", text, x, y, width, height });
    const draw = async (id: string, ops: unknown[]) => {
      const api = await apiOf(id);
      api.updateScene({ elements: applyPlan(api.getSceneElements(), { ops }).scene });
      await wait(300);
      api.scrollToContent(undefined, { fitToContent: true });
      return api;
    };
    const nodeId = (api: { getSceneElements(): { id: string; type: string }[] }, label: string) => {
      const els = api.getSceneElements();
      return els.find((e) => e.type === "rectangle" && labelOf(e, byId(els)) === label)!.id;
    };
    const topApi = await draw(top, [
      shape("web", "Web 前端", 0, 0), shape("app", "移动端", 300, 0), shape("gw", "API 网关", 150, 170),
      shape("api", "后端 API", 150, 340, 220, 110), shape("auth", "认证服务", -150, 340), shape("pay", "支付网关", 470, 340),
      shape("pg", "Postgres", 0, 540), shape("mq", "消息队列", 300, 540),
      { op: "add_arrow", from: "web", to: "gw" }, { op: "add_arrow", from: "app", to: "gw" }, { op: "add_arrow", from: "gw", to: "api" },
      { op: "add_arrow", from: "api", to: "auth" }, { op: "add_arrow", from: "api", to: "pay" }, { op: "add_arrow", from: "api", to: "pg" }, { op: "add_arrow", from: "api", to: "mq" },
    ]);
    const backend = await nav.createChild("后端 API");
    writeChildLink(topApi, nodeId(topApi, "后端 API"), backend);
    await wait(300);
    nav.go(top, backend);
    const bApi = await draw(backend, [
      shape("router", "路由 /api", 120, 0), shape("orders", "订单服务", 0, 160), shape("users", "用户服务", 260, 160),
      shape("cart", "购物车", 520, 160), shape("repo", "订单存储", 0, 330), shape("cache", "会话缓存", 260, 330),
      { op: "add_arrow", from: "router", to: "orders" }, { op: "add_arrow", from: "router", to: "users" }, { op: "add_arrow", from: "router", to: "cart" },
      { op: "add_arrow", from: "orders", to: "repo" }, { op: "add_arrow", from: "users", to: "cache" },
    ]);
    const orders = await nav.createChild("订单服务");
    writeChildLink(bApi, nodeId(bApi, "订单服务"), orders);
    await wait(300);
    nav.go(backend, orders);
    await draw(orders, [
      shape("place", "place(order)", 0, 0, 220, 70), shape("check", "校验库存", -160, 150), shape("price", "计算价格", 140, 150),
      shape("save", "写入订单表", -10, 300, 220, 70), shape("emit", "发 OrderPlaced", -10, 440, 220, 70),
      { op: "add_arrow", from: "place", to: "check" }, { op: "add_arrow", from: "place", to: "price" },
      { op: "add_arrow", from: "check", to: "save" }, { op: "add_arrow", from: "price", to: "save" }, { op: "add_arrow", from: "save", to: "emit" },
    ]);
    await wait(400);
    nav.go(orders, backend);
    await wait(400);
    nav.go(backend, top);
    await wait(1500); // saved
    return { top, backend, orders };
  });
  console.log("tree", ids);
  await browser.close();
  process.exit(0);
}

// the canvas in front, every frame, on the page's clock
await page.evaluate(() => {
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

/** The page's screencast: every painted frame, with its time. */
async function record(name: string, body: () => Promise<void>) {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  const cdp: CDPSession = await ctx.newCDPSession(page);
  const frames: { t: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ t: f.metadata.timestamp ?? Date.now() / 1000, data: f.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  });
  await page.evaluate(() => ((window as unknown as { __switches: unknown[] }).__switches.length = 0));
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  await body();
  await page.waitForTimeout(600);
  await cdp.send("Page.stopScreencast");
  const switches = await page.evaluate(() => (window as unknown as { __switches: { t: number; canvas: string }[] }).__switches);
  const list: string[] = [];
  frames.forEach((f, i) => {
    const file = `${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, "frames", file), Buffer.from(f.data, "base64"));
    const next = frames[i + 1]?.t ?? f.t + 0.04;
    list.push(`file 'frames/${file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  list.push(`file 'frames/${String(frames.length - 1).padStart(5, "0")}.jpg'`);
  writeFileSync(join(dir, "list.txt"), list.join("\n"));
  writeFileSync(join(dir, "switches.json"), JSON.stringify({ frames: frames.map((f) => f.t * 1000), switches }, null, 1));
  execFileSync("/usr/bin/ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", join(out, `${name}.mp4`)]);
  console.log(name, frames.length, "frames,", switches.length, "switches", JSON.stringify(switches.map((s) => s.canvas)));
}

const inFront = (p: Page) => p.evaluate(() => new URL(location.href).searchParams.get("canvas"));
/** A node of the canvas in front, by its label: where it is on the page and how much of the pane it fills. */
const nodeAt = (p: Page, label: string) =>
  p.evaluate((label) => {
    const w = window as unknown as { __agora: { handles: Map<string, { api: Api }> } };
    const id = new URL(location.href).searchParams.get("canvas")!;
    const api = w.__agora.handles.get(id)!.api;
    const els = api.getSceneElements();
    const text = (e: El) => els.find((t) => t.id === e.boundElements?.find((b) => b.type === "text")?.id)?.text;
    const e = els.find((x) => x.type === "rectangle" && !x.isDeleted && text(x) === label)!;
    const a = api.getAppState();
    const z = a.zoom.value;
    return { x: a.offsetLeft + (e.x + e.width / 2 + a.scrollX) * z, y: a.offsetTop + (e.y + e.height / 2 + a.scrollY) * z, fill: Math.max((e.width * z) / a.width, (e.height * z) / a.height) };
  }, label);

/** ⌘/Ctrl+wheel steps (a pinch), `dy` each, every `ms`: until the canvas in front has changed `switches` times, then `after` more (at most `max`). */
async function zoom(p: Page, dy: number, o: { switches: number; after: number; max?: number; ms?: number }) {
  let seen = 0;
  let last = await inFront(p);
  let more = -1;
  await p.keyboard.down("Control");
  for (let i = 0; i < (o.max ?? 120) && more !== 0; i++) {
    await p.mouse.wheel(0, dy);
    await p.waitForTimeout(o.ms ?? 30);
    const now = await inFront(p);
    if (now !== last) (seen++, (last = now));
    if (more > 0) more--;
    else if (more < 0 && seen >= o.switches) more = o.after;
  }
  await p.keyboard.up("Control");
}

if (which === "wheel") {
  await record("wheel", async () => {
    const c = await nodeAt(page, "后端 API");
    await page.mouse.move(c.x, c.y);
    // in, and on a little inside the sub-diagram
    await zoom(page, -12, { switches: 1, after: 6 });
    console.log("after zoom in:", await inFront(page));
    await page.waitForTimeout(700);
    const d = await nodeAt(page, "订单服务");
    await page.mouse.move(d.x, d.y, { steps: 10 });
    await zoom(page, -12, { switches: 1, after: 10 });
    console.log("after zoom in 2:", await inFront(page));
    await page.waitForTimeout(900);
    // all the way out: two levels, and on in the top canvas
    await zoom(page, 12, { switches: 2, after: 10, max: 200, ms: 40 });
    console.log("after zoom out:", await inFront(page));
  });
}

if (which === "settle") {
  await record("settle", async () => {
    const c = await nodeAt(page, "后端 API");
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Control");
    for (let i = 0; i < 200 && (await nodeAt(page, "后端 API")).fill < 0.66; i++) {
      await page.mouse.wheel(0, -4);
      await page.waitForTimeout(40);
    }
    await page.keyboard.up("Control");
    await page.waitForTimeout(1200);
    console.log("settled into:", await inFront(page));
  });
}

if (which === "fly") {
  await record("fly", async () => {
    await page.locator('button.nest-mark[aria-label="进入子图 后端 API"]').click();
    await page.waitForTimeout(1500);
    console.log("mark:", await inFront(page));
    // ⇧↵ on the selected 「订单服务」
    const d = await nodeAt(page, "订单服务");
    await page.mouse.click(d.x, d.y);
    await page.waitForTimeout(400);
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(1500);
    console.log("shift-enter:", await inFront(page));
    await page.mouse.click(VIEW.width - 60, VIEW.height / 2); // nothing selected: Ctrl+↑ is ours
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(1500);
    console.log("ctrl-up:", await inFront(page));
    await page.locator('button.nest-mark[aria-label="进入子图 订单服务"]').click();
    await page.waitForTimeout(1500);
    console.log("mark 2:", await inFront(page));
    await page.locator(".nest-crumbs ol button").first().click();
    await page.waitForTimeout(2000);
    console.log("crumb:", await inFront(page));
  });
}
await browser.close();
