// A share guest's page: one canvas, read-only, with comments. Everything goes through the share
// gateway's three guest endpoints (web/docs/sharing.md); there is no workspace, session, agent or
// progress pointer here, and the owner's email / local paths never reach this page.
import { MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasView, type CanvasHandle } from "../canvas/CanvasView";
import { createThreadStore, setIdentity, useThreads, type Message, type Thread, type ThreadStore } from "../comments/threads";
import { threadsFromFile, type ThreadsFile } from "../project/format";
import { SPRING } from "../comments/motion";
import { IconComment, IconEye, IconList, IconLock, IconPointer, IconUser, IconWorkspace } from "../app/icons";
import { ThemeButton } from "../app/ThemeButton";
import type { El } from "../canvas/scene";
import "./guest.css";

type State = {
  project: { name: string };
  canvas: { id: string; title: string; elements: El[] };
  threads: ThreadsFile;
  me: { id: string } | null;
  share: { expiresAt: number | null };
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

export async function loadGuest(): Promise<State> {
  const r = await fetch("/api/guest/state", { credentials: "same-origin" });
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
  const handle = useRef<CanvasHandle | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  // Posts wait for a name when the guest hasn't given one yet.
  const waiting = useRef<(() => void)[]>([]);
  const me = initial.me?.id ?? "guest:?";

  useEffect(() => setIdentity({ id: me, name: name || "访客" }), [me, name]);

  const store: ThreadStore = useMemo(() => {
    const post = async (body: Record<string, unknown>) => {
      const send = async () => {
        const r = await fetch("/api/guest/comments", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, name: nameRef.current }),
        });
        if (r.status === 403) return setEnded(true);
        if (r.status === 429) return flash("发得太快了，稍等一会儿再试");
        if (!r.ok) return flash(`没有发出去：${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
      };
      if (nameRef.current.trim()) return send();
      waiting.current.push(() => void send());
      setAsking("needed");
    };
    return createThreadStore(initial.canvas.id, threadsFromFile(initial.threads), {
      create: (t: Thread) => void post({ op: "create", threadId: t.id, id: t.messages[0].id, anchor: t.anchor, text: t.messages[0].text }),
      reply: (threadId: string, m: Message) => void post({ op: "reply", threadId, id: m.id, text: m.text }),
    });
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  // Live: others' comments, the owner's edits to the drawing, and the end of the share.
  useEffect(() => {
    const es = new EventSource("/api/guest/events");
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as { t: string; data?: ThreadsFile; elements?: El[] };
      if (ev.t === "threads" && ev.data) {
        const snap = threadsFromFile(ev.data);
        if (snap) store.merge(snap);
      } else if (ev.t === "canvas" && ev.elements && handle.current) {
        handle.current.api.updateScene({ elements: ev.elements as never });
      } else if (ev.t === "ended") {
        es.close();
        setEnded(true);
      }
    };
    return () => es.close();
  }, [store]);
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
      void loadGuest().then((s) => {
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
          <span className="guest-title" title={initial.canvas.title}>{initial.canvas.title || "画布"}</span>
          <span className="guest-project">{initial.project.name}</span>
          <span className="guest-gap" />
          <span className="guest-note"><IconEye size={16} />只能查看和评论{expires != null && <> · <Remaining at={expires} /></>}</span>
          <ThemeButton />
          <button className="btn quiet guest-name" onClick={() => setAsking("needed")} title="修改显示名">
            <IconUser size={16} /><span>{name || "填写名字"}</span>
          </button>
        </header>
        <div className="guest-canvas" data-pane={initial.canvas.id}>
          <CanvasView
            doc={{ id: initial.canvas.id, title: initial.canvas.title, store }}
            mode={mode}
            drawerOpen={drawer}
            onDrawer={setDrawer}
            onReady={(h) => (handle.current = h)}
            onSelection={() => {}}
            onModeDone={() => setMode("browse")}
            initialElements={initial.canvas.elements}
            readOnly
          />
        </div>
        <GuestDock mode={mode} setMode={(m) => (m === "comment" ? startComment() : setMode(m))} drawer={drawer} toggleDrawer={() => setDrawer((d) => !d)} store={store} />
        {mode === "comment" && (
          <motion.div className="mode-hint" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <IconComment size={14} />点一个元素钉评论 · Esc 退出
          </motion.div>
        )}
        {toast && <div className="toast" role="status"><span>{toast}</span></div>}
        {asking && <NameDialog initial={name} welcome={asking === "welcome"} title={initial.canvas.title} onOk={confirmName} onSkip={skipName} />}
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
