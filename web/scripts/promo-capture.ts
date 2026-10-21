// 宣传片（docs/promo/）用的实录：逐帧步进，真 60 fps，画面里只有画布。
//
//   node scripts/promo-capture.ts <dev page url> <out dir> <setup|zoom|hop> [--lang zh|en] [--fps 60]
//
// 页面装上 Playwright 的假时钟（Date、setTimeout、requestAnimationFrame、performance.now 都归它管）并停住；之后每一帧：
// 先按这一帧的时刻摆好镜头，时钟走 1/fps 秒，再截一张图。录下来的每一帧都是页面在那个时刻真正画出来的样子，
// 不靠录屏的帧率，也不需要再放慢。界面外壳（顶栏、标签、Excalidraw 的工具条和页脚（缩放比例、撤销重做）、面包屑、子图入口按钮、底部 dock）
// 只是藏起来（visibility），版面不变，镜头的换算照旧；截图只裁画布里的 1440×900。
// --lang en：标签用英文，页面也带 ?lang=en 打开（界面的英文版），录出来的整帧都是英文。
//   setup: 在空项目的第一张画布上搭两层子图（总架构 › 后端 API › 订单服务；--lang en 用英文标签），和 zoom-capture.ts 的 setup
//          同一棵树、同一个版面，只是文字按语言换。
//   zoom:  两轮语义缩放：从总架构一路放大进「后端 API」，子图接过画面后不停，接着放大进「订单服务」，最后停在第三层的图上。
//          镜头是页面自己的数学（web/src/nested/zoom.ts）：每帧绕焦点节点的中心按对数速度放大，同时把节点往画面中心带。
//          其余全走人用 ⌘/Ctrl+滚轮放大时的那条路：每一层开头在节点上滚一格（ZoomLayer 认出这扇门，备好子图的缩略图），
//          之后每帧报一次「还在放大」（zoomNav.noteZoomGesture），缩略图浮现、其余部分被遮住、占满到 ENTER_FILL 时换进子图，
//          都是 ZoomLayer 自己按 fill 做的；换过去之后镜头接着用子图那一份继续放大。
//   hop:   ?mock=runs 的脚本场景（runs/fixtures.ts：Claude Code 和 Pi 在节点间走、跳、过桥、爬梯子、进 API 服务的子图），
//          页面是 scripts/fidelity/setup.ts 搭的那个项目（--lang en 时用英文标签搭）。不跑任何 agent。从场景的 --from 秒开始录
//          --seconds 秒（--enter <s>：那一秒换进 API 服务的子图）；小人、气泡、徽标留着，界面外壳照样藏起来；每张画布第一次出现时取一次景（整张图居中，宽不过 78%）。
// 输出 <out>/<scenario>.<lang>.mp4（H.264，yuv420p，fps 帧每秒）和 <out>/<scenario>.<lang>/ 里的逐帧 JPEG。
// Chromium 用 Playwright 自带的，或 `CHROMIUM=<path>`。
import { chromium, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [url, out, which] = args;
if (!url || !out || !which) {
  console.error("usage: node scripts/promo-capture.ts <url> <out dir> <setup|zoom|hop> [--lang zh|en] [--fps 60]");
  process.exit(2);
}
const lang = opt("--lang", "zh") === "en" ? "en" : "zh";
const fps = Number(opt("--fps", "60"));
// 视口比 1440×900 高：顶栏 54 + 标签 36 + 子图的面包屑 45 都在裁切框上面
const VIEW = { width: 1440, height: 1080 };
const CROP = { x: 0, y: 150, width: 1440, height: 900 };

/** 两种语言的标签：键是节点的 ref，同一个版面。 */
const L = {
  zh: {
    top: ["Web 前端", "移动端", "API 网关", "后端 API", "认证服务", "支付网关", "Postgres", "消息队列"],
    mid: ["路由 /api", "订单服务", "用户服务", "购物车", "订单存储", "会话缓存"],
    low: ["place(order)", "校验库存", "计算价格", "写入订单表", "发 OrderPlaced"],
  },
  en: {
    top: ["Web app", "Mobile", "API gateway", "Backend API", "Auth", "Payments", "Postgres", "Queue"],
    mid: ["Router /api", "Orders", "Users", "Cart", "Order store", "Session cache"],
    low: ["place(order)", "Check stock", "Price", "Write order", "Emit OrderPlaced"],
  },
}[lang];

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: "light" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => (m.type() === "error" && !m.text().includes("404") ? console.log("console error:", m.text().slice(0, 300)) : m.text().startsWith("[cap]") && console.log(m.text())));
if (which !== "setup") await page.clock.install();
const u = new URL(url);
if (lang === "en") u.searchParams.set("lang", "en");
if (which === "hop") for (const [k, v] of [["mock", "runs"], ["canvas", "c1"]]) u.searchParams.set(k, v);
await page.goto(u.href);
await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

if (which === "setup") {
  const ids = await page.evaluate(async (L) => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { applyPlan } = await imp("/src/ops/apply.ts");
    const { nav } = await imp("/src/nested/store.ts");
    const { writeChildLink } = await imp("/src/nested/writeChild.ts");
    const { canvases } = await imp("/src/session/ui.ts");
    const { labelOf, byId } = await imp("/src/canvas/scene.ts");
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // 新项目旁边开着的会话窗格关掉：按种类找，不按（会翻译的）名字
    document.querySelector<HTMLButtonElement>('.wm-tab[data-kind="session"] button.wm-tab-close')?.click();
    const w = window as unknown as { __agora: { handles: Map<string, unknown> } };
    const top = [...w.__agora.handles.keys()][0];
    const apiOf = async (id: string) => {
      for (let i = 0; i < 100 && !canvases.get(id); i++) await wait(50);
      return canvases.get(id).api;
    };
    const shape = (ref: string, text: string, x: number, y: number, width = 200, height = 80) => ({ op: "add_shape", ref, shape: "rectangle", text, x, y, width, height });
    const arrow = (from: string, to: string) => ({ op: "add_arrow", from, to });
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
    const [web, app, gw, api, auth, pay, pg, mq] = L.top;
    const topApi = await draw(top, [
      shape("web", web, 0, 0), shape("app", app, 300, 0), shape("gw", gw, 150, 170),
      shape("api", api, 150, 340, 220, 110), shape("auth", auth, -150, 340), shape("pay", pay, 470, 340),
      shape("pg", pg, 0, 540), shape("mq", mq, 300, 540),
      arrow("web", "gw"), arrow("app", "gw"), arrow("gw", "api"), arrow("api", "auth"), arrow("api", "pay"), arrow("api", "pg"), arrow("api", "mq"),
    ]);
    const backend = await nav.createChild(api);
    writeChildLink(topApi, nodeId(topApi, api), backend);
    await wait(300);
    nav.go(top, backend);
    const [router, orders, users, cart, repo, cache] = L.mid;
    const bApi = await draw(backend, [
      shape("router", router, 120, 0), shape("orders", orders, 0, 160), shape("users", users, 260, 160),
      shape("cart", cart, 520, 160), shape("repo", repo, 0, 330), shape("cache", cache, 260, 330),
      arrow("router", "orders"), arrow("router", "users"), arrow("router", "cart"), arrow("orders", "repo"), arrow("users", "cache"),
    ]);
    const ordersId = await nav.createChild(orders);
    writeChildLink(bApi, nodeId(bApi, orders), ordersId);
    await wait(300);
    nav.go(backend, ordersId);
    const [place, check, price, save, emit] = L.low;
    await draw(ordersId, [
      shape("place", place, 0, 0, 220, 70), shape("check", check, -160, 150), shape("price", price, 140, 150),
      shape("save", save, -10, 300, 220, 70), shape("emit", emit, -10, 440, 220, 70),
      arrow("place", "check"), arrow("place", "price"), arrow("check", "save"), arrow("price", "save"), arrow("save", "emit"),
    ]);
    await wait(400);
    nav.go(ordersId, backend);
    await wait(400);
    nav.go(backend, top);
    await wait(1500); // 存盘
    return { top, backend, orders: ordersId };
  }, L);
  console.log("tree", ids);
  await browser.close();
  process.exit(0);
}

/** 藏起界面外壳，只留画布（和画布上的缩放层：缩略图、遮罩）。 */
const HIDE = [".topbar", ".wm-tab", ".wm-add", ".layer-ui__wrapper", ".layer-ui__wrapper__footer", ".whole-btn", ".nest-mark", ".dock", ".nest-crumbs", ".nest-back", ".di-trigger"];
/** hop 要看见子图入口的标记（小人从那里进出），只藏外壳 */
const HIDE_HOP = [".topbar", ".wm-tab", ".wm-add", ".layer-ui__wrapper", ".layer-ui__wrapper__footer", ".whole-btn", ".dock", ".nest-crumbs", ".nest-back", ".ws-tl", ".ws-off"];
async function cleanFrame(p: Page, hide = HIDE) {
  await p.addStyleTag({
    // 连子元素一起藏：Excalidraw 的页脚按钮自己写了 visibility: visible，只藏外层会漏出来
    content: `${hide.flatMap((c) => [c, `${c} *`]).join(", ")} { visibility: hidden !important; }
      * { caret-color: transparent !important; }`,
  });
}

/** 逐帧：`step(t)` 摆好这一帧，时钟走一帧，截图。 */
async function record(name: string, seconds: number, step: (t: number, i: number) => Promise<void>) {
  const dir = join(out, `${name}.${lang}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round(seconds * fps);
  let ms = 0;
  for (let i = 0; i < n; i++) {
    await step(i / fps, i);
    const next = Math.round(((i + 1) * 1000) / fps);
    await page.clock.runFor(next - ms);
    ms = next;
    await page.screenshot({ path: join(dir, `${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92, clip: CROP });
  }
  const mp4 = join(out, `${name}.${lang}.mp4`);
  execFileSync("/usr/bin/ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "%05d.jpg"), "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p", mp4]);
  console.log(`wrote ${mp4}: ${n} frames at ${fps} fps`);
}

if (which === "zoom") {
  await cleanFrame(page);
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4); // 指针放到角上，不在任何节点上
  await page.clock.pauseAt(Date.now() + 1000);
  await page.clock.runFor(500);
  // 页面里的驱动：每帧调一次 __drive(t)
  await page.evaluate((r) => ((window as unknown as { __rate: number }).__rate = r), Number(opt("--rate", "1.3")));
  await page.evaluate(async (L) => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { canvases } = await imp("/src/session/ui.ts");
    const { nested } = await imp("/src/nested/store.ts");
    const { simOf, camOf } = await imp("/src/nested/zoom.ts");
    const { arrivalOf, noteZoomGesture, contentOf } = await imp("/src/nested/zoomNav.ts");
    const { labelOf, byId } = await imp("/src/canvas/scene.ts");
    const front = () => new URL(location.href).searchParams.get("canvas") || [...canvases.keys()][0];
    type Api = { getSceneElements(): { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean }[]; getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; offsetLeft: number; offsetTop: number; width: number; height: number }; updateScene(x: unknown): void };
    const apiOf = (id: string): Api | undefined => canvases.get(id)?.api;
    // 焦点节点：第一层「后端 API」，第二层「订单服务」，第三层没有（整张图）
    const focusLabel = [L.top[3], L.mid[1], null];
    let level = 0;
    let canvas = front();
    // 镜头（页面坐标的相似变换）：自己记着，每帧写给当前画布；换画布时换成子图的那一份
    const api0 = apiOf(canvas)!;
    const a0 = api0.getAppState();
    let sim = simOf({ scrollX: a0.scrollX, scrollY: a0.scrollY, zoom: a0.zoom.value }, { x: a0.offsetLeft, y: a0.offsetTop });
    // 对数缩放速度（每秒 ln k）：起步 0.5 s 加速，之后匀速；进到第三层后不再按速度走，而是指数地落到第三层整张图的取景上，
    // 时间常数取得让落地的起始速度正好等于匀速（速度连续，只是慢慢刹住）
    const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const RATE = Number((window as unknown as { __rate?: number }).__rate ?? 1.3);
    const rate = (t: number) => RATE * smooth(0.1, 0.6, t);
    let land: { sim: { k: number; x: number; y: number }; tau: number } | null = null;
    let last = 0;
    (window as unknown as { __drive: (t: number) => boolean }).__drive = (t: number) => {
      const dt = t - last;
      last = t;
      // ZoomLayer 在上一帧里换进了子图：镜头换成子图那一份（它出现在缩略图的位置上），焦点换到下一层的节点
      let switched = false;
      const now = front();
      if (now !== canvas) {
        const arr = arrivalOf(now);
        const a = apiOf(now);
        const st0 = a?.getAppState();
        sim = arr ? arr.sim : st0 ? simOf({ scrollX: st0.scrollX, scrollY: st0.scrollY, zoom: st0.zoom.value }, { x: st0.offsetLeft, y: st0.offsetTop }) : sim;
        console.log(`[cap] t=${t.toFixed(3)} switched ${canvas} → ${now} (k ${sim.k.toFixed(3)})`);
        canvas = now;
        level++;
        switched = true;
        if (level === 2) {
          // 第三层的取景：整张图居中在裁切框里，宽不过 62%、高不过 66%
          const c = contentOf(canvas)!.box;
          const k = Math.min((1440 * 0.62) / c.w, (900 * 0.66) / c.h);
          const to = { k, x: 720 - (c.x + c.w / 2) * k, y: 600 - (c.y + c.h / 2) * k };
          land = { sim: to, tau: Math.max(0.25, Math.log(to.k / sim.k) / RATE) };
          console.log(`[cap] landing k ${sim.k.toFixed(3)} → ${to.k.toFixed(3)}, tau ${land.tau.toFixed(2)} s`);
        }
      }
      if (land) {
        const u = 1 - Math.exp(-dt / land.tau);
        const k = Math.exp(Math.log(sim.k) + (Math.log(land.sim.k) - Math.log(sim.k)) * u);
        // 平移跟着缩放走：取两份镜头的不动点做缩放（和 zoom.ts flyAt 一样），不会先平移再缩放
        const r = land.sim.k / sim.k;
        if (Math.abs(Math.log(r)) > 1e-4) {
          const fx = (sim.x - land.sim.x) / (land.sim.k - sim.k), fy = (sim.y - land.sim.y) / (land.sim.k - sim.k);
          const cx = fx * sim.k + sim.x, cy = fy * sim.k + sim.y;
          sim = { k, x: cx - fx * k, y: cy - fy * k };
        } else sim = { k, x: sim.x + (land.sim.x - sim.x) * u, y: sim.y + (land.sim.y - sim.y) * u };
        (window as unknown as { __focus: unknown }).__focus = null;
        const a = apiOf(canvas);
        const arr = arrivalOf(canvas);
        if (arr && !arr.settled) arr.sim = sim;
        if (a) {
          const s2 = a.getAppState();
          const cam = camOf(sim, { x: s2.offsetLeft, y: s2.offsetTop });
          a.updateScene({ appState: { scrollX: cam.scrollX, scrollY: cam.scrollY, zoom: { value: cam.zoom } } as never });
        }
        return switched;
      }
      // 画面中心：裁切框（y 150–1050）的中心
      const C = { x: 720, y: 600 };
      const label = focusLabel[level];
      let F = C;
      if (label) {
        const els = (nested.get().scenes.get(canvas) ?? []) as { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean }[];
        const live = els.filter((e) => !e.isDeleted);
        const n = live.find((e) => e.type === "rectangle" && labelOf(e, byId(live)) === label);
        if (n) {
          F = { x: (n.x + n.width / 2) * sim.k + sim.x, y: (n.y + n.height / 2) * sim.k + sim.y };
        }
      }
      // 绕 F 放大
      const g = Math.exp(rate(t) * dt);
      sim = { k: sim.k * g, x: F.x - (F.x - sim.x) * g, y: F.y - (F.y - sim.y) * g };
      // 把焦点往画面中心带（时间常数 0.45 s）
      const pull = 1 - Math.exp(-dt / 0.45);
      sim = { ...sim, x: sim.x + (C.x - F.x) * pull, y: sim.y + (C.y - F.y) * pull };
      // 还在放大（不报的话 IDLE_MS 后 ZoomLayer 认为手势停了，遮罩会退开）；焦点就是指针所在
      noteZoomGesture(canvas, 1, F.x, F.y);
      (window as unknown as { __focus: unknown }).__focus = label ? { x: F.x, y: F.y } : null;
      const arr = arrivalOf(canvas);
      if (arr && !arr.settled) arr.sim = sim; // 子图还没接手：它的替身跟着镜头走
      const a = apiOf(canvas);
      if (a) {
        const s2 = a.getAppState();
        const cam = camOf(sim, { x: s2.offsetLeft, y: s2.offsetTop });
        a.updateScene({ appState: { scrollX: cam.scrollX, scrollY: cam.scrollY, zoom: { value: cam.zoom } } as never });
      }
      return switched || t === 0;
    };
  }, L);
  await page.evaluate(() => (window as unknown as { __drive: (t: number) => boolean }).__drive(0));

  await page.keyboard.down("Control");
  await record("zoom", Number(opt("--seconds", "4.2")), async (t) => {
    // 每帧先在焦点节点上滚一格（deltaY −1）：ZoomLayer 由此认出这扇门、知道手势还在放大；这一格让 Excalidraw 自己缩放的那一点点，
    // 紧接着就被镜头盖掉。门在节点很小时（fill < 0.16）会被放下，所以不能只滚一次
    await page.evaluate(() => {
      const f = (window as unknown as { __focus: { x: number; y: number } | null }).__focus;
      if (!f) return;
      document.elementFromPoint(f.x, f.y)?.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, clientX: f.x, clientY: f.y, bubbles: true, cancelable: true }));
    });
    await page.evaluate((t) => (window as unknown as { __drive: (t: number) => boolean }).__drive(t), t);
    if (process.env.CAP_DEBUG && Math.round(t * fps) % 6 === 0)
      console.log(t.toFixed(2), await page.evaluate(() => [...document.querySelectorAll(".sz-layer")].map((l) => `${(l as HTMLElement).hidden ? "H" : "S"} pic:${(l.querySelector(".sz-pic") as HTMLElement).style.opacity} veil:${(l.querySelector(".sz-veil") as HTMLElement).style.opacity}`).join(" | ")));
  });
  await page.keyboard.up("Control");
}

if (which === "hop") {
  await cleanFrame(page, HIDE_HOP);
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4);
  await page.waitForFunction(() => (window as unknown as { __mockBase?: number }).__mockBase, null, { timeout: 30_000 });
  const base = await page.evaluate(() => (window as unknown as { __mockBase: number }).__mockBase);
  await page.clock.pauseAt(Date.now() + 200);
  // 走到场景的 --from 秒
  const from = Number(opt("--from", "0"));
  const now = await page.evaluate(() => Date.now());
  if (base + from * 1000 > now) await page.clock.runFor(base + from * 1000 - now);
  await page.evaluate(async () => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { canvases } = await imp("/src/session/ui.ts");
    // 跟随主 agent 的镜头关掉（⋯ 里的开关）：镜头不动，片子里的裁切和放大才对得上
    (await imp("/src/app/prefs.ts")).prefs.set({ followCamera: false });
    const seen = new Map<string, { zoom: { value: number }; scrollX: number; scrollY: number }>();
    // 每张画布第一次到前面时取景：内容居中在裁切框（y 150–1050）里，宽不过 78%、高不过 70%；之后每帧都按这个取景摆（镜头不动）
    (window as unknown as { __frame: () => void }).__frame = () => {
      const id = new URL(location.href).searchParams.get("canvas") || [...canvases.keys()][0];
      const api = canvases.get(id)?.api;
      if (!api) return;
      const had = seen.get(id);
      if (had) {
        const st = api.getAppState();
        if (st.zoom.value !== had.zoom.value || st.scrollX !== had.scrollX || st.scrollY !== had.scrollY) api.updateScene({ appState: had });
        return;
      }
      const els = api.getSceneElements().filter((e: { isDeleted?: boolean; type: string }) => !e.isDeleted && (e.type === "rectangle" || e.type === "arrow"));
      if (!els.length) return;
      const x0 = Math.min(...els.map((e: { x: number }) => e.x)), y0 = Math.min(...els.map((e: { y: number }) => e.y));
      const x1 = Math.max(...els.map((e: { x: number; width: number }) => e.x + e.width)), y1 = Math.max(...els.map((e: { y: number; height: number }) => e.y + e.height));
      const st = api.getAppState();
      const k = Math.min((1440 * 0.78) / (x1 - x0), (900 * 0.7) / (y1 - y0));
      // 屏幕点 = (场景点 + scroll) * zoom + offset
      const sx = (720 - st.offsetLeft) / k - (x0 + x1) / 2, sy = (600 - st.offsetTop) / k - (y0 + y1) / 2;
      const view = { zoom: { value: k }, scrollX: sx, scrollY: sy };
      seen.set(id, view);
      api.updateScene({ appState: view });
    };
  });
  // --enter <s>：录到这一秒时把 API 服务的子图换到前面（镜头不跟随，小人进了子图画面也不会自己跟进去）
  const enter = Number(opt("--enter", "-1"));
  let entered = false;
  await record("hop", Number(opt("--seconds", "20")), async (t) => {
    if (enter >= 0 && !entered && t >= enter) {
      entered = true;
      await page.evaluate(async () => { const p = "/src/nested/store.ts"; (await import(/* @vite-ignore */ p)).nav.go("c1", "c-api"); });
    }
    await page.evaluate(() => (window as unknown as { __frame: () => unknown }).__frame());
  });
}
await browser.close();
