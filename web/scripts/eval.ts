// Real-model eval CLI: drives a headless browser through the same UI path as the
// in-app eval button (canvas ?eval → __agora.eval.run), then writes
// eval/runs/<runId>.jsonl and eval/latest-report.md.
//
//   npm run eval -- --runs 3            # 7 tasks × 3 runs
//   npm run eval -- --runs 1 --tasks t1,t6
//
// Needs the canvas backend on :8000 (claude -p calls go through it). If nothing
// answers there, the script starts the standalone canvas app from the repo root
// (`uv run uvicorn server.canvas.router:app`); set AGORA_API_ORIGIN to reuse one.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const WEB = new URL("..", import.meta.url).pathname;
const ROOT = join(WEB, "..");
const PORT = Number(process.env.AGORA_WEB_PORT ?? 5199);
const API = process.env.AGORA_API_ORIGIN ?? "http://localhost:8000";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(opt("runs") ?? 3);
const only = opt("tasks")
  ?.split(",")
  .map((t) => `T${t.replace(/\D/g, "")}`);

const procs: ChildProcess[] = [];
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", () => (cleanup(), process.exit(130)));

async function waitFor(url: string, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureBackend(): Promise<boolean> {
  if (await waitFor(`${API}/api/canvas/library/libs`, 3000)) return true;
  console.log(`canvas backend not on ${API}; starting uvicorn server.canvas.router:app …`);
  procs.push(spawn("uv", ["run", "uvicorn", "server.canvas.router:app", "--port", new URL(API).port || "8000"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }));
  return waitFor(`${API}/api/canvas/library/libs`, 60_000);
}

const apiUp = await ensureBackend();
if (!apiUp) {
  console.error(`canvas backend unreachable at ${API} — start it first (see README 工作台)`);
  cleanup();
  process.exit(2);
}
console.log(`starting vite dev on :${PORT} …`);
procs.push(spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: WEB, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGORA_API_ORIGIN: API } }));
if (!(await waitFor(`http://localhost:${PORT}/`))) {
  console.error("vite dev server did not come up");
  cleanup();
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => (m.type() === "error" ? console.error(`[page] ${m.text()}`) : undefined));
await page.goto(`http://localhost:${PORT}/?eval`);
await page.waitForFunction(() => (window as any).__agora?.eval, null, { timeout: 30_000 });
console.log(`eval: ${only?.length ?? 7} tasks × ${runs} runs …`);
const rows = (await page.evaluate(
  (o) => (window as any).__agora.eval.run(o),
  { runs, only },
)) as { runId: string }[];

const runId = rows[0]?.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(WEB, "eval", "runs");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${runId}.jsonl`);
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ok = (rows as unknown as { success: boolean }[]).filter((r) => r.success).length;
console.log(`${ok}/${rows.length} success → ${file}`);
await browser.close();
cleanup();

// Regenerate eval/latest-report.md from this run.
const report = spawn("node", [join(WEB, "scripts/eval-report.ts"), file], { cwd: WEB, stdio: ["ignore", "pipe", "inherit"] });
let md = "";
report.stdout!.on("data", (d) => (md += d));
await new Promise((r) => report.on("close", r));
writeFileSync(join(WEB, "eval", "latest-report.md"), md);
process.exit(0);
