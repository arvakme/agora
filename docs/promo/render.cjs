// 把一页 HTML/SVG 截成 PNG，或逐帧渲染成 PNG 序列（页面暴露 window.renderFrame(t) 时）。
// 用法：
//   NODE_PATH=web/node_modules node docs/promo/render.cjs shot  <page> <out.png> <w> <h> [scale]
//   NODE_PATH=web/node_modules node docs/promo/render.cjs frames <page> <outdir> <w> <h> <fps> <seconds> [query]
// 需要 playwright（web/ 的开发依赖）；浏览器用 PW_CHROMIUM 指定，默认 /opt/pw-browsers 里的 chromium。
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const exe = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function main() {
  const [mode, page, out, w, h, ...rest] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: exe, args: ["--force-color-profile=srgb"] });
  const scale = mode === "shot" ? Number(rest[0] || 1) : 1;
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: scale });
  const p = await ctx.newPage();
  p.on("console", (m) => console.log("[page]", m.text()));
  p.on("pageerror", (e) => console.error("[page error]", e.message));
  const query = mode === "frames" ? rest[2] || "" : "";
  await p.goto("file://" + path.resolve(page) + query);
  await p.waitForFunction(() => window.__ready === true || document.readyState === "complete" && window.__ready === undefined, null, { timeout: 120000 });
  if (mode === "shot") {
    await p.screenshot({ path: out, clip: { x: 0, y: 0, width: Number(w), height: Number(h) } });
  } else {
    const fps = Number(rest[0]);
    const secs = Number(rest[1]);
    fs.mkdirSync(out, { recursive: true });
    const n = Math.round(fps * secs);
    for (let i = 0; i < n; i++) {
      await p.evaluate((t) => window.renderFrame(t), i / fps);
      await p.screenshot({ path: path.join(out, String(i).padStart(5, "0") + ".png") });
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
