// The video of a scripts/self-demo.ts take: every recorded frame for as long as it was on screen, at 30 fps, 1920×1080.
//
//   node scripts/self-demo-cut.ts <work dir> <out.mp4> [--gap <s>]
//
// The take is recorded in parts (the overview being drawn; the zoom and the flights), with the screencast stopped in between while
// the child canvases are drawn and the page reloads on the overview: a frame followed by a pause longer than `--gap` seconds
// (default 0.6) across that stop is held for that long instead, so the video cuts straight from one part to the next.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const [work, out] = args;
if (!work || !out) {
  console.error("usage: node scripts/self-demo-cut.ts <work dir> <out.mp4> [--gap <s>]");
  process.exit(2);
}
const gap = args.includes("--gap") ? Number(args[args.indexOf("--gap") + 1]) : 0.6;
const take = JSON.parse(readFileSync(join(work, "take.json"), "utf8")) as { frames: number[]; marks: Record<string, number> };
const list: string[] = [];
let total = 0;
take.frames.forEach((t, i) => {
  const next = take.frames[i + 1] ?? t + 1500;
  // only the pause where the screencast was stopped is cut; a still screen elsewhere keeps its real length
  const stopped = take.marks.drawn != null && t <= take.marks.drawn + 50 && next >= (take.marks.zoom ?? Infinity) - 5000;
  const d = Math.max(0.001, (next - t) / 1000);
  const dd = stopped ? Math.min(gap, d) : d;
  total += dd;
  list.push(`file 'frames/${String(i).padStart(5, "0")}.jpg'`, `duration ${dd.toFixed(4)}`);
});
list.push(`file 'frames/${String(take.frames.length - 1).padStart(5, "0")}.jpg'`);
writeFileSync(join(work, "list.txt"), list.join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", out]);
console.log(`wrote ${out}: ${take.frames.length} frames, ${total.toFixed(1)} s`);
