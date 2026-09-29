// A share guest's page: one canvas (and the canvases nested below it), read-only, with comments. Everything goes through the share
// gateway's three guest endpoints (web/docs/sharing.md); there is no workspace, session, agent or
// progress pointer here, and the owner's email / local paths never reach this page.
import { MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { createThreadStore, setIdentity, useThreads, type Message, type Thread, type ThreadStore } from "../comments/threads";
import { threadsFromFile, type ThreadsFile } from "../project/format";
import { SPRING } from "../comments/motion";
import { IconComment, IconCopy, IconEye, IconFile, IconList, IconLock, IconPointer, IconUser, IconWorkspace } from "../app/icons";
import { ThemeButton } from "../app/ThemeButton";
import type { El } from "../canvas/scene";
import { Breadcrumb, ChildMarkers } from "../nested/NestedLayer";
import { canvasFromUrl, urlFor } from "../nested/store";
import { openLive, type LiveEvent } from "./live";
import "./guest.css";

type State = {
  project: { name: string };
  canvas: { id: string; title: string; elements: El[] };
  threads: ThreadsFile;
  me: { id: string } | null;
  share: { expiresAt: number | null; root?: string };
  /** From the shared canvas down to this one (nested canvases). */
  path?: { id: string; title: string }[];
  /** Every canvas this share reaches: its name and open comments (including those below it). */
  canvases?: Record<string, { title: string; open: number }>;
};

const NAME_KEY = "agora.guestName";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveName = (n: string) => {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode: the name lives for this page only */
  }
};

export async function loadGuest(canvas?: string): Promise<State> {
  const r = await fetch(`/api/guest/state${canvas ? `?canvas=${encodeURIComponent(canvas)}` : ""}`, { credentials: "same-origin" });
  if (r.status === 403) throw new Ended();
  if (!r.ok) throw new Error(`加载失败（${r.status}）`);
  return (await r.json()) as State;
}

export class Ended extends Error {}

export function GuestEnded() {
  return (
    <div className="guest-ended">
      <main>
        <IconLock size={56} />
        <h1>这个分享链接已失效</h1>
        <p>它可能已经到期或被作者撤销。需要继续查看的话，请向作者要一个新链接。</p>
      </main>
    </div>
  );
}

export function GuestApp({ initial }: { initial: State }) {
  const [ended, setEnded] = useState(false);
  const [name, setName] = useState(readName);
  const [asking, setAsking] = useState<null | "welcome" | "needed">(() => (readName() ? null : "welcome"));
  const [mode, setMode] = useState<"browse" | "comment">("browse");
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const handle = useRef<CanvasHandle | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  // Posts wait for a name when the guest hasn't given one yet.
  const waiting = useRef<(() => void)[]>([]);
  const me = initial.me?.id ?? "guest:?";

  useEffect(() => setIdentity({ id: me, name: name || "访客" }), [me, name]);

  // The canvas on screen (the shared one, or one nested below it) and one thread store per canvas.
  const [cur, setCur] = useState<State>(initial);
  const stores = useRef(new Map<string, ThreadStore>());
  const storeFor = (st: State): ThreadStore => {
    const have = stores.current.get(st.canvas.id);
    if (have) return have;
    const canvasId = st.canvas.id;
    const post = async (body: Record<string, unknown>) => {
      const send = async () => {
        const r = await fetch("/api/guest/comments", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, canvasId, name: nameRef.current }),
        });
        if (r.status === 403) return setEnded(true);
        if (r.status === 429) return flash("发得太快了，稍等一会儿再试");
        if (!r.ok) return flash(`没有发出去：${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
      };
      if (nameRef.current.trim()) return send();
      waiting.current.push(() => void send());
      setAsking("needed");
    };
    const created = createThreadStore(canvasId, threadsFromFile(st.threads), {
      create: (t: Thread) => void post({ op: "create", threadId: t.id, id: t.messages[0].id, anchor: t.anchor, text: t.messages[0].text }),
      reply: (threadId: string, m: Message) => void post({ op: "reply", threadId, id: m.id, text: m.text }),
      // Only one's own messages; the gateway checks that again (web/docs/sharing.md §3).
      edit: (threadId: string, m: Message) => void post({ op: "edit", threadId, id: m.id, text: m.text }),
      remove: (threadId: string, id: string) => void post({ op: "delete", threadId, id }),
      restore: (threadId: string, m: Message) => void post({ op: "restore", threadId, id: m.id, text: m.text, ...(m.editedAt && { editedAt: m.editedAt }) }),
    });
    stores.current.set(canvasId, created);
    return created;
  };
  const store = storeFor(cur);
  const curRef = useRef(cur);
  curRef.current = cur;
  /** Step into a child canvas or back up (the gateway refuses anything the share does not reach). */
  const goTo = async (id: string, push = true) => {
    if (id === curRef.current.canvas.id) return;
    try {
      const next = await loadGuest(id);
      const have = stores.current.get(id);
      const snap = threadsFromFile(next.threads);
      if (have && snap) have.merge(snap);
      setCur(next);
      setMode("browse");
      if (push) history.pushState({ canvas: id }, "", urlFor(id));
    } catch (e) {
      if (e instanceof Ended) setEnded(true);
      else flash("打不开这一层");
    }
  };
  const goRef = useRef(goTo);
  goRef.current = goTo;
  useEffect(() => {
    const onPop = (e: PopStateEvent) => void goRef.current((e.state as { canvas?: string } | null)?.canvas ?? canvasFromUrl() ?? initial.canvas.id, false);
    addEventListener("popstate", onPop);
    const first = canvasFromUrl();
    if (first && first !== initial.canvas.id) void goRef.current(first, false);
    else history.replaceState({ canvas: initial.canvas.id }, "", urlFor(initial.canvas.id));
    return () => removeEventListener("popstate", onPop);
  }, []);
  // Open-comment counts on the child markers follow new comments.
  const refresh = useRef(0);
  const refreshCounts = () => {
    clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => void loadGuest(curRef.current.canvas.id).then((n) => setCur((c) => (c.canvas.id === n.canvas.id ? { ...c, canvases: n.canvases } : c)), () => {}), 300);
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  // Live: others' comments, the owner's edits to the drawing, and the end of the share. Over a
  // tunnel that buffers streams (quick tunnels) `openLive` falls back to polling the state.
  useEffect(() => {
    const onEvent = (ev: LiveEvent) => {
      const here = !ev.canvasId || ev.canvasId === curRef.current.canvas.id;
      if (ev.t === "threads" && ev.data) {
        const snap = threadsFromFile(ev.data as ThreadsFile);
        const target = stores.current.get(ev.canvasId ?? curRef.current.canvas.id);
        if (snap && target) target.merge(snap);
        refreshCounts();
      } else if (ev.t === "canvas" && ev.elements && handle.current && here) {
        handle.current.api.updateScene({ elements: ev.elements as never });
      } else if (ev.t === "ended") {
        setEnded(true);
      }
    };
    const poll = async () => {
      let n: State;
      try {
        n = await loadGuest(curRef.current.canvas.id);
      } catch (e) {
        if (e instanceof Ended) setEnded(true);
        return;
      }
      if (n.canvas.id !== curRef.current.canvas.id) return;
      const snap = threadsFromFile(n.threads);
      const target = stores.current.get(n.canvas.id);
      if (snap && target) target.merge(snap);
      if (JSON.stringify(n.canvas.elements) !== JSON.stringify(curRef.current.canvas.elements)) handle.current?.api.updateScene({ elements: n.canvas.elements as never });
      setCur((c) => (c.canvas.id === n.canvas.id ? { ...c, canvas: n.canvas, canvases: n.canvases } : c));
    };
    return openLive({ onEvent, poll });
  }, []);
  useEffect(() => {
    const at = initial.share.expiresAt;
    if (at == null) return;
    const t = setTimeout(() => setEnded(true), Math.max(0, at - Date.now()) + 500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setMode("browse");
        store.close();
        handle.current?.dismissDraft();
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        startComment();
      } else if (e.key.toLowerCase() === "v") setMode("browse");
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  const startComment = () => {
    if (!nameRef.current.trim()) return setAsking("needed");
    setMode((m) => (m === "comment" ? "browse" : "comment"));
  };

  const confirmName = (n: string) => {
    const v = n.trim().slice(0, 40);
    if (!v) return;
    setName(v);
    nameRef.current = v;
    saveName(v);
    setAsking(null);
    const q = waiting.current.splice(0);
    q.forEach((f) => f());
  };
  const skipName = () => {
    setAsking(null);
    if (waiting.current.length) {
      // Unsent comments can't be kept without a name: take the server's copy back.
      waiting.current = [];
      void loadGuest(curRef.current.canvas.id).then((s) => {
        const snap = threadsFromFile(s.threads);
        store.reset();
        if (snap) store.merge(snap);
      }, () => setEnded(true));
    }
  };

  if (ended) return <GuestEnded />;
  const expires = initial.share.expiresAt;
  return (
    <MotionConfig reducedMotion="user">
      <div className="app guest" data-mode={mode}>
        <header className="guest-top">
          <span className="brand"><IconWorkspace size={18} />Agora</span>
          <span className="guest-title" title={cur.canvas.title}>{cur.canvas.title || "画布"}</span>
          <span className="guest-project">{initial.project.name}</span>
          <span className="guest-gap" />
          <span className="guest-note"><IconEye size={16} />只能查看和评论{expires != null && <> · <Remaining at={expires} /></>}</span>
          <button className="btn quiet" onClick={() => setImporting(true)} title="把这块画布和评论下载成文件，导入到你自己的 Agora">
            <IconFile size={16} /><span>导入到我的 Agora</span>
          </button>
          <ThemeButton />
          <button className="btn quiet guest-name" onClick={() => setAsking("needed")} title="修改显示名">
            <IconUser size={16} /><span>{name || "填写名字"}</span>
          </button>
        </header>
        <div className="guest-canvas" data-pane={cur.canvas.id}>
          <CanvasView
            key={cur.canvas.id}
            doc={{ id: cur.canvas.id, title: cur.canvas.title, store }}
            mode={mode}
            drawerOpen={drawer}
            onDrawer={setDrawer}
            onReady={(h) => (handle.current = h)}
            onSelection={() => {}}
            onModeDone={() => setMode("browse")}
            initialElements={cur.canvas.elements}
            readOnly
            onEnterChild={(id) => void goTo(id)}
            top={<Breadcrumb path={cur.path ?? []} current={cur.canvas.id} onGo={(id) => void goTo(id)} />}
            overlay={(view, chrome) => (
              <ChildMarkers view={view} chrome={chrome} canvasId={cur.canvas.id} info={(k) => (cur.canvases?.[k] ? { title: cur.canvases[k].title || "子图", open: cur.canvases[k].open } : null)} onEnter={(id) => void goTo(id)} />
            )}
          />
        </div>
        <GuestDock mode={mode} setMode={(m) => (m === "comment" ? startComment() : setMode(m))} drawer={drawer} toggleDrawer={() => setDrawer((d) => !d)} store={store} />
        {mode === "comment" && (
          <motion.div className="mode-hint" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <IconComment size={14} />点一个元素钉评论 · Esc 退出
          </motion.div>
        )}
        {toast && <div className="toast" role="status"><span>{toast}</span></div>}
        {importing && <ImportDialog onClose={() => setImporting(false)} />}
        {asking && <NameDialog initial={name} welcome={asking === "welcome"} title={cur.canvas.title} onOk={confirmName} onSkip={skipName} />}
      </div>
    </MotionConfig>
  );
}

function Remaining({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="guest-left">{fmtLeft(at - now)}后失效</span>;
}

export function fmtLeft(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  if (s >= 60) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function GuestDock({ mode, setMode, drawer, toggleDrawer, store }: { mode: "browse" | "comment"; setMode: (m: "browse" | "comment") => void; drawer: boolean; toggleDrawer: () => void; store: ThreadStore }) {
  const { threads } = useThreads(store);
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <div className="dock" role="toolbar" aria-label="评论工具">
      <div className="dock-tools">
        {([["browse", IconPointer, "浏览 · V"], ["comment", IconComment, "评论 · C"]] as const).map(([m, Icon, label]) => (
          <button key={m} className="dock-btn" data-on={mode === m} aria-pressed={mode === m} onClick={() => setMode(m)} aria-label={label} title={label}>
            {mode === m && <motion.span layoutId="dock-on" className="dock-on" transition={SPRING} />}
            <Icon size={18} />
          </button>
        ))}
        <button className="dock-btn" data-on={drawer} aria-pressed={drawer} onClick={toggleDrawer} aria-label={`所有评论 · ${open} 条进行中`} title="所有评论">
          {drawer && <motion.span layoutId="dock-drawer" className="dock-on" transition={SPRING} />}
          <IconList size={18} />
          {open > 0 && <em className="dock-badge">{open}</em>}
        </button>
      </div>
    </div>
  );
}

function NameDialog({ initial, welcome, title, onOk, onSkip }: { initial: string; welcome: boolean; title: string; onOk: (n: string) => void; onSkip: () => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="guest-scrim" onPointerDown={(e) => e.target === e.currentTarget && onSkip()}>
      <motion.form
        className="guest-dialog"
        role="dialog"
        aria-label="你的名字"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING}
        onSubmit={(e) => (e.preventDefault(), onOk(v))}
      >
        {welcome && <IconEye size={48} />}
        <h2>{welcome ? `你正在查看「${title || "画布"}」` : "评论前留个名字"}</h2>
        <p>{welcome ? "可以浏览这块画布，也可以在元素上钉评论；作者会看到并回复。不能修改画图。" : "名字会显示在你的评论旁边，作者靠它认出你。"}</p>
        <label>
          <span>显示名</span>
          <input ref={ref} value={v} maxLength={40} placeholder="例如：小王" onChange={(e) => setV(e.target.value)} />
        </label>
        <div className="guest-dialog-actions">
          <button type="button" className="btn quiet" onClick={onSkip}>{welcome ? "先只看" : "取消"}</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>{welcome ? "开始" : "好"}</button>
        </div>
      </motion.form>
    </div>
  );
}

const IMPORT_CMD = "agora import <下载的文件>";

/** How a guest takes the share home: the bundle file, and the command that brings it into their own Agora. */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(IMPORT_CMD).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
      () => {},
    );
  };
  return (
    <div className="guest-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="guest-dialog" role="dialog" aria-label="导入到我的 Agora">
        <h2>导入到我的 Agora</h2>
        <p>下载分享包，再在你自己的项目里运行下面的命令：画布和子图会作为新画布导入，评论作为只读的历史保留。</p>
        <a className="btn primary" href="/api/guest/bundle" download>
          <IconFile size={16} />下载分享包
        </a>
        <div className="guest-cmd">
          <code>{IMPORT_CMD}</code>
          <button className="btn quiet" onClick={copy} aria-label="复制命令">
            <IconCopy size={16} />{copied ? "已复制" : "复制"}
          </button>
        </div>
        <p className="guest-warn" role="note">
          <IconLock size={14} />分享包一旦下载就收不回来：撤销分享只让链接失效，已经保存的文件不受影响。
        </p>
        <div className="guest-dialog-actions">
          <button className="btn quiet" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
