// The README screenshots (docs/media/*.png), shot from the current build on a fresh demo project with a Claude Code session.
//
//   node scripts/readme-shots.ts [--lang zh|en] [--out <dir>] [--keep] [--reuse <kept dir>] [--only a,b] [--real-claude [--real-home]]
//
// By default `claude` is scripts/readme-shots/bin/claude, a scripted stand-in (no model, no tokens) that speaks the same
// stream-json and TUI, writes a native session log the way Claude Code does and really edits the demo files; the run
// refuses to start when `claude` on its PATH is anything else. --real-claude uses the real CLI (logged in; a few minutes
// and some tokens; the replies' wording then differs between runs, the layout does not).
//
// Needs: web/dist built (`npm run build`), tmux, uv; ffmpeg (optional) to shrink the PNGs to a 256-colour palette.
// Chromium is Playwright's, or `CHROMIUM=<path>`.
//
// What it does, in this order (each step is what a person would do; the page executes every canvas edit):
//   1. writes a small shop app (web/ api/ db/ queue/ worker/ docs/) into <tmp>/shop-demo, `git init`s it and runs `agora up`
//      there with its own HOME and AGORA_STATE_DIR (both under <tmp>), so nothing of yours is read or written;
//      with --real-claude, Claude's login is copied from ~/.claude/.credentials.json (or --real-home runs claude with your HOME);
//   2. opens the page (`?lang=zh|en`), draws the diagram with `agora canvas apply`        → choose-agent
//   3. starts Claude Code from the picker; turn 1 links the nodes to code paths (`agora canvas link`, by the agent), two
//      comments are pinned, turn 2 adds a feature across db/api/worker/web and docs/ (off the diagram)
//   4. turn 3 adds a refund endpoint in api/: shot while the figure stands on 「API」 writing                → overview
//   5. turn 4 wires the refund button in web/                                                                         —
//   6. the share popover                                                                                              → share
//   7. ▶ replays turn 2 to its end: route, stations, +N files per node, the summary                                   → pointer
//   8. trajectory view, one Edit call of turn 4 expanded (which also replays the turn up to that call)               → trajectory
//   9. 「open in terminal」: a tmux client attaches (taking the terminal over), a turn is typed in the TUI; single-pane
//      layout at 800×600                                                                                               → terminal
//  10. the guest page of a share, served by the real share gateway with Cloudflare stood in (scripts/readme-shots/guest.py) → guest
// Output: <out>/<name>.png for zh, <out>/<name>.en.png for en (default out: docs/media).
import { chromium, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LANG = opt("--lang", "zh") as "zh" | "en";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(opt("--out", join(REPO, "docs/media")));
const ONLY = args.includes("--only") ? new Set(opt("--only", "").split(",")) : null;
const KEEP = args.includes("--keep") || args.includes("--reuse");
/** --reuse <dir>: a project a --keep run left; only the shots after the turns are taken again (pointer onwards). */
const REUSE = opt("--reuse", "");
const REAL = args.includes("--real-claude");
const REAL_HOME = REAL && args.includes("--real-home");
const STUB = join(REPO, "web/scripts/readme-shots/bin");
const AGORA = join(REPO, "bin/agora");
const VIEW = { width: 1440, height: 900 };
if (!existsSync(join(REPO, "web/dist/index.html"))) throw new Error("web/dist is missing: run `npm run build` in web/ first");

// ——— words: the diagram, the demo files, the prompts, the comments ———
const T = {
  zh: {
    nodes: { user: "用户", web: "Web 前端\nReact · web/", api: "API 服务\nFastAPI · api/", db: "数据库\nSQLite · db/", queue: "任务队列\nRedis · queue/", worker: "通知 Worker\nworker/" },
    arrows: { http: "HTTP /api", rw: "读写订单", enq: "入队", take: "取任务" },
    note: "画出 shop-demo 的架构",
    readme: "# shop-demo\n\n一个小网店：React 前端、FastAPI、SQLite、Redis 任务队列和一个通知 worker。\n",
    notes: "# 备忘\n\n- 订单通过 `POST /api/orders` 创建。\n",
    turns: [
      "按代码结构给架构图关联路径：每个节点对应它的目录，做完用一两句话说明。",
      "全程用中文回复。加一个取消订单的功能：worker/main.py 处理 order_cancelled，db/repo.py 加 cancel_order，api/routes/orders.py 加 POST /orders/{id}/cancel 并把 order_cancelled 入队，web/src/api.ts 和 web/src/pages/Orders.tsx 加取消按钮；最后在 docs/notes.md 记一行。按这个顺序一个一个改，用编辑工具改文件，改完用列表总结。",
      "全程用中文回复。加退款接口：新建 api/routes/refunds.py，实现 POST /orders/{id}/refund（订单不存在返回 404，已取消的不能退款），再在 api/server.py 里注册这个路由。用编辑工具改文件，不要用 shell 写文件。改完用两三句话总结。",
      "全程用中文回复。前端接上退款：在 web/src/api.ts 加 refundOrder(id)，再在 web/src/pages/Orders.tsx 每行加一个「退款」按钮。用编辑工具改文件。改完用一两句话总结。",
    ],
    retryTurn: "全程用中文回复。给 api/routes/refunds.py 的退款接口加一个金额校验（金额必须大于 0，否则返回 422）。用编辑工具改文件。一两句话总结。",
    terminalTurn: "用中文一句话说说 worker/main.py 现在怎么处理任务，不要改文件。",
    comments: { db: "生产环境要换成 Postgres 吗？SQLite 扛不住并发写。", queue: "队列满了怎么办？要不要加个死信队列。" },
    guest: "小王",
  },
  en: {
    nodes: { user: "User", web: "Web front end\nReact · web/", api: "API service\nFastAPI · api/", db: "Database\nSQLite · db/", queue: "Job queue\nRedis · queue/", worker: "Notify worker\nworker/" },
    arrows: { http: "HTTP /api", rw: "read/write orders", enq: "enqueue", take: "take jobs" },
    note: "Draw the shop-demo architecture",
    readme: "# shop-demo\n\nA tiny shop: React front end, FastAPI, SQLite, a Redis job queue and a notification worker.\n",
    notes: "# Notes\n\n- Orders are created through `POST /api/orders`.\n",
    turns: [
      "Link the diagram to the code by its structure: each node gets its directory. Sum up in a sentence or two.",
      "Add order cancelling: handle order_cancelled in worker/main.py, cancel_order in db/repo.py, POST /orders/{id}/cancel in api/routes/orders.py that enqueues order_cancelled, a cancel button in web/src/api.ts and web/src/pages/Orders.tsx; finally one line in docs/notes.md. Change them one by one in this order with the edit tools, then sum up in a list.",
      "Add refunds: a new api/routes/refunds.py with POST /orders/{id}/refund (404 when the order does not exist, cancelled orders cannot be refunded), registered in api/server.py. Use the edit tools, not the shell, to write files. Sum up in two or three sentences.",
      "Wire refunds into the front end: refundOrder(id) in web/src/api.ts and a Refund button on every row in web/src/pages/Orders.tsx. Use the edit tools. Sum up in a sentence or two.",
    ],
    retryTurn: "Add an amount check to the refund endpoint in api/routes/refunds.py (the amount must be above 0, else 422). Use the edit tools. Sum up in a sentence or two.",
    terminalTurn: "In one sentence, how does worker/main.py handle jobs now? Do not change any file.",
    comments: { db: "Should production move to Postgres? SQLite won't take concurrent writes.", queue: "What happens when the queue fills up? Add a dead-letter queue?" },
    guest: "Alex",
  },
}[LANG];
const name = (n: string) => join(OUT, LANG === "zh" ? `${n}.png` : `${n}.${LANG}.png`);
const want = (n: string) => !ONLY || ONLY.has(n);

// ——— the demo project ———
const TMP = REUSE ? resolve(REUSE) : mkdtempSync(join(tmpdir(), "agora-readme-shots-"));
// the project's path shows in the trajectory: <tmp>/shop-demo when it is free, else inside TMP
const PROJ = REUSE ? readFileSync(join(TMP, "project.txt"), "utf8").trim() : !existsSync(join(tmpdir(), "shop-demo")) ? join(tmpdir(), "shop-demo") : join(TMP, "shop-demo");
if (!REUSE) writeFileSync(join(TMP, "project.txt"), PROJ);
const HOME = REAL_HOME ? process.env.HOME! : join(TMP, "home");
const env: NodeJS.ProcessEnv = { ...process.env, HOME, AGORA_STATE_DIR: join(TMP, "state"), PATH: `${REAL ? "" : STUB + ":"}${join(REPO, "bin")}:${process.env.PATH}`, AGORA_SHARE_DOMAIN: "example.com", UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(process.env.HOME!, ".cache/uv") };
delete env.TMUX;
for (const k of ["AGORA_LANG", "AGORA_URL", "AGORA_PROJECT", "AGORA_SESSION", "AGORA_CANVAS"]) delete env[k];
const which = execFileSync("bash", ["-c", "command -v claude || true"], { env, encoding: "utf8" }).trim();
if (!REAL && which !== join(STUB, "claude")) throw new Error(`refusing to start: claude on PATH is ${which || "missing"}, not the stand-in ${join(STUB, "claude")}`);
if (REAL && which === join(STUB, "claude")) throw new Error("--real-claude, but claude on PATH is the stand-in");
const FILES: Record<string, string> = {
  "README.md": T.readme,
  "docs/notes.md": T.notes,
  "web/src/App.tsx": `import { OrdersPage } from "./pages/Orders";\n\nexport function App() {\n  return (\n    <main>\n      <h1>Shop</h1>\n      <OrdersPage />\n    </main>\n  );\n}\n`,
  "web/src/pages/Orders.tsx": `import { useEffect, useState } from "react";\nimport { listOrders, type Order } from "../api";\n\nexport function OrdersPage() {\n  const [orders, setOrders] = useState<Order[]>([]);\n  useEffect(() => { listOrders().then(setOrders); }, []);\n  return (\n    <table>\n      <tbody>\n        {orders.map((o) => (\n          <tr key={o.id}><td>{o.id}</td><td>{o.total}</td><td>{o.status}</td></tr>\n        ))}\n      </tbody>\n    </table>\n  );\n}\n`,
  "web/src/api.ts": `export type Order = { id: number; total: number; status: string };\n\nexport async function listOrders(): Promise<Order[]> {\n  const r = await fetch("/api/orders");\n  return r.json();\n}\n`,
  "api/server.py": `from fastapi import FastAPI\n\nfrom api.routes import orders\n\napp = FastAPI(title="shop")\napp.include_router(orders.router, prefix="/api")\n`,
  "api/routes/__init__.py": "",
  "api/routes/orders.py": `from fastapi import APIRouter\n\nfrom db import repo\nfrom queue_client import enqueue\n\nrouter = APIRouter()\n\n\n@router.get("/orders")\ndef list_orders():\n    return repo.list_orders()\n\n\n@router.post("/orders")\ndef create_order(total: int):\n    order = repo.create_order(total)\n    enqueue("order_created", {"id": order["id"]})\n    return order\n`,
  "db/repo.py": `import sqlite3\n\nDB = sqlite3.connect("shop.db", check_same_thread=False)\nDB.row_factory = sqlite3.Row\n\n\ndef list_orders():\n    return [dict(r) for r in DB.execute("select id, total, status from orders order by id desc")]\n\n\ndef create_order(total: int):\n    cur = DB.execute("insert into orders (total, status) values (?, 'new')", (total,))\n    DB.commit()\n    return {"id": cur.lastrowid, "total": total, "status": "new"}\n`,
  "db/migrations/001_orders.sql": `create table orders (\n  id integer primary key,\n  total integer not null,\n  status text not null default 'new'\n);\n`,
  "queue/client.py": `import json\nimport redis\n\nr = redis.Redis()\n\n\ndef enqueue(kind: str, payload: dict) -> None:\n    r.rpush("jobs", json.dumps({"kind": kind, "payload": payload}))\n`,
  "worker/main.py": `import json\nimport redis\n\nr = redis.Redis()\n\n\ndef handle(job: dict) -> None:\n    if job["kind"] == "order_created":\n        print("send confirmation for order", job["payload"]["id"])\n\n\nif __name__ == "__main__":\n    while True:\n        _, raw = r.blpop("jobs")\n        handle(json.loads(raw))\n`,
};
for (const [p, s] of REUSE ? [] : Object.entries(FILES)) {
  mkdirSync(dirname(join(PROJ, p)), { recursive: true });
  writeFileSync(join(PROJ, p), s);
}
const run = (cmd: string, a: string[], o: { input?: string; cwd?: string } = {}) => execFileSync(cmd, a, { cwd: o.cwd ?? PROJ, env, input: o.input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
if (!REUSE) {
  run("git", ["init", "-q"]);
  run("git", ["add", "-A"]);
  run("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "shop"]);
}
if (!REAL_HOME && !REUSE) {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  const cred = join(process.env.HOME!, ".claude/.credentials.json");
  if (REAL && existsSync(cred)) copyFileSync(cred, join(HOME, ".claude/.credentials.json"));
  // the picker's default model, as on the machine the zh set was first shot on
  if (!REAL) writeFileSync(join(HOME, ".claude/settings.json"), JSON.stringify({ model: "opus" }));
  // no first-run screens in the terminal: onboarding done, light theme, this folder trusted
  writeFileSync(join(HOME, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "light", projects: { [PROJ]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
}
console.log("project", PROJ);
run(AGORA, ["up"]);
const server = JSON.parse(readFileSync(join(PROJ, ".agora/run/server.json"), "utf8")) as { url: string };
// always explicit: without it the page follows the browser's language
const URL0 = server.url + (server.url.includes("?") ? "&" : "?") + `lang=${LANG}`;

// ——— the page ———
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const LOCALE = LANG === "zh" ? "zh-CN" : "en-US";
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "no-preference", locale: LOCALE });
// the camera stays where the shot frames it (⋯ →「镜头跟随主 agent」off; a per-browser preference, app/prefs.ts)
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("agora.view", JSON.stringify({ followCamera: false }));
  } catch {}
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms: number) => page.waitForTimeout(ms);
const procs: ChildProcess[] = [];
let tmuxSock = "";

async function shot(n: string, p: Page | Buffer = page) {
  if (!want(n)) return;
  const raw = join(TMP, `${n}.raw.png`);
  if (Buffer.isBuffer(p)) writeFileSync(raw, p);
  else await p.screenshot({ path: raw });
  mkdirSync(OUT, { recursive: true });
  try {
    // 256 colours, no dithering: UI flats stay flat and the file is about a third of the size
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none", name(n)]);
  } catch {
    renameSync(raw, name(n));
  }
  console.log("wrote", name(n));
}

/** A node's centre on the page, by the first line of its label. */
const nodeAt = (label: string) =>
  page.evaluate((label) => {
    type El = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; text?: string; containerId?: string | null };
    const w = window as unknown as { __agora: { handles: Map<string, { api: { getSceneElements(): El[]; getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; offsetLeft: number; offsetTop: number } } }> } };
    const id = new URL(location.href).searchParams.get("canvas") ?? [...w.__agora.handles.keys()][0];
    const api = w.__agora.handles.get(id)!.api;
    const els = api.getSceneElements();
    const t = els.find((e) => e.type === "text" && !e.isDeleted && (e.text ?? "").split("\n")[0] === label && e.containerId)!;
    const e = els.find((x) => x.id === t.containerId)!;
    const a = api.getAppState();
    const z = a.zoom.value;
    return { x: a.offsetLeft + (e.x + e.width / 2 + a.scrollX) * z, y: a.offsetTop + (e.y + e.height / 2 + a.scrollY) * z, top: a.offsetTop + (e.y + a.scrollY) * z, right: a.offsetLeft + (e.x + e.width + a.scrollX) * z };
  }, label);
const first = (s: string) => s.split("\n")[0];

async function fit() {
  await page.mouse.click(40, 600);
  await page.keyboard.press("Shift+1");
  await wait(1200);
}

/** ⋯ → 布局: 0 单窗, or -1 恢复默认布局 (canvases left, sessions right). The workspace keeps it, so a later run starts from it. */
async function layout(i: number) {
  const menu = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.icon-btn")].filter((e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().y < 54).sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0];
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(menu.x, menu.y);
  await wait(400);
  await (i < 0 ? page.locator(".vm-restore") : page.locator(".vm-seg").first().locator("button").nth(i)).click();
  await page.keyboard.press("Escape");
  await wait(800);
}

/** Send a message from the composer; resolves once the turn has ended. `during` runs while it works. */
async function turn(text: string, during?: () => Promise<void>) {
  const box = page.locator(".sp-composer textarea");
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
  await page.locator(".sp-stop").first().waitFor({ timeout: 60_000 });
  if (during) await during();
  await page.locator(".sp-stop").first().waitFor({ state: "detached", timeout: 600_000 });
  await wait(2000);
}

/** While a turn works: frames with the figure writing a file under `prefix` (its bubble says so) and standing still — a bubble
 *  rides on its figure's feet, and walking to the node is a write too (「走去 …」), so a frame counts when the bubble is where it
 *  was in the frame before. Frames are taken all through the turn and the best one is written when it ends. */
async function whenWriting(n: string, prefix: string, node: string) {
  const at = await nodeAt(first(node));
  const seen = new Set<string>();
  const probe = async () => {
    const now = await page.evaluate((prefix) => {
      const ps = [...document.querySelectorAll<HTMLElement>(".ws-bub-pos")].filter((p) => p.style.visibility !== "hidden");
      const kinds = ps.map((p) => `${p.querySelector(".ws-bub")?.getAttribute("data-k")}:${p.innerText.replace(/\s+/g, " ").slice(0, 50)}`);
      const p = ps.find((p) => !!p.querySelector('.ws-bub[data-k="write"]') && p.innerText.includes(prefix));
      const r = p?.getBoundingClientRect();
      return { at: r ? `${Math.round(r.x / 2)},${Math.round(r.y / 2)}` : null, cx: r ? r.x + r.width / 2 : 0, kinds };
    }, prefix);
    now.kinds.filter((k) => !k.startsWith("think:")).forEach((k) => seen.add(k.replace(/\d+(\.\d+)? 秒|\d+(\.\d+)?s\b/g, "")));
    // and standing on that node: the bubble names the file before the walk there is over
    return Math.abs(now.cx - at.x) > at.right - at.x ? null : now.at;
  };
  let last: string | null = null;
  let best: { buf: Buffer; still: boolean } | null = null;
  while (await page.locator(".sp-stop").count()) {
    const before = await probe();
    const buf = await page.screenshot();
    // the same write bubble, in the same place, on both sides of the screenshot: not a frame where it is changing over
    const after = await probe();
    if (before && before === after) {
      const still = before === last;
      if (!best || (still && !best.still) || still === best.still) best = { buf, still };
    }
    last = after;
  }
  if (!best) return console.log(`(${n}: no write under ${prefix} seen; bubbles were: ${[...seen].slice(0, 30).join(" | ")})`);
  await shot(n, best.buf);
  return true;
}

try {
  await page.goto(URL0);
  await page.waitForFunction(() => !!(window as unknown as { __agora?: unknown }).__agora, null, { timeout: 30_000 });
  await wait(2000);

  if (!REUSE) {
  // the diagram, drawn the way an agent draws it (the page executes it); the first run has opened a new session's picker
  const N = T.nodes;
  const ops = [
    { op: "add_shape", ref: "user", shape: "ellipse", text: N.user, x: 0, y: 30, width: 140, height: 70 },
    { op: "add_shape", ref: "web", shape: "rectangle", text: N.web, x: 220, y: 20, width: 190, height: 90 },
    { op: "add_shape", ref: "api", shape: "rectangle", text: N.api, x: 500, y: 20, width: 190, height: 90 },
    { op: "add_shape", ref: "db", shape: "rectangle", text: N.db, x: 500, y: 250, width: 190, height: 90 },
    { op: "add_shape", ref: "queue", shape: "rectangle", text: N.queue, x: 780, y: 20, width: 190, height: 90 },
    { op: "add_shape", ref: "worker", shape: "rectangle", text: N.worker, x: 780, y: 250, width: 190, height: 90 },
    { op: "add_arrow", from: "user", to: "web" },
    { op: "add_arrow", from: "web", to: "api", text: T.arrows.http },
    { op: "add_arrow", from: "api", to: "db", text: T.arrows.rw },
    { op: "add_arrow", from: "api", to: "queue", text: T.arrows.enq },
    { op: "add_arrow", from: "queue", to: "worker", text: T.arrows.take },
  ];
  const base = (JSON.parse(run(AGORA, ["canvas", "read"])) as { base: string }).base;
  run(AGORA, ["canvas", "apply", "--base", base, "--note", T.note, "--json", JSON.stringify(ops)]);
  await wait(4000);
  await fit();
  await shot("choose-agent");

  // Claude Code from the picker (the person's own click)
  await page.locator("button.btn.primary", { hasText: "Claude Code" }).first().click({ timeout: 15_000 });
  await page.locator(".sp-composer textarea").waitFor({ timeout: 30_000 });
  await wait(1500);

  await turn(T.turns[0]); // code paths, linked by the agent
  // two comments pinned on nodes (comment mode: C; back to browsing: V)
  for (const [node, text] of [[first(N.db), T.comments.db], [first(N.queue), T.comments.queue]] as const) {
    const at = await nodeAt(node);
    await page.mouse.click(40, 600); // the canvas has the keyboard, not the composer
    await page.keyboard.press("c");
    await wait(300);
    await page.mouse.click(at.x + 30, at.y);
    await wait(700);
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await wait(700);
    await page.keyboard.press("Escape");
    await page.keyboard.press("v");
    await wait(400);
  }
  await turn(T.turns[1]); // a feature across the diagram, and docs/ off it
  await fit();
  let overview = false;
  await turn(T.turns[2], async () => void (overview = !!(await whenWriting("overview", "api/", T.nodes.api))));
  if (!overview) console.log("overview: the figure was never caught writing in api/; again with --reuse <dir> --only overview");
  await turn(T.turns[3]);
  await wait(1500);
  } else {
    await layout(-1);
    await fit();
    // --reuse --only overview: one more small change in api/, for another try at catching the figure there
    if (want("overview") && ONLY) await turn(T.retryTurn, async () => void (await whenWriting("overview", "api/", T.nodes.api)));
  }

  // share: the popover
  if (want("share")) {
    await page.locator(".share > button.btn").click();
    await wait(1800);
    await shot("share");
    await page.keyboard.press("Escape");
    await wait(600);
  }

  // pointer: ▶ replay turn 2 to its end
  if (want("pointer")) {
    await page.locator(".ds-trace-btn").nth(1).scrollIntoViewIfNeeded();
    await page.locator(".ds-trace-btn").nth(1).click();
    await page.locator(".ws-play-sum").first().waitFor({ timeout: 180_000 });
    // the figure done with the turn's last stop too (its bubble back to idle), the route and the counts left on the diagram —
    // taken at once: the summary only lasts until the replay ends and the page drops to the bare route
    for (let i = 0; i < 120 && (await page.locator('.ws-bub-pos .ws-bub:not([data-k="idle"])').count()); i++) await wait(100);
    await wait(300);
    await shot("pointer");
    await page.keyboard.press("Escape");
    await wait(1500);
  }

  // trajectory: the session's trajectory view, an Edit call of the last turn expanded
  if (want("trajectory")) {
    await page.locator(".sp-composer").hover();
    await page.locator(".sp-head1 button.icon-btn.sm").nth(0).click(); // 轨迹
    await wait(1200);
    // the turn's last Edit: by then the figure has reached the node it writes in
    await page.locator(".ds-rec-line", { hasText: /Edit\s+\// }).last().click();
    await wait(3500); // the figure walks to the step's node after the seek
    await shot("trajectory");
    await page.keyboard.press("Escape");
    await wait(800);
    await page.locator(".sp-head1 button.icon-btn.sm").nth(0).click(); // back to the conversation
    await wait(800);
  }

  // terminal: open it, take it over with a tmux client, type a turn in the TUI
  if (want("terminal")) {
    const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${process.getuid!()}`) : `/tmp/tmux-${process.getuid!()}`;
    const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
    const turnsBefore = await page.locator(".ds-trace-btn").count();
    await page.locator(".sp-head1 button.icon-btn.sm").nth(1).click(); // 在终端打开
    let sess = "";
    for (let i = 0; i < 60 && !sess; i++) {
      await wait(500);
      tmuxSock = (existsSync(dir) ? readdirSync(dir) : []).find((s) => s.startsWith("agora-") && !before.has(s)) ?? "";
      if (tmuxSock) sess = (() => { try { return run("tmux", ["-L", tmuxSock, "ls", "-F", "#S"]).trim().split("\n")[0]; } catch { return ""; } })();
    }
    if (!sess) throw new Error("the terminal session did not start");
    run("tmux", ["-L", "agora-shots-outer", "new", "-d", "-x", "160", "-y", "45", `tmux -L ${tmuxSock} attach -t ${sess}`]);
    for (let i = 0; i < 60; i++) {
      await wait(500);
      if (/❯|>\s*$/m.test(run("tmux", ["-L", tmuxSock, "capture-pane", "-p", "-t", sess]))) break;
    }
    await wait(1500);
    run("tmux", ["-L", tmuxSock, "send-keys", "-t", sess, "-l", T.terminalTurn]);
    await wait(400);
    run("tmux", ["-L", tmuxSock, "send-keys", "-t", sess, "Enter"]);
    for (let i = 0; i < 240 && (await page.locator(".ds-trace-btn").count()) <= turnsBefore; i++) await wait(500);
    for (let i = 0; i < 240 && (await page.locator(".sp-stop").count()); i++) await wait(500);
    await wait(6000);
    // only the session, at 800×600
    await layout(0);
    await page.setViewportSize({ width: 800, height: 600 });
    await wait(1500);
    if (await page.locator(".sp-jump").count()) await page.locator(".sp-jump").first().click().catch(() => {});
    await wait(1000);
    await shot("terminal");
    await page.setViewportSize(VIEW);
    await layout(-1);
  }

  // guest: the share gateway over this project (Cloudflare stood in), in a browser of its own
  if (want("guest")) {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const g = spawn("uv", ["run", "--quiet", "--project", REPO, "python", join(REPO, "web/scripts/readme-shots/guest.py"), PROJ, "c1", String(port)], { env, stdio: ["ignore", "pipe", "inherit"] });
    procs.push(g);
    const url = await new Promise<string>((ok, no) => {
      createInterface({ input: g.stdout! }).on("line", (l) => l.startsWith("{") && ok(JSON.parse(l).url));
      g.on("exit", () => no(new Error("guest.py exited")));
    });
    await new Promise((r) => setTimeout(r, 1500));
    const gctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light", locale: LOCALE });
    const gp = await gctx.newPage();
    await gp.goto(url);
    await gp.goto(gp.url() + (gp.url().includes("?") ? "&" : "?") + `lang=${LANG}`);
    await gp.waitForTimeout(2500);
    await gp.locator("input").first().fill(T.guest);
    await gp.keyboard.press("Enter");
    await gp.waitForTimeout(1000);
    await gp.locator(".dock .dock-btn:has(.dock-badge)").first().click(); // 所有评论
    await gp.waitForTimeout(1200);
    // the diagram fitted, then slid left of the comment drawer
    await gp.mouse.click(60, 700);
    await gp.keyboard.press("Shift+1");
    await gp.waitForTimeout(800);
    await gp.mouse.move(400, 500);
    await gp.mouse.wheel(260, 0);
    await gp.waitForTimeout(1200);
    await shot("guest", gp);
    await gctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  for (const p of procs) p.kill();
  try { run("tmux", ["-L", "agora-shots-outer", "kill-server"]); } catch {}
  if (tmuxSock) try { run("tmux", ["-L", tmuxSock, "kill-server"]); } catch {}
  try { run(AGORA, ["down"]); } catch {}
  if (KEEP) console.log("kept", TMP, "(again: --reuse", TMP + ")");
  else {
    rmSync(TMP, { recursive: true, force: true });
    if (!PROJ.startsWith(TMP)) rmSync(PROJ, { recursive: true, force: true });
  }
}
