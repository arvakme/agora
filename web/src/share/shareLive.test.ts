// The owner's share window: the wait before a new link works, and the switch that can be flipped after the link was made.
import { describe, expect, it } from "vitest";
import { buildSwitch, DNS_WAIT_MS, dnsWait } from "./shareLive";

describe("dnsWait: a link on the owner's domain is not reachable for about 30 s", () => {
  const row = { createdAt: 1_000_000, status: "active" };
  it("right after it was made it says so, with the seconds left — not that it works", () => {
    const w = dnsWait(row, 1_000_000);
    expect(w).toEqual({ waiting: true, leftS: 30, text: "链接刚建好，约 30 秒后可访问（还剩 30 秒）" });
    expect(dnsWait(row, 1_000_000 + 12_400).leftS).toBe(18);
    expect(dnsWait(row, 1_000_000 + DNS_WAIT_MS - 1).leftS).toBe(1);
  });
  it("counts down to nothing: after the time there is no note", () => {
    expect(dnsWait(row, 1_000_000 + DNS_WAIT_MS)).toEqual({ waiting: false, leftS: 0, text: "" });
    expect(dnsWait(row, 9_000_000).waiting).toBe(false);
  });
  it("a temporary link and an ended share have no DNS wait to speak of", () => {
    expect(dnsWait({ ...row, quick: true }, 1_000_000).waiting).toBe(false);
    expect(dnsWait({ ...row, status: "revoked" }, 1_000_000).waiting).toBe(false);
  });
});

describe("buildSwitch: watching how it was built, changeable after sharing", () => {
  it("shows what it is now and asks the server for the opposite", () => {
    expect(buildSwitch({ buildReplay: true })).toMatchObject({ on: true, body: { buildReplay: false } });
    expect(buildSwitch({ buildReplay: false })).toMatchObject({ on: false, body: { buildReplay: true } });
    expect(buildSwitch({})).toMatchObject({ on: false, body: { buildReplay: true } }); // a share made before the option
    expect(buildSwitch({ buildReplay: true }).label).toContain("可以看");
    expect(buildSwitch({ buildReplay: false }).label).toContain("看不到");
  });
});
