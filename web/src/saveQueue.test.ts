// The debounced saves of persist.ts (one pending value per key, the latest wins), and what a played turn
// needs of them: while it plays its camera navigates between canvases, which changes the layout the app
// would save (`root.active`) — that is the replay's own temporary view, so the workspace's saves are
// paused for it: what was pending is written first (the layout as it was), nothing is written while
// paused, and saving is back as it was afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaveQueue } from "./saveQueue.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = () => {
  const write = vi.fn();
  const q = createSaveQueue(write);
  return { write, q };
};

describe("debounced saves", () => {
  it("writes the latest value once, after the delay", () => {
    const { write, q } = setup();
    q.save("workspace", () => "a");
    q.save("workspace", () => "b");
    vi.advanceTimersByTime(399);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("workspace", "b");
  });
  it("flushAll sends everything pending now; drop forgets one", () => {
    const { write, q } = setup();
    q.save("workspace", () => 1);
    q.save("canvas:c1", () => 2);
    q.save("canvas:c2", () => 3);
    q.drop("canvas:c2");
    q.flushAll();
    expect(write.mock.calls).toEqual([["workspace", 1], ["canvas:c1", 2]]);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("paused saves (a played turn's temporary view is not the project's layout)", () => {
  it("nothing is written for a paused key while it is paused, however the layout changes", () => {
    const { write, q } = setup();
    q.pause("workspace");
    q.save("workspace", () => "in the sub-diagram");
    vi.advanceTimersByTime(5000);
    q.save("workspace", () => "back in c1");
    vi.advanceTimersByTime(5000);
    q.flushAll();
    expect(write).not.toHaveBeenCalled();
  });
  it("other keys are saved as usual meanwhile", () => {
    const { write, q } = setup();
    q.pause("workspace");
    q.save("canvas:c1", () => "scene");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledWith("canvas:c1", "scene");
  });
  it("what was pending when it paused is written first, as the value was then (the layout as it was)", () => {
    const { write, q } = setup();
    let layout = "c1";
    q.save("workspace", () => layout);
    q.pause("workspace");
    layout = "c-sub"; // the camera goes in
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("workspace", "c1");
  });
  it("after resuming, saving works again", () => {
    const { write, q } = setup();
    q.pause("workspace");
    q.save("workspace", () => "x");
    q.resume("workspace");
    expect(write).not.toHaveBeenCalled();
    q.save("workspace", () => "y");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledWith("workspace", "y");
  });
});
