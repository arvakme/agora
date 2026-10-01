// The 域名 line of the share window as the person meets it: the domain in use, a select to change it, and in the states with no domain one sentence instead.
// What each state says: domainChoice.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DomainRow } from "./DomainRow";
import { domainView, type DomainInfo } from "./domainChoice";

const info = (o: Partial<DomainInfo>): DomainInfo => ({ domains: [], chosen: null, fixed: false, error: null, ...o });
const html = (i: DomainInfo | null, picked: string | null = null) => renderToStaticMarkup(<DomainRow view={domainView(i, picked)} onPick={() => {}} />);

describe("DomainRow", () => {
  const several = info({ domains: ["quietharbor.de", "example.org"], chosen: "quietharbor.de" });

  it("shows the domain in use, a select named after it, every domain in it (the one in use marked) and the preview", () => {
    const out = html(several);
    expect(out).toContain("域名");
    expect(out).toMatch(/<code[^>]*>quietharbor\.de<\/code>/);
    expect(out).toMatch(/<select[^>]*aria-label="[^"]*quietharbor\.de[^"]*"/);
    expect(out).toContain(">换一个</option>");
    expect(out).toContain(">quietharbor.de（当前）</option>");
    expect(out).toContain(">example.org</option>");
    expect(out).toContain("xxx.quietharbor.de");
  });

  it("a single domain has nothing to change", () => {
    const out = html(info({ domains: ["only.test"] }));
    expect(out).toMatch(/<code[^>]*>only\.test<\/code>/);
    expect(out).not.toContain("<select");
  });

  it("while reading the account: one waiting line, no empty select", () => {
    const out = html(null);
    expect(out).toContain("正在读取");
    expect(out).not.toContain("<select");
  });

  it("a failure keeps the sentence the server wrote, as an alert", () => {
    expect(html(info({ error: "还没登录 Cloudflare" }))).toMatch(/role="alert"[^>]*>还没登录 Cloudflare/);
  });

  it("an account without domains says so", () => {
    expect(html(info({}))).toContain("没有域名");
  });
});
