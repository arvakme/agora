// What the share window shows for the domain (share/domainChoice.ts): the account's zones, the last pick, the environment's, or a temporary link.
import { describe, expect, it } from "vitest";
import { createPlan, defaultTarget, domainView, type DomainInfo } from "./domainChoice.ts";

const info = (o: Partial<DomainInfo>): DomainInfo => ({ domains: [], chosen: null, fixed: false, error: null, ...o });

describe("domainView", () => {
  it("shows nothing decided while the zones are still being read", () => {
    expect(domainView(null, null)).toEqual({ kind: "loading" });
  });
  it("one zone is used without asking", () => {
    expect(domainView(info({ domains: ["only.test"], chosen: "only.test" }), null)).toEqual({ kind: "single", domain: "only.test" });
  });
  it("several zones give a list, and the first time nothing is chosen for the person beyond the first entry", () => {
    expect(domainView(info({ domains: ["a.test", "b.test", "c.test"] }), null)).toEqual({ kind: "pick", options: ["a.test", "b.test", "c.test"], selected: "a.test" });
  });
  it("the zone picked last time is selected again", () => {
    expect(domainView(info({ domains: ["a.test", "b.test", "c.test"], chosen: "c.test" }), null)).toMatchObject({ kind: "pick", selected: "c.test" });
  });
  it("what the person picks in this window wins over the remembered one, unless it is not in the list", () => {
    const i = info({ domains: ["a.test", "b.test"], chosen: "a.test" });
    expect(domainView(i, "b.test")).toMatchObject({ selected: "b.test" });
    expect(domainView(i, "gone.test")).toMatchObject({ selected: "a.test" });
  });
  it("a domain fixed by AGORA_SHARE_DOMAIN is not a choice", () => {
    expect(domainView(info({ domains: ["x.test"], chosen: "x.test", fixed: true }), "other.test")).toEqual({ kind: "fixed", domain: "x.test" });
  });
  it("a failure (not logged in, no cf) is shown as the sentence the server wrote", () => {
    expect(domainView(info({ error: "还没登录 Cloudflare：在终端运行 `npx cf auth login`，完成后再点一次" }), null)).toEqual({ kind: "error", message: "还没登录 Cloudflare：在终端运行 `npx cf auth login`，完成后再点一次" });
  });
  it("an account without zones has nothing to share under", () => {
    expect(domainView(info({}), null)).toEqual({ kind: "none" });
  });
});

describe("what 创建链接 sends", () => {
  it("with a domain: the picked zone only when there was a choice", () => {
    expect(createPlan(domainView(info({ domains: ["a.test", "b.test"] }), "b.test"), "domain")).toEqual({ ok: true, body: { domain: "b.test" } });
    expect(createPlan(domainView(info({ domains: ["only.test"], chosen: "only.test" }), null), "domain")).toEqual({ ok: true, body: {} });
    expect(createPlan(domainView(info({ domains: ["x.test"], fixed: true }), null), "domain")).toEqual({ ok: true, body: {} });
  });
  it("a temporary link needs no domain, whatever state the zones are in", () => {
    for (const v of [domainView(null, null), domainView(info({ error: "x" }), null), domainView(info({}), null)]) expect(createPlan(v, "quick")).toEqual({ ok: true, body: { quick: true } });
  });
  it("a domain link cannot be made while loading, on error, or with no zones", () => {
    for (const v of [domainView(null, null), domainView(info({ error: "x" }), null), domainView(info({}), null)]) expect(createPlan(v, "domain").ok).toBe(false);
  });
  it("starts on the temporary link when the domain side cannot work, on the domain otherwise", () => {
    expect(defaultTarget(domainView(info({ error: "x" }), null))).toBe("quick");
    expect(defaultTarget(domainView(info({}), null))).toBe("quick");
    expect(defaultTarget(domainView(info({ domains: ["a.test", "b.test"] }), null))).toBe("domain");
    expect(defaultTarget(domainView(null, null))).toBe("domain");
  });
});
