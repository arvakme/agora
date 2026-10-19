// Audit for 分站揭示's drawing (web/docs/workstation.md §17): is every element an agent's batch can add drawn on, not faded?
//
//   node scripts/ink-audit.ts <dev page url> <out.md>
//
// Loads every library item of web/libraries/items (as insert_library_item places it) and a synthetic scene of every element type × stroke style ×
// fill style into the dev page, runs each through the reveal layer's own export and preparation (src/workstation/ink.ts, via scripts/ink-scenes.ts),
// and writes a table: per library, per item, per synthetic element — how it is drawn (traced, through a mask, wiped on), what fell back to a fade and
// why, and whether each element that draws is seen part drawn at some moment of its unit (painted at 36 moments). Exits 1 when anything fell back.
// The Chromium is Playwright's, or `CHROMIUM=<path>`.
import { chromium } from "playwright";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Audit, PartRow } from "./ink-scenes";

const [url, out] = process.argv.slice(2);
/** --sample n: only the first n items of each library (a quick look); --synthetic: only the synthetic scene. */
const sample = process.argv.includes("--sample") ? Number(process.argv[process.argv.indexOf("--sample") + 1]) : Infinity;
const onlySynth = process.argv.includes("--synthetic");
if (!url || !out) {
  console.error("usage: node scripts/ink-audit.ts <dev page url> <out.md>");
  process.exit(2);
}
const ROOT = new URL("../libraries/items", import.meta.url).pathname;
const files: string[] = [];
const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith(".json") && files.push(join(d, n))));
walk(ROOT);
files.sort();

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(url);
await page.waitForTimeout(3000);

const synth = (await page.evaluate(async () => {
  const m = (await import(/* @vite-ignore */ "/scripts/ink-scenes.ts" as string)) as typeof import("./ink-scenes");
  const { elements, files } = m.syntheticScene();
  return m.auditEls("synthetic", elements, files);
})) as Audit;
for (const p of synth.parts.filter((p) => p.how === "fade")) console.log("  synth fade:", p.desc, p.reason);
if (synth.error) console.log("synthetic error:", synth.error);

type ItemAudit = Audit & { elements: number; id: string; name: string; library: string };
const items: ItemAudit[] = [];
for (const f of onlySynth ? [] : files) {
  const lib = JSON.parse(readFileSync(f, "utf8")) as { library?: string; items: { id: string; name: string; elements: unknown[] }[] };
  const library = relative(ROOT, f).replace(/\.json$/, "");
  const list = lib.items.slice(0, sample);
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100).map((x) => ({ ...x, library }));
    const res = (await page.evaluate(async (chunk) => {
      const m = (await import(/* @vite-ignore */ "/scripts/ink-scenes.ts" as string)) as typeof import("./ink-scenes");
      const outs = [];
      for (const it of chunk) outs.push({ ...(await m.auditItem(it)), id: it.id, name: it.name, library: it.library });
      return outs;
    }, chunk)) as ItemAudit[];
    items.push(...res);
  }
  process.stdout.write(`${library}: ${lib.items.length}\n`);
}
await browser.close();

// ——— the report ———
const HOW = ["trace", "mask", "wipe", "fade", "none"] as const;
const count = (parts: PartRow[]) => Object.fromEntries(HOW.map((h) => [h, parts.filter((p) => p.how === h).length])) as Record<(typeof HOW)[number], number>;
const reasons = (parts: PartRow[]) => [...new Set(parts.filter((p) => p.how === "fade").map((p) => `${p.desc}: ${p.reason}`))].join("; ");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const all = items.flatMap((x) => x.parts);
const tot = count(all);
const errors = items.filter((x) => x.error);
const noPartial = items.filter((x) => !x.partial && !x.error && x.parts.some((p) => p.how !== "none"));
const fallbackItems = items.filter((x) => x.parts.some((p) => p.how === "fade"));
const strays = items.reduce((a, x) => a + x.strays, 0);
const libs = [...new Set(items.map((x) => x.library))];
const synthTot = count(synth.parts);

const L: string[] = [];
L.push("# 分站揭示画法审计（ink audit）", "");
L.push(`由 \`web/scripts/ink-audit.ts\` 生成：每个素材库组件按 \`insert_library_item\` 的方式实例化，再走揭示层自己的导出与拆笔画路径（\`src/workstation/ink.ts\`），逐元素记录画法。`, "");
L.push("画法：**trace** 沿笔画描（Rough.js 的每一段、两遍一起）；**mask** 透过遮罩描（虚线、点线保留原样的虚实，手绘笔迹沿点描出）；**wipe** 擦出（图片、文字逐行、只有填充没有描边的形状）；**fade** 退回淡入（列出原因）；**none** 本来就看不见（组件自己的透明外框、无描边无填充）。", "");
L.push("## 汇总", "");
L.push(`- 素材库 ${libs.length} 个文件，组件 ${items.length} 个，元素 ${all.length} 个（含组件外框与标注）`);
L.push(`- trace ${tot.trace} · mask ${tot.mask} · wipe ${tot.wipe} · **fade ${tot.fade}** · none ${tot.none}`);
L.push(`- 有元素退回淡入的组件：${fallbackItems.length} 个；导出失败：${errors.length} 个；导出里认不出归属的节点：${strays} 个`);
L.push(`- 每个要画的元素都在某一刻被看到“画了一半”（笔画或擦出进行中；每个单元在笔画和写字阶段各取 24 / 12 个时刻）的组件：${items.length - noPartial.length - errors.length} / ${items.length - errors.length}${noPartial.length ? `（没看到的 ${noPartial.length} 个列在下面）` : ""}`);
L.push(`- 合成场景（每种类型 × 线型 × 填充）：元素 ${synth.parts.length} 个 · trace ${synthTot.trace} · mask ${synthTot.mask} · wipe ${synthTot.wipe} · **fade ${synthTot.fade}** · none ${synthTot.none}${synth.error ? ` · 错误 ${synth.error}` : ""}`, "");
if (errors.length) {
  L.push("### 导出失败", "", "| 库 | 组件 | 错误 |", "|---|---|---|");
  for (const x of errors) L.push(`| ${x.library} | ${esc(x.name || x.id)} | ${esc(x.error!)} |`);
  L.push("");
}
if (noPartial.length) {
  L.push("### 有元素没被看到半笔的组件", "", "| 库 | 组件 | 元素 | 画法 | 没看到半笔的元素 |", "|---|---|---|---|---|");
  for (const x of noPartial) L.push(`| ${x.library} | ${esc(x.name || x.id)} | ${x.elements} | ${esc(JSON.stringify(count(x.parts)))} | ${esc((x.unseen ?? []).join("; "))} |`);
  L.push("");
}
L.push("## 按库", "", "| 库 | 组件 | 元素 | trace | mask | wipe | fade | none |", "|---|---:|---:|---:|---:|---:|---:|---:|");
for (const lib of libs) {
  const xs = items.filter((x) => x.library === lib);
  const c = count(xs.flatMap((x) => x.parts));
  L.push(`| ${lib} | ${xs.length} | ${xs.reduce((a, x) => a + x.parts.length, 0)} | ${c.trace} | ${c.mask} | ${c.wipe} | ${c.fade} | ${c.none} |`);
}
L.push("", "## 合成场景（逐元素）", "", "| 元素 | 画法 | 原因 |", "|---|---|---|");
for (const p of synth.parts) L.push(`| ${esc(p.desc)} | ${p.how} | ${esc(p.reason ?? "")} |`);
L.push("", "## 逐组件", "", "| 库 | 组件 | 元素 | 画出（trace/mask/wipe） | 退回淡入 | 看不见 | 半笔 | 原因 |", "|---|---|---:|---:|---:|---:|---|---|");
for (const x of items) {
  const c = count(x.parts);
  L.push(`| ${x.library} | ${esc(x.name || x.id)} | ${x.parts.length} | ${c.trace + c.mask + c.wipe} | ${c.fade} | ${c.none} | ${x.error ? "错误" : x.partial ? "✓" : "—"} | ${esc(x.error ?? reasons(x.parts))} |`);
}
writeFileSync(out, L.join("\n") + "\n");
console.log(`items ${items.length}, elements ${all.length}`, tot, `fallback items ${fallbackItems.length}, errors ${errors.length}, strays ${strays}, no partial ${noPartial.length}`);
console.log("synthetic", synthTot, synth.error ?? "", "all seen part drawn:", synth.partial, synth.unseen);
const us = new Map<string, number>();
for (const d of items.flatMap((x) => x.unseen ?? [])) us.set(d, (us.get(d) ?? 0) + 1);
for (const [d, n] of [...us].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("  unseen:", n, d);
const rs = new Map<string, number>();
for (const p of all.filter((p) => p.how === "fade")) rs.set(`${p.desc.split(" ")[0]}: ${p.reason}`, (rs.get(`${p.desc.split(" ")[0]}: ${p.reason}`) ?? 0) + 1);
for (const [r, n] of rs) console.log("  lib fade:", n, r);
process.exit(tot.fade || synthTot.fade || errors.length ? 1 : 0);
