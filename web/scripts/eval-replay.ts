// Offline eval replay: re-executes the recorded model outputs in eval/runs/*.jsonl
// through validatePlan → applyPlan → task check → undo on the real canvas, and compares
// each recomputed row with the recorded one. Deterministic; needs no backend or model.
//
//   npm run eval:replay                      # replay the newest run file
//   npm run eval:replay -- --file runs/x.jsonl --all   # options
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const WEB = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.AGORA_WEB_PORT ?? 5199);

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = args.includes("--all");

const dir = join(WEB, "eval", "runs");
const names = opt("file") ? [opt("file")!.replace(/^.*\//, "")] : readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
const files = all ? names : names.slice(-1);
if (!files.length) {
  console.error(`no eval runs in ${dir}`);
  process.exit(2);
}

const procs: ChildProcess[] = [];
// Children run in their own process group (detached) so cleanup reaches the real server
// under the npx/uv wrapper; killing only the wrapper left vite orphaned on the port.
const cleanup = () =>
  procs.forEach((p) => {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {
      p.kill("SIGTERM");
    }
  });
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

console.log(`starting vite dev on :${PORT} …`);
procs.push(spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: WEB, stdio: ["ignore", "pipe", "inherit"], detached: true }));
if (!(await waitFor(`http://localhost:${PORT}/`))) {
  console.error("vite dev server did not come up");
  cleanup();
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://localhost:${PORT}/?eval`);
await page.waitForFunction(() => (window as any).__agora?.eval, null, { timeout: 30_000 });

let bad = 0;
for (const f of files) {
  const rows = readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const results = (await page.evaluate((r) => (window as any).__agora.eval.replay(r), rows)) as {
    task: string; run: number; replayed: boolean; match: boolean; reason?: string; expected?: unknown; actual?: unknown;
  }[];
  for (const r of results) {
    if (r.match) {
      console.log(`  ${f} ${r.task}#${r.run} ${r.replayed ? "✓" : "– skipped"}`);
    } else {
      bad++;
      console.log(`✗ ${f} ${r.task}#${r.run} ${r.reason ?? ""}\n    expected ${JSON.stringify(r.expected)}\n    actual   ${JSON.stringify(r.actual)}`);
    }
  }
  const n = results.filter((r) => r.replayed).length;
  console.log(`${f}: ${n} replayed, ${results.length - n} skipped, ${results.filter((r) => !r.match).length} mismatched`);
}
await browser.close();
cleanup();
if (bad) {
  console.error(`replay: ${bad} mismatched row(s)`);
  process.exit(1);
}
console.log("replay: all rows match");
process.exit(0);
