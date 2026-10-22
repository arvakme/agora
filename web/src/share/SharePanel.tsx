// "分享": share one canvas through the owner's public domain for as long as the owner picks, and
// see / revoke the current shares. Server: /api/share (server/canvas/project_router.py);
// design: web/docs/sharing.md. The link's token is shown once — only its hash is stored.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { IconCopy, IconLock, IconShare } from "../app/icons";
import { SPRING } from "../comments/motion";
import { fmtLeft } from "./fmtLeft";
import { replayText } from "./replayText";
import { buildSwitch, dnsWait } from "./shareLive";
import { DomainRow } from "./DomainRow";
import { createPlan, defaultTarget, domainView, type DomainInfo, type ShareTarget } from "./domainChoice";
import { projectNote, shareLabel, type ProjectSummary, type ShareScope } from "./scope";
import "./share.css";
import { tr } from "../i18n";

export type ShareRow = {
  id: string;
  /** One canvas (and what is nested below it) or every canvas of the project. Records from before the field are "canvas". */
  scope?: ShareScope;
  canvasId: string;
  canvasTitle: string;
  host: string;
  url: string;
  status: "active" | "revoked" | "expired" | "canvas-deleted";
  createdAt: number;
  expiresAt: number | null;
  endedAt: number | null;
  visits: number;
  guests: number;
  comments: number;
  cleanup: string[];
  /** Distinct guests (browsers) that opened it / the limit (null = unlimited). */
  opens: number;
  maxOpens: number | null;
  /** Guests may watch how the canvas was built (chosen when the share was made). */
  buildReplay?: boolean;
  /** A temporary trycloudflare.com address: no DNS record of its own to wait for. */
  quick?: boolean;
};

/** "打开 3/5" or "打开 3" (unlimited). */
export const opensText = (r: Pick<ShareRow, "opens" | "maxOpens">) => (r.maxOpens ? tr(`打开 ${r.opens ?? 0}/${r.maxOpens}`, `Opened ${r.opens ?? 0}/${r.maxOpens}`) : tr(`打开 ${r.opens ?? 0}`, `Opened ${r.opens ?? 0}`));

const DURATIONS = [
  { key: "1h", label: tr("1 小时", "1 hour"), s: 3600 },
  { key: "1d", label: tr("1 天", "1 day"), s: 86400 },
  { key: "7d", label: tr("7 天", "7 days"), s: 7 * 86400 },
  { key: "custom", label: tr("自定义", "Custom"), s: 0 },
  { key: "forever", label: tr("直到撤销", "Never"), s: null },
] as const;
const UNITS = [
  { key: "m", label: tr("分钟", "minutes"), s: 60 },
  { key: "h", label: tr("小时", "hours"), s: 3600 },
  { key: "d", label: tr("天", "days"), s: 86400 },
] as const;

async function api<T>(method: string, path = "", body?: unknown): Promise<T> {
  const r = await fetch(`/api/share${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { detail?: string }).detail ?? `${r.status}`);
  return j as T;
}

export function ShareButton({ canvases, current }: { canvases: { id: string; title: string }[]; current?: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ShareRow[]>([]);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const active = rows.filter((r) => r.status === "active").length;
  const refresh = () => void api<{ shares: ShareRow[]; project: ProjectSummary }>("GET").then((j) => (setRows(j.shares), setSummary(j.project)), () => {});
  useEffect(() => {
    refresh();
    const on = () => refresh();
    addEventListener("agora:shares", on);
    return () => removeEventListener("agora:shares", on);
  }, []);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away, true), removeEventListener("keydown", esc));
  }, [open]);
  return (
    <div className="share" ref={box}>
      <button className="btn ghost" aria-expanded={open} onClick={() => (setOpen((o) => !o), refresh())} title={tr("把一块画布或整个项目分享给别人看和评论", "Share a canvas or the whole project for others to view and comment on")}>
        <IconShare size={16} /><span className="btn-label">{tr("分享", "Share")}</span>{active > 0 && <em className="count">{active}</em>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="share-pop"
            role="dialog"
            aria-label={tr("分享画布", "Share canvas")}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
          >
            <CreateShare canvases={canvases} current={current} summary={summary} onCreated={refresh} />
            <ShareList rows={rows} onChange={refresh} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CreateShare({ canvases, current, summary, onCreated }: { canvases: { id: string; title: string }[]; current?: string; summary: ProjectSummary | null; onCreated: () => void }) {
  const [scope, setScope] = useState<ShareScope>("canvas");
  const [canvasId, setCanvasId] = useState(current ?? canvases[0]?.id ?? "");
  const [dur, setDur] = useState<(typeof DURATIONS)[number]["key"]>("1d");
  const [n, setN] = useState("30");
  const [unit, setUnit] = useState<(typeof UNITS)[number]["key"]>("m");
  const [limited, setLimited] = useState(false);
  const [maxOpens, setMaxOpens] = useState("5");
  // Not ticked unless the owner ticks it, every time: watching the whole process shows what was tried and thrown away too.
  const [buildReplay, setBuildReplay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; row: ShareRow } | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!made) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [made]);
  // Which address: the person's own domain (asked when the account has several), or a temporary link (no domain needed).
  const [info, setInfo] = useState<DomainInfo | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [target, setTarget] = useState<ShareTarget | null>(null);
  useEffect(() => {
    void api<DomainInfo>("GET", "/domains").then(setInfo, (e) => setInfo({ domains: [], chosen: null, fixed: false, error: tr(`${(e as Error).message}。可以先用临时链接`, `${(e as Error).message}. You can use a temporary link for now`) }));
  }, []);
  const view = domainView(info, picked);
  const kind = target ?? defaultTarget(view);
  const plan = createPlan(view, kind);
  const ttl = (): number | null => {
    const d = DURATIONS.find((x) => x.key === dur)!;
    if (d.key === "custom") return Math.round(Number(n) * UNITS.find((u) => u.key === unit)!.s);
    return d.s;
  };
  const customBad = dur === "custom" && (!(Number(n) > 0) || (ttl() ?? 0) < 60 || (ttl() ?? 0) > 90 * 86400);
  const opensBad = limited && !(/^\d+$/.test(maxOpens.trim()) && Number(maxOpens) >= 1 && Number(maxOpens) <= 10000);
  const create = async () => {
    setBusy(true);
    setErr(null);
    setMade(null);
    try {
      if (!plan.ok) return;
      const j = await api<{ url: string; share: ShareRow }>("POST", "", { scope, canvasId: scope === "canvas" ? canvasId : "", ttl: ttl(), maxOpens: limited ? Number(maxOpens) : null, buildReplay, ...plan.body });
      setMade({ url: j.url, row: j.share });
      setCopied(false);
      onCreated();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="share-new">
      <header className="share-head">
        <h3>{scope === "project" ? tr("分享整个项目", "Share the whole project") : tr("分享画布", "Share canvas")}</h3>
        <p>{tr(`拿到链接的人只能看${scope === "project" ? "项目里的画布" : "这块画布"}和评论，不能改图，也看不到会话、代码路径或调用 Agent。`, `Anyone with the link can only view ${scope === "project" ? "the project’s canvases" : "this canvas"} and its comments. They can’t edit, see sessions or code paths, or call agents.`)}</p>
      </header>
      <div className="share-field">
        <span>{tr("分享什么", "Share")}</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label={tr("分享什么", "What to share")}>
          <button role="radio" aria-checked={scope === "canvas"} data-on={scope === "canvas"} onClick={() => setScope("canvas")}>{tr("这一张画布", "This canvas")}</button>
          <button role="radio" aria-checked={scope === "project"} data-on={scope === "project"} onClick={() => setScope("project")}>{tr("整个项目", "Whole project")}</button>
        </div>
      </div>
      {scope === "canvas" ? (
        <label className="share-field">
          <span>{tr("画布", "Canvas")}</span>
          <select value={canvasId} onChange={(e) => setCanvasId(e.target.value)}>
            {canvases.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>
      ) : (
        <div className="share-field share-custom">
          <span />
          <small data-testid="project-note">{summary ? projectNote(summary) : tr("整个项目：之后新建的画布也自动可见。", "The whole project: canvases created later become visible too.")}</small>
        </div>
      )}
      <div className="share-field">
        <span>{tr("地址", "Address")}</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label={tr("地址", "Address")}>
          <button role="radio" aria-checked={kind === "domain"} data-on={kind === "domain"} onClick={() => setTarget("domain")} title={tr("用你自己的域名：地址稳定，关掉 Agora 再打开还是同一个（有效期内）。需要先在终端运行 npx cf auth login", "Use your own domain: a stable address that stays the same when you close and reopen Agora (while it’s valid). Run npx cf auth login in a terminal first")}>{tr("我的域名", "My domain")}</button>
          <button role="radio" aria-checked={kind === "quick"} data-on={kind === "quick"} onClick={() => setTarget("quick")}>{tr("临时链接", "Temporary link")}</button>
        </div>
      </div>
      {kind === "domain" ? (
        <DomainRow view={view} onPick={setPicked} />
      ) : (
        <div className="share-field share-custom">
          <span />
          <small className="share-quick-note">{tr("不需要域名和账号，随时能用；关掉 Agora 就失效，地址每次不同，同一时间只有一个临时链接。", "No domain or account needed, works any time. It stops working when you close Agora, the address changes each time, and there’s only one temporary link at a time.")}</small>
        </div>
      )}
      <div className="share-field">
        <span>{tr("有效期", "Expires")}</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label={tr("有效期", "Expires")}>
          {DURATIONS.map((d) => (
            <button key={d.key} role="radio" aria-checked={dur === d.key} data-on={dur === d.key} onClick={() => setDur(d.key)}>{d.label}</button>
          ))}
        </div>
      </div>
      {dur === "custom" && (
        <div className="share-field share-custom">
          <span />
          <div>
            <input inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} aria-label={tr("时长", "Duration")} />
            <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label={tr("单位", "Unit")}>
              {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
            {customBad && <em>{tr("1 分钟到 90 天之间", "Between 1 minute and 90 days")}</em>}
          </div>
        </div>
      )}
      <div className="share-field">
        <span>{tr("打开次数", "Opens")}</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label={tr("打开次数", "Opens")}>
          <button role="radio" aria-checked={!limited} data-on={!limited} onClick={() => setLimited(false)}>{tr("不限次数", "Unlimited")}</button>
          <button role="radio" aria-checked={limited} data-on={limited} onClick={() => setLimited(true)}>{tr("限制次数", "Limited")}</button>
        </div>
      </div>
      {limited && (
        <div className="share-field share-custom">
          <span />
          <div>
            {tr("最多打开", "At most")}
            <input inputMode="numeric" value={maxOpens} onChange={(e) => setMaxOpens(e.target.value)} aria-label={tr("最多打开次数", "Maximum opens")} />
            {tr("次", "opens")}{opensBad && <em>{tr("1 到 10000 的整数", "A whole number from 1 to 10000")}</em>}
          </div>
        </div>
      )}
      <div className="share-field">
        <span>{tr("搭建过程", "Build")}</span>
        <label className="share-check">
          <input type="checkbox" checked={buildReplay} onChange={(e) => setBuildReplay(e.target.checked)} />
          {tr("让访客看搭建过程", "Let guests watch the build")}
        </label>
      </div>
      <div className="share-field share-custom">
        <span />
        <small>{tr("访客能一步步看到这张图从空白到现在是怎么画出来的，包括画了又删掉、改掉的想法；看不到会话、请求、代码路径或令牌。不勾选，访客只看得到现在的图。", "Guests can step through how this diagram was drawn from a blank canvas, including ideas that were drawn and then deleted or changed. They can’t see sessions, requests, code paths or tokens. Unchecked, guests only see the current diagram.")}</small>
      </div>
      <p className="share-note">
        {limited
          ? tr("每个新访客（一个浏览器）用链接进来算一次，同一个浏览器再打开或刷新不另算；次数用完后新访客打不开，已经进来的人不受影响。", "Each new guest (one browser) opening the link counts once; reopening or refreshing in the same browser doesn’t count again. Once the opens run out, new guests can’t get in; guests already in aren’t affected. ")
          : tr("任何拿到链接的人都能打开。", "Anyone with the link can open it. ")}
        {tr("另有防刷的频率限制（同一网络地址每分钟最多打开 10 次），与这里的次数无关。", "There is also a rate limit against abuse (at most 10 opens per minute from one network address), separate from this count.")}
      </p>
      <div className="share-actions">
        {busy && <span className="share-busy">{kind === "quick" ? tr("正在要一个临时地址，要十来秒…", "Getting a temporary address, about ten seconds…") : tr("正在建立隧道和域名，第一次要十几秒…", "Setting up the tunnel and domain; the first time takes 10–20 seconds…")}</span>}
        <button className="btn primary" disabled={busy || (scope === "canvas" && !canvasId) || (scope === "project" && summary?.canvases === 0) || customBad || opensBad || !plan.ok} onClick={() => void create()}>
          {busy ? tr("创建中…", "Creating…") : tr("创建链接", "Create link")}
        </button>
      </div>
      {err && <p className="share-err" role="alert">{tr("没有建成：", "Couldn’t create it: ")}{err}</p>}
      {made && (
        <div className="share-made">
          <div className="share-link">
            <code title={made.url}>{made.url}</code>
            <button className="icon-btn sm" onClick={() => void copy(made.url)} aria-label={tr("复制链接", "Copy link")} title={tr("复制链接", "Copy link")}><IconCopy size={16} /></button>
          </div>
          {made.row && dnsWait(made.row, now).waiting && <p className="share-wait" role="status">{dnsWait(made.row, now).text}</p>}
          <p>{copied ? tr("已复制。", "Copied. ") : ""}{tr("链接只显示这一次（只存了令牌的哈希）；丢了就撤销后重建一个。", "The link is shown only this once (only a hash of its token is stored); if you lose it, revoke it and make a new one.")}</p>
        </div>
      )}
    </section>
  );
}

function ShareList({ rows, onChange }: { rows: ShareRow[]; onChange: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [pending, setPending] = useState<string | null>(null);
  const flip = async (r: ShareRow) => {
    setPending(r.id);
    try {
      await api("PATCH", `/${r.id}`, buildSwitch(r).body);
    } finally {
      setPending(null);
      onChange();
    }
  };
  const live = rows.filter((r) => r.status === "active");
  const ended = rows.filter((r) => r.status !== "active").slice(0, 4);
  const revoke = async (id: string) => {
    setPending(id);
    try {
      await api("DELETE", `/${id}`);
    } finally {
      setPending(null);
      onChange();
    }
  };
  return (
    <section className="share-list">
      <h4>{tr("当前分享", "Active shares")}<em className="count">{live.length}</em></h4>
      {!live.length && <p className="share-empty">{tr("没有有效的分享。", "No active shares.")}</p>}
      <ul>
        {live.map((r) => (
          <li key={r.id} className="share-row">
            <div className="share-row-main">
              <b>{shareLabel(r)}</b>
              <code title={r.url}>{r.host}</code>
              <span className="share-meta">
                {r.expiresAt == null ? tr("直到撤销", "No expiry") : tr(`剩 ${fmtLeft(r.expiresAt - now)}`, `${fmtLeft(r.expiresAt - now)} left`)} · <span title={r.maxOpens ? tr(`已有 ${r.opens ?? 0} 个访客打开，最多 ${r.maxOpens} 个`, `${r.opens ?? 0} of at most ${r.maxOpens} guests have opened it`) : tr("已打开的访客数（不限次数）", "Guests who have opened it (unlimited)")} data-full={!!r.maxOpens && (r.opens ?? 0) >= r.maxOpens}>{opensText(r)}</span> · {tr(`评论 ${r.comments}`, `${r.comments} ${r.comments === 1 ? "comment" : "comments"}`)}{r.buildReplay ? ` · ${replayText(r)}` : ""}
              </span>
              {dnsWait(r, now).waiting && <span className="share-wait" role="status">{dnsWait(r, now).text}</span>}
              <label className="share-check share-flip" title={tr("随时可改，访客那边马上按新的来", "Change it any time; guests get the new setting right away")}>
                <input type="checkbox" checked={buildSwitch(r).on} disabled={pending === r.id} onChange={() => void flip(r)} aria-label={tr("访客看搭建过程", "Guests can watch the build")} />
                {tr("访客看搭建过程", "Guests can watch the build")}
              </label>
            </div>
            <button className="btn sm danger" disabled={pending === r.id} onClick={() => void revoke(r.id)} title={tr("立即结束这个分享：链接和它的域名都会失效", "End this share now: the link and its domain stop working")}><IconLock size={14} />{pending === r.id ? tr("撤销中…", "Revoking…") : tr("撤销", "Revoke")}</button>
          </li>
        ))}
      </ul>
      {ended.length > 0 && (
        <>
          <h4 className="share-ended-h">{tr("已结束", "Ended")}</h4>
          <ul>
            {ended.map((r) => (
              <li key={r.id} className="share-row" data-ended>
                <div className="share-row-main">
                  <b>{shareLabel(r)}</b>
                  <span className="share-meta">
                    {r.status === "revoked" ? tr("已撤销", "Revoked") : r.status === "canvas-deleted" ? tr("画布已删除", "Canvas deleted") : tr("已到期", "Expired")} · {opensText(r)} · {tr(`评论 ${r.comments}`, `${r.comments} ${r.comments === 1 ? "comment" : "comments"}`)}
                    {r.cleanup.length > 0 && tr(" · DNS 记录待清理", " · DNS record pending cleanup")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
