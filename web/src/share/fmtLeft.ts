import { tr } from "../i18n";

/** Time left on a share link: the owner's share panel and the guest page both say it this way. */
export function fmtLeft(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return tr(`${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`, `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);
  if (s >= 3600) return tr(`${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`, `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  if (s >= 60) return tr(`${Math.floor(s / 60)} 分 ${s % 60} 秒`, `${Math.floor(s / 60)}m ${s % 60}s`);
  return tr(`${s} 秒`, `${s}s`);
}
