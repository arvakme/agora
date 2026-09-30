// 姿势体检: every pose, gesture, pose change, trip and door ladder of the 小人, frame by frame, against the rules of
// src/workstation/poseHealth.ts (web/docs/workstation.md §小人 · 姿势体检). No browser: it runs `solve` (src/workstation/rig.ts)
// itself. Run it after every change to the animation:
//
//   cd web && npx vite-node scripts/pose-check.ts                      the frames that break a rule, by scenario (exit 1 if any)
//   (the default report includes elbows: one that steps more than 7 figure units in a frame, 3 while walking, has flipped)
//   npx vite-node scripts/pose-check.ts --frames                       every bad frame, not just the first of a run
//   npx vite-node scripts/pose-check.ts --pops                         one-frame jumps and pops of a joint too
//   npx vite-node scripts/pose-check.ts --speed out.svg                the root's speed along every trip and door (yellow: standing before the first step; red: a dip to rest inside the trip) + a table
//   npx vite-node scripts/pose-check.ts --gait out.svg                the changes of hands and feet a second along every ladder climbed (a curve each, the limit drawn) + a table
//   npx vite-node scripts/pose-check.ts --sheet out.svg [--match text] [--every 100] [--from ms] [--to ms] [--cols 12]
//                                                                      contact sheet (a frame per --every ms; red = breaks a rule);
//                                                                      out.png as well when rsvg-convert is installed
//
// `--match` picks scenarios by a substring of "scenario | label" (e.g. --match "door" or --match "sit down").
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { ACCEL_MAX, checkJoints, ELBOW_MAX, ELBOW_MAX_WALKING, elbowJumps, frames, gaits, HIP_SHAKE_MAX, jumps, layerJumps, RUNG_OFF_MAX, snaps, speeds, standRange, SWAP_MAX, sweep, type Frame } from "../src/workstation/poseHealth";
import { ladderShape } from "../src/workstation/hatch";
import { RIG } from "../src/workstation/rig";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const has = (name: string) => args.includes(name);
const match = opt("--match");
const all = frames().filter((f) => !match || `${f.scenario} | ${f.label}`.includes(match));

// ——— the drawing (a contact sheet) ———
const U = 2.2; // px per figure unit
const W = 150;
const H = 150;
const GROUND = 132;
const f2 = (n: number) => Math.round(n * 100) / 100;
const K = RIG.torso / 16.4;

function figure(fr: Frame, bad: boolean): string {
  const j = fr.joints;
  const ink = bad ? "#c0392b" : "#333";
  const line = (x1: number, y1: number, x2: number, y2: number, w: number, c: string) => `<line x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}" stroke="${c}" stroke-width="${f2(w)}" stroke-linecap="round"/>`;
  const limb = (r: { x: number; y: number }, b: { jx: number; jy: number; ex: number; ey: number }, w1: number, w2: number, c: string) => line(r.x, r.y, b.jx, b.jy, w1, c) + line(b.jx, b.jy, b.ex, b.ey, w2, c);
  const far = bad ? "#e6a8a0" : "#aaa";
  const foot = (b: { ex: number; ey: number }, c: string) => line(b.ex, b.ey - RIG.ankle, b.ex + RIG.foot * j.f, b.ey - RIG.ankle, 3.2 * K, c);
  const parts = [
    limb(j.shF, j.armF, 4 * K, 3.6 * K, far),
    limb(j.hipF, j.legF, 4.7 * K, 4.3 * K, far),
    foot(j.legF, far),
    line(j.px, j.py, j.nx, j.ny, 9.2 * K, ink),
    limb(j.hipN, j.legN, 4.7 * K, 4.3 * K, ink),
    foot(j.legN, ink),
    limb(j.shN, j.armN, 4 * K, 3.6 * K, ink),
    `<circle cx="${f2(j.hx)}" cy="${f2(j.hy)}" r="${RIG.head}" fill="#fff" stroke="${ink}" stroke-width="1.4"/>`,
  ].join("");
  const s = (j.scale ?? 1) * U;
  const sx = Math.max(-1, Math.min(1, j.turn));
  // a trip's root is in world px from the floor line it started at (a door's ladder: the figure is cut off at the floor line / one figure's height above it)
  const rootY = fr.ladder ? j.root.y / fr.k : 0;
  return `<g transform="translate(${W / 2} ${f2(GROUND + rootY * U - (j.lift ?? 0) * U)}) scale(${f2(s * sx)} ${f2(s)})">${parts}</g>`;
}

function tile(fr: Frame, i: number, cols: number): string {
  const issues = checkJoints(fr.joints, fr.expect);
  const bad = issues.length > 0;
  const x = (i % cols) * W;
  const y = Math.floor(i / cols) * (H + 12);
  const dir = fr.ladder?.dir;
  // door: rails on the parent canvas stand HATCH_POST above the floor; on the sub-diagram they hang from one figure's height above it
  const top = dir === 1 ? -34 : dir === -1 ? -50 : null;
  const bottom = dir === 1 ? 50 : 0;
  // the rungs, the ones the hands and feet hold (hatch.ts `ladderShape`; the ladder goes on below the floor line where the body is cut off)
  const shape = dir ? ladderShape(dir) : null;
  const step = shape && shape.rungs.length > 1 ? shape.rungs[0] - shape.rungs[1] : 0;
  const rungYs: number[] = [];
  if (step && top !== null) for (let y = bottom; y >= top - 1e-6; y -= step) rungYs.push(y);
  const lad = top === null ? "" : [-2.6, 2.6].map((dx) => `<line x1="${f2(W / 2 + dx * U)}" y1="${f2(GROUND + top * U)}" x2="${f2(W / 2 + dx * U)}" y2="${GROUND + bottom * U}" stroke="#666"/>`).join("") + rungYs.map((y) => `<line x1="${f2(W / 2 - 2.6 * U)}" y1="${f2(GROUND + y * U)}" x2="${f2(W / 2 + 2.6 * U)}" y2="${f2(GROUND + y * U)}" stroke="#999"/>`).join("");
  const cut = dir === 1 ? `<clipPath id="c${i}"><rect x="0" y="0" width="${W}" height="${GROUND}"/></clipPath>` : dir === -1 ? `<clipPath id="c${i}"><rect x="0" y="${GROUND - 50 * U}" width="${W}" height="${H}"/></clipPath>` : "";
  const fig = figure(fr, bad);
  return `<g transform="translate(${x} ${y})"><rect width="${W}" height="${H}" fill="${bad ? "#fff5f3" : "#fff"}" stroke="#ddd"/><rect x="0" y="${GROUND}" width="${W}" height="${H - GROUND}" fill="#eef0f3"/>${cut}${lad}<g${cut ? ` clip-path="url(#c${i})"` : ""}>${fig}</g><line x1="0" y1="${GROUND}" x2="${W}" y2="${GROUND}" stroke="#111" stroke-width="1.5"/><text x="4" y="11" font-size="9" font-family="monospace" fill="#555">${fr.t | 0} ms${bad ? " · " + issues.map((n) => n.rule).join(",") : ""}</text></g>`;
}

function sheet(fs: Frame[], cols: number, out: string) {
  const rows = Math.ceil(fs.length / cols);
  const body = fs.map((fr, i) => tile(fr, i, cols)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * W}" height="${rows * (H + 12)}" viewBox="0 0 ${cols * W} ${rows * (H + 12)}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
  writeFileSync(out, svg);
  if (out.endsWith(".svg")) {
    try {
      execFileSync("rsvg-convert", ["-o", out.replace(/\.svg$/, ".png"), out], { stdio: "ignore" });
    } catch {
      /* no rsvg-convert: the svg is the sheet */
    }
  }
}

// ——— the speed curves ———
const speedOut = opt("--speed");
if (speedOut) {
  const all = speeds();
  let y = 0;
  const rows: string[] = [];
  const W2 = 900;
  const Hh = 90;
  for (const sp of all) {
    const t0 = sp.samples[0]?.t ?? 0;
    const t1 = sp.samples[sp.samples.length - 1]?.t ?? 1;
    const X = (t: number) => 40 + ((t - t0) / Math.max(1, t1 - t0)) * (W2 - 60);
    const top = Math.max(0.25, sp.maxV);
    const Y = (v: number) => y + Hh - 14 - (v / top) * (Hh - 34);
    const d = sp.samples.map((s, i) => `${i ? "L" : "M"}${X(s.t).toFixed(1)} ${Y(s.v).toFixed(1)}`).join("");
    const stops = sp.dips.map((t) => `<line x1="${X(t).toFixed(1)}" y1="${y + 16}" x2="${X(t).toFixed(1)}" y2="${y + Hh - 14}" stroke="#d9534f" stroke-width="2" opacity="0.7"/>`).join("") + `<rect x="40" y="${y + 16}" width="${(X(t0 + sp.setOff) - 40).toFixed(1)}" height="${Hh - 30}" fill="#f3e3b0" opacity="0.6"/>`;
    rows.push(`<g>${stops}<line x1="40" y1="${Y(0)}" x2="${W2 - 20}" y2="${Y(0)}" stroke="#bbb"/><path d="${d}" fill="none" stroke="#2c3136" stroke-width="1.4"/><text x="40" y="${y + 11}" font-size="11" font-family="monospace" fill="#222">${sp.name} · ${(t1 - t0) | 0} ms · top ${sp.maxV.toFixed(3)} px/ms · steepest ${(sp.maxAccel * 1e6).toFixed(0)} px/s² · stands ${sp.setOff | 0} ms before the first step · ${sp.dips.length} dip${sp.dips.length === 1 ? "" : "s"} to rest${sp.dips.map((t) => ` @${t | 0}`).join("")}</text></g>`);
    console.log(`${sp.name.padEnd(46)} ${String((t1 - t0) | 0).padStart(6)} ms  top ${sp.maxV.toFixed(3)} px/ms  steepest change ${(sp.maxAccel * 1e6).toFixed(0).padStart(4)} px/s²  stands ${String(sp.setOff | 0).padStart(4)} ms first  dips to rest ${sp.dips.length}${sp.dips.map((t) => ` @${t | 0}`).join("")}`);
    y += Hh;
  }
  writeFileSync(speedOut, `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${y}" viewBox="0 0 ${W2} ${y}"><rect width="100%" height="100%" fill="#fff"/>${rows.join("")}</svg>`);
  if (speedOut.endsWith(".svg")) {
    try {
      execFileSync("rsvg-convert", ["-o", speedOut.replace(/\.svg$/, ".png"), speedOut], { stdio: "ignore" });
    } catch {
      /* the svg is the chart */
    }
  }
  process.exit(0);
}

// ——— the gait on ladders ———
const gaitOut = opt("--gait");
if (gaitOut) {
  let y = 0;
  const rows: string[] = [];
  const W2 = 900;
  const Hh = 80;
  const top = 24;
  for (const g of gaits()) {
    const X = (t: number) => 40 + (t / Math.max(1, g.ms)) * (W2 - 60);
    const Y = (r: number) => y + Hh - 14 - (Math.min(r, top) / top) * (Hh - 34);
    // a change's rate holds from that change to the next
    const d = g.rates.map((r, i) => `${i ? "L" : "M"}${X(r.t - g.swaps[0]).toFixed(1)} ${Y(r.rate).toFixed(1)}`).join("");
    const dots = g.swaps.map((t) => `<circle cx="${X(t - g.swaps[0]).toFixed(1)}" cy="${y + Hh - 14}" r="2" fill="#555"/>`).join("");
    rows.push(`<g><line x1="40" y1="${Y(SWAP_MAX)}" x2="${W2 - 20}" y2="${Y(SWAP_MAX)}" stroke="#2f9e44" stroke-dasharray="4 3"/><line x1="40" y1="${Y(0)}" x2="${W2 - 20}" y2="${Y(0)}" stroke="#bbb"/><path d="${d}" fill="none" stroke="${g.maxRate > SWAP_MAX ? "#d9534f" : "#2c3136"}" stroke-width="1.4"/>${dots}<text x="40" y="${y + 11}" font-size="11" font-family="monospace" fill="#222">${g.name} · ${g.ms | 0} ms · ${g.swaps.length} changes · fastest ${g.maxRate.toFixed(1)}/s (limit ${SWAP_MAX}, green)</text></g>`);
    console.log(`${g.name.padEnd(48)} ${String(g.ms | 0).padStart(5)} ms  changes ${String(g.swaps.length).padStart(2)}  fastest ${g.maxRate.toFixed(1).padStart(5)}/s  off a rung ${g.offRung.toFixed(2)}  hips shake ${g.hipShake.toFixed(2)}  on ladders ${g.climbMs | 0} ms`);
    y += Hh;
  }
  writeFileSync(gaitOut, `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${y}" viewBox="0 0 ${W2} ${y}"><rect width="100%" height="100%" fill="#fff"/>${rows.join("")}</svg>`);
  try {
    execFileSync("rsvg-convert", ["-o", gaitOut.replace(/\.svg$/, ".png"), gaitOut], { stdio: "ignore" });
  } catch {
    /* the svg is the chart */
  }
  process.exit(0);
}

// ——— the sheet ———
const sheetOut = opt("--sheet");
if (sheetOut) {
  const every = Number(opt("--every", "100"));
  const from = Number(opt("--from", "-Infinity"));
  const to = Number(opt("--to", "Infinity"));
  let last = -Infinity;
  const pick = all.filter((f) => {
    if (f.t < from || f.t > to) return false;
    if (f.t - last >= every - 1e-6) {
      last = f.t;
      return true;
    }
    return false;
  });
  sheet(pick, Number(opt("--cols", "12")), sheetOut);
  console.log(`${pick.length} frames → ${sheetOut}`);
  process.exit(0);
}

// ——— the report ———
const found = sweep(all);
const group = new Map<string, { first: Frame; last: Frame; n: number; details: Set<string> }>();
for (const { frame, issues } of found) {
  for (const i of issues) {
    const key = `${frame.scenario} | ${frame.label} | ${i.rule}`;
    const g = group.get(key) ?? { first: frame, last: frame, n: 0, details: new Set() };
    g.n++;
    g.last = frame;
    if (g.details.size < 2) g.details.add(i.detail);
    group.set(key, g);
    if (has("--frames")) console.log(`  ${frame.scenario} | ${frame.label} | t ${frame.t} | ${i.rule}: ${i.detail}`);
  }
}
console.log(`${all.length} frames checked, ${found.length} break a rule`);
for (const [key, g] of [...group].sort((a, b) => b[1].n - a[1].n)) console.log(`${String(g.n).padStart(5)} × ${key} · t ${g.first.t}…${g.last.t} · ${[...g.details].join(" / ")}`);
// the elbow never flips to the other side of the arm (one frame's step over ELBOW_MAX; walking over ELBOW_MAX_WALKING)
const flips = [...elbowJumps(all), ...elbowJumps(all.filter((f) => f.label.includes("walk")), ELBOW_MAX_WALKING)];
console.log(`${flips.length} elbow flips (one frame's step > ${ELBOW_MAX} figure units, > ${ELBOW_MAX_WALKING} while walking)`);
for (const x of flips.slice(0, 20)) console.log(`  ${x.a.scenario} | ${x.a.label} | t ${x.a.t}→${x.b.t} | ${x.arm} elbow moved ${x.d.toFixed(1)}`);
// the blends between layers: no joint jumps more than 5 figure units in a frame; the standing pose's own motion is small; no trip speeds up or slows harder than ACCEL_MAX or stops inside
const lj = layerJumps(all);
console.log(`${lj.length} jumps in the blends between layers (> 5 figure units in a frame)`);
for (const x of lj.slice(0, 10)) console.log(`  ${x.a.label} | t ${x.a.t}→${x.b.t} | ${x.joint} moved ${x.d.toFixed(1)}`);
const range = standRange(all.filter((f) => f.scenario === "stand" && f.label.startsWith("idle")));
const rangeBad = range.hips > 1.5 || range.sway > 2.5 || range.tilt > 10;
console.log(`standing: hips move ${range.hips.toFixed(2)}, body sways ${range.sway.toFixed(2)}, head tips ${range.tilt.toFixed(1)}°${rangeBad ? "  ← too much" : ""}`);
const fast = speeds().filter((s) => s.maxAccel > ACCEL_MAX || s.dips.length);
console.log(`${fast.length} trips change speed faster than ${ACCEL_MAX * 1e6} px/s² or dip to rest inside`);
for (const s of fast) console.log(`  ${s.name}: steepest ${(s.maxAccel * 1e6).toFixed(0)} px/s², dips ${s.dips.join(",") || "none"}`);
// the ladder: a diagonal pair changes over at most SWAP_MAX times a second; a hand or foot on a rung is within RUNG_OFF_MAX of it; the hips do not shake
const climbs = gaits().filter((g) => g.maxRate > SWAP_MAX || g.offRung > RUNG_OFF_MAX || g.hipShake > HIP_SHAKE_MAX);
console.log(`${climbs.length} ladders climbed with hands and feet changing over faster than ${SWAP_MAX}/s, off their rungs by more than ${RUNG_OFF_MAX}, or with hips shaking more than ${HIP_SHAKE_MAX}`);
for (const g of climbs) console.log(`  ${g.name}: fastest ${g.maxRate.toFixed(1)}/s, off a rung ${g.offRung.toFixed(2)}, hips ${g.hipShake.toFixed(2)}`);
let failed = climbs.length > 0 || found.length > 0 || flips.length > 0 || lj.length > 0 || rangeBad || fast.length > 0;
if (has("--pops")) {
  const j = jumps(all);
  console.log(`${j.length} one-frame jumps (> 10 figure units in 16 ms)`);
  for (const x of j.slice(0, 40)) console.log(`  ${x.a.scenario} | ${x.a.label} | t ${x.a.t}→${x.b.t} | ${x.joint} moved ${x.d.toFixed(1)}`);
  const s = snaps(all);
  console.log(`${s.length} pops (a joint's step changes by > 2.5 units from one frame to the next; for reading, they do not fail the run)`);
  for (const x of s.slice(0, 40)) console.log(`  ${x.a.scenario} | ${x.a.label} | t ${x.a.t}→${x.b.t} | ${x.joint} ${x.d.toFixed(1)}`);
  failed = failed || j.length > 0; // the pops are for reading: a gait's foot swings and a climb's rung changes are in them
}
process.exit(failed ? 1 : 0);
