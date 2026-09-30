// The fidelity comparison sheet: web/evidence/fidelity/index.html (offline, relative image paths).
//
//   node scripts/fidelity/sheet.ts [dir = evidence/fidelity]
//
// Reads what ./capture.ts wrote: <dir>/before and <dir>/after (prototype + Agora on the test
// diagram, per theme and moment), and <dir>/demo-before, <dir>/demo-after (the user's own demo
// diagram, Agora alone), plus <dir>/notes.json (deviations, perf and motion numbers).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "evidence/fidelity";
const cap = JSON.parse(readFileSync(join(dir, "after", "captures.json"), "utf8")) as { times: number[] };
const notes = existsSync(join(dir, "notes.json")) ? (JSON.parse(readFileSync(join(dir, "notes.json"), "utf8")) as { title: string; items: string[] }[]) : [];
const demoTimes = [14, 24, 30, 36];
const img = (p: string, alt: string) => (existsSync(join(dir, p)) ? `<figure><img loading="lazy" src="${p}" alt="${alt}"><figcaption>${alt}</figcaption></figure>` : `<figure class="missing"><figcaption>${alt}（无）</figcaption></figure>`);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

const rows: string[] = [];
for (const theme of ["light", "dark"]) {
  rows.push(`<h2 id="${theme}">测试图 · ${theme === "light" ? "浅色" : "深色"}（原型 / 改之前 / 改之后）</h2>`);
  for (const t of cap.times)
    rows.push(`<section class="row three"><h3>t = ${t} 秒</h3>${img(`after/${theme}/proto-${t}.png`, "原型")}${img(`before/${theme}/agora-${t}.png`, "Agora 改之前（5c3b66b）")}${img(`after/${theme}/agora-${t}.png`, "Agora 改之后")}</section>`);
  rows.push(`<section class="row tl"><h3>时间线 · t = ${cap.times[cap.times.length - 1]} 秒（紧凑）</h3>${img(`after/${theme}/proto-tl-${cap.times[cap.times.length - 1]}.png`, "原型")}${img(`before/${theme}/agora-tl-${cap.times[cap.times.length - 1]}.png`, "改之前（细条）")}${img(`after/${theme}/agora-tl-${cap.times[cap.times.length - 1]}.png`, "改之后")}</section>`);
  rows.push(`<section class="row tl"><h3>时间线 · 展开</h3>${img(`after/${theme}/proto-tlfull.png`, "原型")}${img(`before/${theme}/agora-tlfull.png`, "改之前")}${img(`after/${theme}/agora-tlfull.png`, "改之后")}</section>`);
}
for (const theme of ["light", "dark"]) {
  rows.push(`<h2 id="demo-${theme}">用户的示例架构图（素材库图标）· ${theme === "light" ? "浅色" : "深色"}（改之前 / 改之后）</h2>`);
  for (const t of demoTimes) rows.push(`<section class="row two"><h3>t = ${t} 秒</h3>${img(`demo-before/${theme}/agora-${t}.png`, "改之前")}${img(`demo-after/${theme}/agora-${t}.png`, "改之后")}</section>`);
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>工位视图保真对照</title>
<style>
:root{--bg:#fff;--fg:#2c3136;--muted:#5e686d;--line:#eceef0;--accent:#7048b4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#202428;--fg:#d9dee2;--muted:#a0a8ad;--line:#2c3136;--accent:#bea5f5;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif}
main{max-width:1800px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0}h2{font-size:16px;margin:28px 0 8px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:13px;color:var(--muted);margin:0 0 6px;grid-column:1/-1}
nav a{color:var(--accent);margin-right:12px}
.row{display:grid;gap:10px;margin:12px 0}.three{grid-template-columns:repeat(3,minmax(0,1fr))}.two{grid-template-columns:repeat(2,minmax(0,1fr))}.tl{grid-template-columns:1fr}
figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}figure img{display:block;width:100%;height:auto}
figcaption{font-size:12px;color:var(--muted);padding:4px 8px}.missing{min-height:40px}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.notes div{border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.notes h3{color:var(--fg);font-size:14px}.notes li{margin:4px 0}
@media (max-width:800px){.three,.two{grid-template-columns:1fr}}
</style></head><body><main>
<h1>工位视图：原型 ↔ 真实 Agora 对照</h1>
<p>同一段脚本（runs/fixtures.ts = 原型的 46 秒），同一张图（Web 前端 / API 服务 / MySQL / Redis / 支付服务 + 图外，按原型坐标搭的测试画布），同一视口（1440×900，2×）和主题，同一时刻。原型用 <code>#freeze=t</code>，Agora 用 Playwright 时钟停在 t。图形本身是 Excalidraw 画的，和原型的 SVG 方框不同。</p>
<nav><a href="#light">浅色</a><a href="#dark">深色</a><a href="#demo-light">示例图 浅色</a><a href="#demo-dark">示例图 深色</a><a href="#notes">差异与数字</a></nav>
${rows.join("\n")}
<h2 id="notes">差异、性能、动效</h2>
<div class="notes">${notes.map((n) => `<div><h3>${esc(n.title)}</h3><ul>${n.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`).join("")}</div>
</main></body></html>`;
writeFileSync(join(dir, "index.html"), html);
console.log(join(dir, "index.html"));
