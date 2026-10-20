// The 域名 line of the share window (SharePanel.tsx): the label, the domain in use and 换一个 on one row, and under
// them one short sentence on what the link will look like. Its words come from ./domainChoice.ts `domainRow`.
import { domainRow, type DomainView } from "./domainChoice";
import { tr } from "../i18n";

export function DomainRow({ view, onPick }: { view: DomainView; onPick: (domain: string) => void }) {
  const row = domainRow(view);
  const note = view.kind === "loading" ? <em>{tr("正在读取你的 Cloudflare 域名…", "Loading your Cloudflare domains…")}</em> : view.kind === "error" ? <em role="alert">{view.message}</em> : view.kind === "none" ? <em>{tr("这个 Cloudflare 账号里没有域名。可以先用临时链接。", "This Cloudflare account has no domains. You can use a temporary link for now.")}</em> : null;
  return (
    <div className="share-field share-domain">
      <span>{tr("域名", "Domain")}</span>
      {note ?? (
        <div className="share-domain-body">
          <div className="share-domain-line">
            <code className="share-domain-now" title={row.current ?? undefined}>{row.current}</code>
            {row.change && (
              // the select always shows 换一个 (its value is never one of the domains); picking one changes the domain and it goes back to 换一个
              <select className="share-domain-change" value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={tr(`换一个域名（现在是 ${row.current}）`, `Change domain (now ${row.current})`)}>
                <option value="" disabled hidden>{row.change.label}</option>
                {row.change.options.map((d) => <option key={d} value={d}>{d === row.current ? tr(`${d}（当前）`, `${d} (current)`) : d}</option>)}
              </select>
            )}
          </div>
          <small>{row.preview}</small>
        </div>
      )}
    </div>
  );
}
