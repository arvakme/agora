// A failed load is not remembered (session/retryable.ts).
import { describe, expect, it } from "vitest";
import { retryable } from "./retryable.ts";

describe("retryable", () => {
  it("a failure is forgotten: the next call asks again and can succeed", async () => {
    let calls = 0;
    const get = retryable(async () => {
      if (++calls === 1) throw new Error("503");
      return "models";
    });
    await expect(get()).rejects.toThrow("503");
    await expect(get()).resolves.toBe("models");
    expect(calls).toBe(2);
  });
  it("a success is kept (no second request)", async () => {
    let calls = 0;
    const get = retryable(async () => (++calls, "ok"));
    await get();
    await get();
    expect(calls).toBe(1);
  });
  it("calls in flight share one request", async () => {
    let calls = 0;
    const get = retryable(async () => (++calls, "ok"));
    await Promise.all([get(), get(), get()]);
    expect(calls).toBe(1);
  });
  it("a failed request does not clear a newer one", async () => {
    let n = 0;
    const gates: ((ok: boolean) => void)[] = [];
    const get = retryable(() => new Promise<string>((res, rej) => { n++; gates.push((ok) => (ok ? res("ok") : rej(new Error("x")))); }));
    const first = get();
    first.catch(() => {});
    gates[0](false);
    await first.catch(() => {});
    const second = get();
    expect(n).toBe(2);
    gates[1](true);
    await expect(second).resolves.toBe("ok");
    await expect(get()).resolves.toBe("ok");
    expect(n).toBe(2);
  });
});
