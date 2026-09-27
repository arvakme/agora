// Spacing invariant for agent-added boxes (add_shape and library components).
import { describe, expect, it } from "vitest";
import { boxGap, clearSpot, MIN_GAP, obstaclesFor, type Box } from "./spacing.ts";
import type { El } from "./scene.ts";

const el = (id: string, type: string, x: number, y: number, width = 160, height = 64, extra: Record<string, unknown> = {}) =>
  ({ id, type, x, y, width, height, isDeleted: false, ...extra }) as unknown as El;

// The eval fixture's neighbourhood around T7 ("a TODO box below 浏览器").
const fixture = [
  el("browser", "rectangle", 60, 220),
  el("backend", "rectangle", 320, 220),
  el("postgres", "rectangle", 200, 400),
  el("redis", "rectangle", 440, 400),
  el("e-browser-backend", "arrow", 226, 252, 88, 0),
  el("postgres-label", "text", 240, 420, 80, 20, { containerId: "postgres" }),
  el("tmux", "frame", 760, 370, 460, 150),
];
const ALL = ["below", "right", "left", "above"] as const;
const clearOf = (b: Box, obstacles: Box[]) => obstacles.every((o) => boxGap(b, o) >= MIN_GAP);

describe("clearSpot", () => {
  it("keeps a position that is already clear", () => {
    expect(clearSpot({ x: 60, y: 300, w: 160, h: 64 }, obstaclesFor(fixture), ALL)).toEqual({ x: 60, y: 300 });
  });

  it("T7 regression: a TODO box on top of Postgres moves to the nearest clear spot, still below 浏览器", () => {
    const obstacles = obstaclesFor(fixture);
    const at = clearSpot({ x: 60, y: 340, w: 160, h: 64 }, obstacles, ALL);
    const box = { ...at, w: 160, h: 64 };
    expect(clearOf(box, obstacles)).toBe(true);
    expect(at.y).toBeGreaterThanOrEqual(220 + 64); // still below the browser box
    expect(Math.hypot(at.x - 60, at.y - 340)).toBeLessThanOrEqual(64); // smallest nudge, not a jump
  });

  it("ignores arrows, bound labels and the frame the box goes into; nesting in a container is allowed", () => {
    const inFrame = clearSpot({ x: 1210, y: 410, w: 160, h: 64 }, obstaclesFor(fixture, { frameId: "tmux" }), ALL);
    expect(inFrame).toEqual({ x: 1210, y: 410 }); // frame grows to fit, not an obstacle
    const nested = clearSpot({ x: 790, y: 400, w: 100, h: 40 }, obstaclesFor(fixture), ALL);
    expect(nested).toEqual({ x: 790, y: 400 }); // fully inside tmux with room
    const crossesBorder = clearSpot({ x: 700, y: 400, w: 100, h: 40 }, obstaclesFor(fixture), ALL);
    expect(crossesBorder).not.toEqual({ x: 700, y: 400 });
  });

  it("slides only along the given side for side-anchored inserts", () => {
    const at = clearSpot({ x: 360, y: 220, w: 100, h: 64 }, obstaclesFor(fixture), ["right"]);
    expect(at.y).toBe(220);
    expect(at.x).toBeGreaterThanOrEqual(320 + 160 + MIN_GAP);
  });
});
