import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLive } from "./live";

class FakeSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  send(ev: object) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
}

describe("openLive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays on the stream once hello arrives, and never polls", () => {
    const src = new FakeSource();
    const poll = vi.fn(async () => {});
    const onEvent = vi.fn();
    openLive({ onEvent, poll, open: () => src });
    src.send({ t: "hello" });
    vi.advanceTimersByTime(60_000);
    src.send({ t: "threads", canvasId: "c1" });
    expect(poll).not.toHaveBeenCalled();
    expect(src.closed).toBe(false);
    expect(onEvent).toHaveBeenCalledWith({ t: "threads", canvasId: "c1" });
  });

  it("falls back to polling when a buffering tunnel never delivers hello", () => {
    const src = new FakeSource();
    const poll = vi.fn(async () => {});
    openLive({ onEvent: vi.fn(), poll, open: () => src, helloMs: 5000, pollMs: 4000 });
    vi.advanceTimersByTime(4999);
    expect(src.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(src.closed).toBe(true);
    vi.advanceTimersByTime(12_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after a failed poll, and stops when closed", async () => {
    const poll = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const close = openLive({ onEvent: vi.fn(), poll, open: () => new FakeSource(), helloMs: 10, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(10 + 250);
    expect(poll).toHaveBeenCalledTimes(2);
    close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});
