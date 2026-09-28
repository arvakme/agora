const [label, url] = process.argv.slice(-2);
const task = await taskSpace(146);
const page = task.page("p1");
const fs = await import("node:fs/promises");
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 2, mobile: false });
await page.goto(url);
await page.waitForTimeout(3000);
await page.mouse.click(700, 640);
await page.waitForTimeout(300);
// The Ego window is not in front, so Chrome throttles it to 1 frame/s; an active screencast keeps
// the compositor producing frames (same condition for both builds).
await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
await page.cdp("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 200, maxHeight: 200, everyNthFrame: 1 });
await page.waitForTimeout(300);
await page.cdp("Performance.enable", {});
const metric = async () => Object.fromEntries((await page.cdp("Performance.getMetrics", {})).metrics.map((m) => [m.name, m.value]));
const m0 = await metric();
await page.evaluate(() => {
  const P = (window.__perf = { on: true, frames: [], longtasks: [], trace: [] });
  new PerformanceObserver((l) => l.getEntries().forEach((e) => P.longtasks.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: false });
  let last = performance.now();
  const f = (t) => {
    P.frames.push(+(t - last).toFixed(2));
    last = t;
    const pin = document.querySelector(".aim-pin");
    if (pin) P.trace.push([+t.toFixed(1), pin.style.transform]);
    if (P.on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
const move = (x, y) => page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
await page.keyboard.press("c");
await page.waitForTimeout(400);
const path = [[700, 600], [930, 370], [1170, 380], [680, 360], [1090, 600], [930, 380]];
for (let i = 1; i < path.length; i++) {
  const [ax, ay] = path[i - 1], [bx, by] = path[i];
  for (let k = 0; k <= 40; k++) {
    await move(ax + ((bx - ax) * k) / 40, ay + ((by - ay) * k) / 40);
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(250);
}
await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: 930, y: 380, button: "left", clickCount: 1 });
await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 930, y: 380, button: "left", clickCount: 1 });
await page.waitForTimeout(800);
const shot = await page.cdp("Page.captureScreenshot", { format: "png", clip: { x: 800, y: 220, width: 560, height: 300, scale: 1 } });
await fs.writeFile(`/tmp/agora-polish/${label}-after-click.png`, Buffer.from(shot.data, "base64"));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const P = await page.evaluate(() => ((window.__perf.on = false), window.__perf));
const m1 = await metric();
await page.cdp("Page.stopScreencast", {});
const d = (k) => +(m1[k] - m0[k]).toFixed(4);
const fr = P.frames.slice(1).sort((a, b) => a - b);
const q = (p) => fr[Math.min(fr.length - 1, Math.floor(p * fr.length))];
const med = q(0.5);
const out = {
  label, url, at: new Date().toISOString(),
  frames: fr.length, medianMs: med, p95Ms: q(0.95), p99Ms: q(0.99), maxMs: fr.at(-1),
  dropped: fr.filter((x) => x > med * 1.5).length,
  longTasks: P.longtasks.length, longTaskMs: P.longtasks.reduce((a, b) => a + b, 0),
  cdp: { LayoutCount: d("LayoutCount"), RecalcStyleCount: d("RecalcStyleCount"), LayoutDurationMs: +(d("LayoutDuration") * 1000).toFixed(1), RecalcStyleDurationMs: +(d("RecalcStyleDuration") * 1000).toFixed(1), ScriptDurationMs: +(d("ScriptDuration") * 1000).toFixed(1), TaskDurationMs: +(d("TaskDuration") * 1000).toFixed(1) },
};
await fs.writeFile(`/tmp/agora-polish/${label}-perf.json`, JSON.stringify({ ...out, trace: P.trace }, null, 1));
console.log(JSON.stringify(out));
