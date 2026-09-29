// "分享": share one canvas through the owner's public domain for as long as the owner picks, and
// see / revoke the current shares. Server: /api/share (server/canvas/project_router.py);
// design: web/docs/sharing.md. The link's token is shown once — only its hash is stored.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { IconCopy, IconLock, IconShare } from "../app/icons";
import { SPRING } from "../comments/motion";
import { fmtLeft } from "../guest/GuestApp";
import { replayText } from "./replayText";
import { buildSwitch, dnsWait } from "./shareLive";
import { createPlan, defaultTarget, domainView, type DomainInfo, type ShareTarget } from "./domainChoice";
import "./share.css";

export type ShareRow = {
  id: string;
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
export const opensText = (r: Pick<ShareRow, "opens" | "maxOpens">) => (r.maxOpens ? `打开 ${r.opens ?? 0}/${r.maxOpens}` : `打开 ${r.opens ?? 0}`);

const DURATIONS = [
  { key: "1h", label: "1 小时", s: 3600 },
  { key: "1d", label: "1 天", s: 86400 },
  { key: "7d", label: "7 天", s: 7 * 86400 },
  { key: "custom", label: "自定义", s: 0 },
  { key: "forever", label: "直到撤销", s: null },
] as const;
const UNITS = [
  { key: "m", label: "分钟", s: 60 },
  { key: "h", label: "小时", s: 3600 },
  { key: "d", label: "天", s: 86400 },
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
  const active = rows.filter((r) => r.status === "active").length;
  const refresh = () => void api<{ shares: ShareRow[] }>("GET").then((j) => setRows(j.shares), () => {});
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
      <button className="btn ghost" aria-expanded={open} onClick={() => (setOpen((o) => !o), refresh())} title="把一块画布分享给别人看和评论">
        <IconShare size={16} /><span className="btn-label">分享</span>{active > 0 && <em className="count">{active}</em>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="share-pop"
            role="dialog"
            aria-label="分享画布"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
          >
            <CreateShare canvases={canvases} current={current} onCreated={refresh} />
            <ShareList rows={rows} onChange={refresh} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CreateShare({ canvases, current, onCreated }: { canvases: { id: string; title: string }[]; current?: string; onCreated: () => void }) {
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
    void api<DomainInfo>("GET", "/domains").then(setInfo, (e) => setInfo({ domains: [], chosen: null, fixed: false, error: `${(e as Error).message}。可以先用临时链接` }));
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
      const j = await api<{ url: string; share: ShareRow }>("POST", "", { canvasId, ttl: ttl(), maxOpens: limited ? Number(maxOpens) : null, buildReplay, ...plan.body });
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
        <h3>分享画布</h3>
        <p>拿到链接的人只能看这块画布和评论，不能改图，也看不到会话、代码路径或调用 Agent。</p>
      </header>
      <label className="share-field">
        <span>画布</span>
        <select value={canvasId} onChange={(e) => setCanvasId(e.target.value)}>
          {canvases.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </label>
      <div className="share-field">
        <span>地址</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label="地址">
          <button role="radio" aria-checked={kind === "domain"} data-on={kind === "domain"} onClick={() => setTarget("domain")}>我的域名</button>
          <button role="radio" aria-checked={kind === "quick"} data-on={kind === "quick"} onClick={() => setTarget("quick")}>临时链接</button>
        </div>
      </div>
      <div className="share-field share-custom">
        <span />
        <div className="share-where">
          {kind === "domain" ? (
            <>
              {view.kind === "loading" && <em>正在读取你的 Cloudflare 域名…</em>}
              {(view.kind === "fixed" || view.kind === "single") && <span>域名：<code>{view.domain}</code></span>}
              {view.kind === "pick" && (
                <label>
                  域名
                  <select value={view.selected} onChange={(e) => setPicked(e.target.value)} aria-label="分享用的域名">
                    {view.options.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              )}
              {view.kind === "error" && <em role="alert">{view.message}</em>}
              {view.kind === "none" && <em>这个 Cloudflare 账号里没有域名。可以先用临时链接。</em>}
              <small>地址稳定：用你自己的域名，关掉 Agora 再打开还是同一个地址（有效期内）。需要先在终端运行 <code>npx cf auth login</code>。</small>
            </>
          ) : (
            <small>不需要域名和账号，随时能用；关掉 Agora 就失效，地址每次不同，同一时间只有一个临时链接。</small>
          )}
        </div>
      </div>
      <div className="share-field">
        <span>有效期</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label="有效期">
          {DURATIONS.map((d) => (
            <button key={d.key} role="radio" aria-checked={dur === d.key} data-on={dur === d.key} onClick={() => setDur(d.key)}>{d.label}</button>
          ))}
        </div>
      </div>
      {dur === "custom" && (
        <div className="share-field share-custom">
          <span />
          <div>
            <input inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} aria-label="时长" />
            <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="单位">
              {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
            {customBad && <em>1 分钟到 90 天之间</em>}
          </div>
        </div>
      )}
      <div className="share-field">
        <span>打开次数</span>
        <div className="seg share-seg" data-static role="radiogroup" aria-label="打开次数">
          <button role="radio" aria-checked={!limited} data-on={!limited} onClick={() => setLimited(false)}>不限次数</button>
          <button role="radio" aria-checked={limited} data-on={limited} onClick={() => setLimited(true)}>限制次数</button>
        </div>
      </div>
      {limited && (
        <div className="share-field share-custom">
          <span />
          <div>
            最多打开
            <input inputMode="numeric" value={maxOpens} onChange={(e) => setMaxOpens(e.target.value)} aria-label="最多打开次数" />
            次{opensBad && <em>1 到 10000 的整数</em>}
          </div>
        </div>
      )}
      <div className="share-field">
        <span>搭建过程</span>
        <label className="share-check">
          <input type="checkbox" checked={buildReplay} onChange={(e) => setBuildReplay(e.target.checked)} />
          让访客看搭建过程
        </label>
      </div>
      <div className="share-field share-custom">
        <span />
        <small>访客能一步步看到这张图从空白到现在是怎么画出来的，包括画了又删掉、改掉的想法；看不到会话、请求、代码路径或令牌。不勾选，访客只看得到现在的图。</small>
      </div>
      <p className="share-note">
        {limited
          ? "每个新访客（一个浏览器）用链接进来算一次，同一个浏览器再打开或刷新不另算；次数用完后新访客打不开，已经进来的人不受影响。"
          : "任何拿到链接的人都能打开。"}
        另有防刷的频率限制（同一网络地址每分钟最多打开 10 次），与这里的次数无关。
      </p>
      <div className="share-actions">
        {busy && <span className="share-busy">{kind === "quick" ? "正在要一个临时地址，要十来秒…" : "正在建立隧道和域名，第一次要十几秒…"}</span>}
        <button className="btn primary" disabled={busy || !canvasId || customBad || opensBad || !plan.ok} onClick={() => void create()}>
          {busy ? "创建中…" : "创建链接"}
        </button>
      </div>
      {err && <p className="share-err" role="alert">没有建成：{err}</p>}
      {made && (
        <div className="share-made">
          <div className="share-link">
            <code title={made.url}>{made.url}</code>
            <button className="icon-btn sm" onClick={() => void copy(made.url)} aria-label="复制链接" title="复制链接"><IconCopy size={16} /></button>
          </div>
          {made.row && dnsWait(made.row, now).waiting && <p className="share-wait" role="status">{dnsWait(made.row, now).text}</p>}
          <p>{copied ? "已复制。" : ""}链接只显示这一次（只存了令牌的哈希）；丢了就撤销后重建一个。</p>
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
      <h4>当前分享<em className="count">{live.length}</em></h4>
      {!live.length && <p className="share-empty">没有有效的分享。</p>}
      <ul>
        {live.map((r) => (
          <li key={r.id} className="share-row">
            <div className="share-row-main">
              <b>{r.canvasTitle || r.canvasId}</b>
              <code title={r.url}>{r.host}</code>
              <span className="share-meta">
                {r.expiresAt == null ? "直到撤销" : `剩 ${fmtLeft(r.expiresAt - now)}`} · <span title={r.maxOpens ? `已有 ${r.opens ?? 0} 个访客打开，最多 ${r.maxOpens} 个` : "已打开的访客数（不限次数）"} data-full={!!r.maxOpens && (r.opens ?? 0) >= r.maxOpens}>{opensText(r)}</span> · 评论 {r.comments}{r.buildReplay ? ` · ${replayText(r)}` : ""}
              </span>
              {dnsWait(r, now).waiting && <span className="share-wait" role="status">{dnsWait(r, now).text}</span>}
              <label className="share-check share-flip" title="随时可改，访客那边马上按新的来">
                <input type="checkbox" checked={buildSwitch(r).on} disabled={pending === r.id} onChange={() => void flip(r)} aria-label="访客看搭建过程" />
                访客看搭建过程
              </label>
            </div>
            <button className="btn sm danger" disabled={pending === r.id} onClick={() => void revoke(r.id)} title="立即结束这个分享：链接和它的域名都会失效"><IconLock size={14} />{pending === r.id ? "撤销中…" : "撤销"}</button>
          </li>
        ))}
      </ul>
      {ended.length > 0 && (
        <>
          <h4 className="share-ended-h">已结束</h4>
          <ul>
            {ended.map((r) => (
              <li key={r.id} className="share-row" data-ended>
                <div className="share-row-main">
                  <b>{r.canvasTitle || r.canvasId}</b>
                  <span className="share-meta">
                    {r.status === "revoked" ? "已撤销" : r.status === "canvas-deleted" ? "画布已删除" : "已到期"} · {opensText(r)} · 评论 {r.comments}
                    {r.cleanup.length > 0 && " · DNS 记录待清理"}
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
