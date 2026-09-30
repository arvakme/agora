// The one frame loop's clock: every frame runs the jobs at the frame's own timestamp, and the time
// the jobs see never goes backwards — also when data lands (frame.flush) after a frame began but
// before it ran. A figure reads a step back in time as a jump: its springs reset and a turn in
// progress is cut short (web/docs/workstation.md §5).
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("a flush between two frames never puts the jobs' clock past the next frame", async () => {
  let wall = 1000; // performance.now()
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {} });
  vi.stubGlobal("window", { setInterval: () => 0 });
  vi.spyOn(performance, "now").mockImplementation(() => wall);
  const { frame } = await import("./frame.ts");
  const seen: number[] = [];
  frame.add((now) => seen.push(now - performance.timeOrigin));
  const paint = (ts: number) => frames.shift()!(ts);

  paint(1000);
  wall = 1020; // the next frame began at 1017; data lands before it runs
  frame.flush();
  paint(1017);

  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.at(-1)).toBeCloseTo(1017);
});
