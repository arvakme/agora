// The 域名 line of the share window: the label, the domain in use and 换一个 on one row, and one short sentence under it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DomainRow } from "./DomainRow";
import { domainView, type DomainInfo } from "./domainChoice";

const info = (o: Partial<DomainInfo>): DomainInfo => ({ domains: [], chosen: null, fixed: false, error: null, ...o });
const html = (i: DomainInfo | null, picked: string | null = null) => renderToStaticMarkup(<DomainRow view={domainView(i, picked)} onPick={() => {}} />);

describe("DomainRow", () => {
  const several = info({ domains: ["quietharbor.de", "example.org"], chosen: "quietharbor.de" });

  it("puts 域名, the domain in use and 换一个 in one row, the preview under it", () => {
    const out = html(several);
    expect(out).toMatch(/^<div class="share-field share-domain"><span>域名<\/span>/);
    expect(out).toContain('<code class="share-domain-now" title="quietharbor.de">quietharbor.de</code>');
    expect(out).toMatch(/<select[^>]*aria-label="换一个域名（现在是 quietharbor.de）"/);
    expect(out).toContain(">换一个</option>");
    expect(out).toContain("链接会是 xxx.quietharbor.de");
  });

  it("lists every domain, the one in use marked", () => {
    const out = html(several);
    expect(out).toContain(">quietharbor.de（当前）</option>");
    expect(out).toContain(">example.org</option>");
  });

  it("a single domain has nothing to change", () => {
    const out = html(info({ domains: ["only.test"] }));
    expect(out).toContain('<code class="share-domain-now" title="only.test">only.test</code>');
    expect(out).not.toContain("<select");
    expect(out).toContain("链接会是 xxx.only.test");
  });

  it("while reading the account: the label and one waiting line, no empty select", () => {
    const out = html(null);
    expect(out).toContain("<span>域名</span>");
    expect(out).toContain("正在读取你的 Cloudflare 域名…");
    expect(out).not.toContain("<select");
  });

  it("a failure keeps the sentence the server wrote, as an alert", () => {
    expect(html(info({ error: "还没登录 Cloudflare" }))).toMatch(/role="alert"[^>]*>还没登录 Cloudflare/);
  });

  it("an account without domains says so", () => {
    expect(html(info({}))).toContain("这个 Cloudflare 账号里没有域名。可以先用临时链接。");
  });
});
