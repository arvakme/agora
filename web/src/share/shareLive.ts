// What the share window says about a link that was just made, and what the owner may still change on it (SharePanel.tsx). Pure.

/** A new link on the owner's own domain is not reachable at once: its DNS record takes about this long to be seen everywhere. */
export const DNS_WAIT_MS = 30_000;

/**
 * Whether a link is still in its DNS wait, and the words for it: 「链接刚建好，约 30 秒后可访问」 with the seconds left — no pretending it works yet, and
 * nothing said once the time has passed (it should work; if it does not, that is something else). A temporary link (`quick`) has no DNS record of its own.
 */
export function dnsWait(row: { createdAt: number; quick?: boolean; status?: string }, now: number): { waiting: boolean; leftS: number; text: string } {
  const left = row.createdAt + DNS_WAIT_MS - now;
  if (row.quick || (row.status && row.status !== "active") || left <= 0) return { waiting: false, leftS: 0, text: "" };
  const s = Math.ceil(left / 1000);
  return { waiting: true, leftS: s, text: `链接刚建好，约 30 秒后可访问（还剩 ${s} 秒）` };
}

/** The switch the owner flips on a share that exists: what to ask the server, and the words next to it. */
export const buildSwitch = (row: { buildReplay?: boolean }): { on: boolean; label: string; body: { buildReplay: boolean } } => ({
  on: !!row.buildReplay,
  label: row.buildReplay ? "访客可以看搭建过程（点一下关掉）" : "访客看不到搭建过程（点一下打开）",
  body: { buildReplay: !row.buildReplay },
}) as { on: boolean; label: string; body: { buildReplay: boolean } };
