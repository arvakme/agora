// What the share window shows for "which address": the account's zones (server/canvas/share.py `domains()`),
// the one picked last time, the one AGORA_SHARE_DOMAIN fixes, or a temporary link that needs no domain. Pure.

export type DomainInfo = { domains: string[]; chosen: string | null; fixed: boolean; error: string | null };
export type ShareTarget = "domain" | "quick";
export type DomainView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "none" }
  | { kind: "fixed"; domain: string }
  | { kind: "single"; domain: string }
  | { kind: "pick"; options: string[]; selected: string };

/** `picked`: what the person chose in this window (wins over the remembered choice while it is still in the list). */
export function domainView(info: DomainInfo | null, picked: string | null): DomainView {
  if (!info) return { kind: "loading" };
  if (info.error) return { kind: "error", message: info.error };
  if (info.fixed && info.domains[0]) return { kind: "fixed", domain: info.domains[0] };
  if (info.domains.length === 0) return { kind: "none" };
  if (info.domains.length === 1) return { kind: "single", domain: info.domains[0] };
  const selected = [picked, info.chosen].find((d): d is string => !!d && info.domains.includes(d)) ?? info.domains[0];
  return { kind: "pick", options: info.domains, selected };
}

/** Whether 创建链接 can go, and what it sends besides the canvas and the times. */
export function createPlan(view: DomainView, target: ShareTarget): { ok: true; body: { quick?: true; domain?: string } } | { ok: false } {
  if (target === "quick") return { ok: true, body: { quick: true } };
  if (view.kind === "pick") return { ok: true, body: { domain: view.selected } };
  if (view.kind === "fixed" || view.kind === "single") return { ok: true, body: {} };
  return { ok: false };
}

/** Start on the temporary link when the domain side cannot work right now. */
export const defaultTarget = (view: DomainView): ShareTarget => (view.kind === "error" || view.kind === "none" ? "quick" : "domain");
