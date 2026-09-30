// The canvas's bottom row must sit level (web/docs/workstation.md §15): Excalidraw's zoom and undo/redo islands, our 「浏览 / 评论」 dock, the 「整张图」 button and Excalidraw's help
// button share one height, one bottom edge and one vertical centre (≤ 1 px apart), in both themes and in a wide and a narrower window, and stay that way with 评论 selected,
// the whole-canvas comment list open, and the bar-form session pill beside the dock (when the project has a session to show).
//
// And the group they form sits level AND centred (§15): the 「浏览 / 评论」 dock together with the folded session bar's pill beside it (when there is one) is centred on the canvas body
// (≤ 1 px), so is the bottom bar's middle over it; with no room for the pill's words it is the round avatar, still centred. Those cases need a project with a session to fold
// (the page shows the session bar only from 1100 × 640 up), so they run against such a url with --centre; the level checks want a canvas without a session column (a mock url).
//
//   node scripts/bottom-row-check.ts <agora url, e.g. http://localhost:5200/?mock=runs&canvas=c1>             the level checks
//   node scripts/bottom-row-check.ts <agora url of a project with a session, e.g. http://localhost:5200/> --centre   the group-centre checks
//
// Read-only: non-GET /api requests are refused. Exit 1 on any violation; prints one line per (window, theme, state) with the measured numbers.
import { chromium, type Page } from "playwright";

const url = process.argv[2];
const centre = process.argv.includes("--centre");
if (!url) {
  console.error("usage: node scripts/bottom-row-check.ts <agora url> [--centre]");
  process.exit(2);
}
const TOL = 1;
const CONTROLS = {
  zoom: ".excalidraw .zoom-actions",
  undo: ".excalidraw .undo-redo-buttons",
  dock: ".dock",
  whole: ".whole-btn",
  help: ".excalidraw .help-icon",
  pill: ".bar-pill",
  bar: ".excalidraw .App-bottom-bar .Island", // the compact layout's bottom bar (no zoom / undo / help islands then)
} as const;
type Name = keyof typeof CONTROLS;
type Rect = { top: number; bottom: number; h: number; cy: number };

const measure = (page: Page) =>
  page.evaluate((sel) => {
    const out: Record<string, { top: number; bottom: number; h: number; cy: number } | null> = {};
    for (const [k, s] of Object.entries(sel)) {
      const e = document.querySelector(s);
      const r = e?.getBoundingClientRect();
      out[k] = r && r.width > 0 ? { top: r.top, bottom: r.bottom, h: r.height, cy: (r.top + r.bottom) / 2 } : null;
    }
    return out;
  }, CONTROLS) as Promise<Record<Name, Rect | null>>;

/** Violations of "same height, same bottom, same centre" among the controls that are on screen. */
export function violations(rects: Record<string, Rect | null>, centresOnly = false): string[] {
  const on = Object.entries(rects).filter((e): e is [string, Rect] => e[1] !== null);
  if (on.length < 2) return ["fewer than two controls are on screen"];
  const spread = (f: (r: Rect) => number) => Math.max(...on.map(([, r]) => f(r))) - Math.min(...on.map(([, r]) => f(r)));
  const bad: string[] = [];
  if (!centresOnly && spread((r) => r.h) > 0.5) bad.push(`heights differ by ${spread((r) => r.h).toFixed(2)}`);
  if (!centresOnly && spread((r) => r.bottom) > TOL) bad.push(`bottom edges differ by ${spread((r) => r.bottom).toFixed(2)}`);
  if (spread((r) => r.cy) > TOL) bad.push(`vertical centres differ by ${spread((r) => r.cy).toFixed(2)}`);
  return bad;
}

const browser = await chromium.launch({ headless: true });
let failed = 0;
// 640 wide: Excalidraw's compact layout, where the dock sits in the bottom bar (taller than the islands): only the centres have to agree there
for (const [w, h] of centre ? [] : [[1440, 900], [1000, 800], [640, 800]]) {
  for (const theme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem("agora.theme", t), theme);
    const page = await ctx.newPage();
    await page.route("**/api/**", (r) => (r.request().method() === "GET" ? r.continue() : r.abort()));
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { __agora?: { api?: unknown } }).__agora?.api && document.querySelector(".canvas-view"));
    await page.waitForTimeout(1200);
    const states: [string, () => Promise<void>][] = [
      ["default", async () => {}],
      ["评论 selected", async () => void (await page.getByRole("radio", { name: "评论" }).click())],
      ["整张图 list open", async () => void (await page.locator(".whole-btn").click())],
    ];
    for (const [name, enter] of states) {
      await enter();
      await page.waitForTimeout(500);
      const rects = await measure(page);
      const bad = violations(rects, w < 730);
      const line = Object.entries(rects).filter(([, r]) => r).map(([k, r]) => `${k} ${r!.top.toFixed(1)}–${r!.bottom.toFixed(1)} (h ${r!.h.toFixed(1)}, cy ${r!.cy.toFixed(1)})`).join(" | ");
      console.log(`${bad.length ? "FAIL" : "ok  "} ${w}×${h} ${theme} ${name}: ${line}${bad.length ? `  ← ${bad.join("; ")}` : ""}`);
      if (bad.length) failed++;
    }
    await ctx.close();
  }
}

// ——— the dock (and pill) group is centred on the canvas body ———
type Span = { l: number; r: number };
const groupCentres = (page: Page) =>
  page.evaluate(() => {
    const span = (e: Element | null): Span | null => {
      const r = e?.getBoundingClientRect();
      return r && r.width > 0 ? { l: r.left, r: r.right } : null;
    };
    const canvas = [...document.querySelectorAll('[data-pane] .canvas-layers')].map(span).find((x) => x);
    return { canvas: canvas ?? null, dock: span(document.querySelector(".dock")), pill: span(document.querySelector(".bar-pill")), bar: span(document.querySelector('.wm-group[data-float="bar"]')) };
  });
type View = { float: "dock" | "card" | "bar"; bar?: { width?: number; expanded?: boolean; folded?: boolean }; canvasMax?: number };
const CENTRE_CASES: { name: string; w: number; h: number; view: View; pill: "none" | "words" | "round"; bar?: boolean }[] = [
  { name: "no pill (session as a card)", w: 1440, h: 900, view: { float: "card" }, pill: "none" },
  { name: "pill beside the dock", w: 1440, h: 900, view: { float: "bar", bar: { folded: true } }, pill: "words" },
  { name: "pill beside the dock, at the 1100 edge", w: 1100, h: 800, view: { float: "bar", bar: { folded: true } }, pill: "words" },
  { name: "bar over the dock", w: 1440, h: 900, view: { float: "bar", bar: {} }, pill: "none", bar: true },
  { name: "half-screen bar, dragged to 1000 wide", w: 1440, h: 900, view: { float: "bar", bar: { expanded: true, width: 1000 } }, pill: "none", bar: true },
  { name: "narrow canvas (560): round pill", w: 1100, h: 800, view: { float: "bar", bar: { folded: true }, canvasMax: 560 }, pill: "round" },
  { name: "session docked at the right: the canvas column's middle", w: 1440, h: 900, view: { float: "dock" }, pill: "none" },
];
for (const c of centre ? CENTRE_CASES : []) {
  for (const theme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, colorScheme: theme });
    await ctx.addInitScript(
      ([t, v]) => {
        localStorage.setItem("agora.theme", t as string);
        const view = v as View;
        localStorage.setItem("agora.view", JSON.stringify({ floatSession: view.float }));
        if (view.float === "bar") localStorage.setItem("agora.float.bar", JSON.stringify({ width: 780, height: null, expanded: false, folded: false, ...view.bar }));
      },
      [theme, c.view],
    );
    const page = await ctx.newPage();
    await page.route("**/api/**", (r) => (r.request().method() === "GET" ? r.continue() : r.abort()));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector(".canvas-view") && document.querySelector(".dock"));
    if (c.view.canvasMax) await page.addStyleTag({ content: `[data-pane] .canvas-layers { max-width: ${c.view.canvasMax}px; }` });
    await page.waitForTimeout(1500);
    const m = await groupCentres(page);
    const bad: string[] = [];
    const mid = (x: Span | null) => (x ? (x.l + x.r) / 2 : NaN);
    if (!m.canvas || !m.dock) bad.push("no canvas or dock on screen");
    else {
      const parts = [m.dock, m.pill].filter((x): x is Span => x !== null);
      const group = (Math.min(...parts.map((x) => x.l)) + Math.max(...parts.map((x) => x.r))) / 2;
      const off = group - mid(m.canvas);
      if (Math.abs(off) > TOL) bad.push(`dock${m.pill ? " + pill" : ""} centre is ${off.toFixed(2)} px off the canvas body's`);
      if (c.pill === "none" && m.pill) bad.push("a pill is on screen");
      if (c.pill !== "none" && !m.pill) bad.push("no pill on screen (does the project have a session?)");
      if (c.pill === "round" && m.pill && m.pill.r - m.pill.l > 40) bad.push(`pill is ${(m.pill.r - m.pill.l).toFixed(0)} px wide, not the round avatar`);
      if (c.pill === "words" && m.pill && m.pill.r - m.pill.l < 96) bad.push("pill lost its words");
      if (c.bar) {
        if (!m.bar) bad.push("no bottom bar on screen");
        else if (Math.abs(mid(m.bar) - mid(m.canvas)) > TOL) bad.push(`bar centre is ${(mid(m.bar) - mid(m.canvas)).toFixed(2)} px off the canvas body's`);
      }
      const others = await page.evaluate(() => [".whole-btn", ".excalidraw .help-icon", ".excalidraw .zoom-actions", ".excalidraw .undo-redo-buttons"].map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && r.width > 0 ? { l: r.left, r: r.right } : null; }));
      const right = Math.max(...parts.map((x) => x.r));
      const left = Math.min(...parts.map((x) => x.l));
      if (others.some((o) => o && o.l < right && o.r > left)) bad.push("the group sits on a neighbouring control");
    }
    console.log(`${bad.length ? "FAIL" : "ok  "} centre ${c.w}×${c.h} ${theme} ${c.name}: canvas ${m.canvas ? `${m.canvas.l.toFixed(1)}–${m.canvas.r.toFixed(1)}` : "-"} | dock ${m.dock ? `${m.dock.l.toFixed(1)}–${m.dock.r.toFixed(1)}` : "-"} | pill ${m.pill ? `${m.pill.l.toFixed(1)}–${m.pill.r.toFixed(1)}` : "-"}${m.bar ? ` | bar ${m.bar.l.toFixed(1)}–${m.bar.r.toFixed(1)}` : ""}${bad.length ? `  ← ${bad.join("; ")}` : ""}`);
    if (bad.length) failed++;
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
