// The App shell's small pieces (./App.tsx): the bottom dock, the 未保存 banner with its download
// fallback, and the banner for a change made outside Agora.
import { motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { SPRING } from "../comments/motion";
import { IconComment, IconHint, IconList, IconPointer } from "./icons";
import { tr } from "../i18n";
import { project, reloadFromDisk, slotFile, type LocalChange } from "../persist";
import { type El } from "../canvas/scene";
import { useThreads, type ThreadStore } from "../comments/threads";

/**
 * The canvas dock: 浏览 / 评论 and the open-comment count (opens the comment list). Commenting a
 * selection is part of comment mode (select, then C or 评论); 清空画布 lives in Excalidraw's ☰.
 */
export function Dock({ at, mode, setMode, drawerOpen, toggleDrawer, store, evalButton }: {
  at: { x: number; bottom: number } | null;
  mode: "browse" | "comment";
  setMode: (m: "browse" | "comment") => void;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  store: ThreadStore;
  evalButton: React.ReactNode;
}) {
  const { threads } = useThreads(store);
  const open = threads.filter((t) => !t.resolved).length;
  return (
    <div className="dock" role="toolbar" aria-label={tr("画布工具", "Canvas tools")} style={at ? { left: at.x, bottom: at.bottom } : undefined}>
      <div className="seg dock-seg" role="radiogroup" aria-label={tr("模式", "Mode")}>
        {([["browse", IconPointer, tr("浏览", "Browse"), "V"], ["comment", IconComment, tr("评论", "Comment"), "C"]] as const).map(([m, Icon, label, key]) => (
          <button key={m} role="radio" aria-checked={mode === m} data-on={mode === m} onClick={() => setMode(m)} title={`${label} · ${key}${m === "comment" ? tr("（先选中元素再按，评论这组选区）", " (select elements first to comment on the selection)") : ""}`}>
            {mode === m && <motion.span layoutId="dock-on" className="seg-bg" transition={SPRING} />}
            <Icon size={14} />
            <span className="dock-label">{label}</span>
          </button>
        ))}
      </div>
      <button className="dock-count" data-on={drawerOpen} aria-pressed={drawerOpen} onClick={toggleDrawer} title={tr("评论列表", "Comments")} aria-label={tr(`评论列表 · ${open} 条进行中`, `Comments · ${open} open`)}>
        <IconList size={14} />
        <span className="dock-label">{tr("评论", "Comments")}</span>
        {open > 0 && <em>{open}</em>}
      </button>
      {evalButton}
    </div>
  );
}

/**
 * Saving problems, most serious first: the project directory is gone (410), a write the server
 * refused (disk full, permissions…), a file changed on disk since this page loaded it, a file on
 * disk that cannot be read (not written from here), or the project server is unreachable.
 */
export function SaveBanner({ docTitle, scene }: { docTitle: (id: string) => string | undefined; scene: (id: string) => readonly El[] | undefined }) {
  const st = useSyncExternalStore(project.subscribe, project.status);
  // The canvases whose unsaved state lives only in this page: download them before anything else.
  const unsaved = [...new Set(st.failed.map((f) => f.slot.split(":")).filter(([k]) => k === "canvas" || k === "threads").map(([, id]) => id))];
  const download = (ids: string[]) => ids.forEach((id) => downloadScene(docTitle(id) ?? id, scene(id) ?? []));
  const gone = st.failed.find((f) => f.gone);
  if (gone)
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>{tr("项目目录不在了", "Project folder is gone")}</b>
        <span>{gone.message}</span>
        {unsaved.length > 0 && <button className="btn sm quiet" onClick={() => download(unsaved)}>{tr("下载为 .excalidraw", "Download as .excalidraw")}{unsaved.length > 1 ? tr(`（${unsaved.length} 块）`, ` (${unsaved.length})`) : ""}</button>}
        <button className="btn sm ghost" onClick={() => void project.retry()}>{tr("重试", "Retry")}</button>
      </div>
    );
  const failed = st.failed[0];
  if (failed) {
    const file = failed.file ?? slotFile(failed.slot);
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>{tr("保存失败", "Save failed")}</b>
        <span>
          {failed.message.replace(/^(保存失败：|Save failed: )/, "")}
          {st.failed.length > 1 ? tr(`（另有 ${st.failed.length - 1} 个文件）`, ` (+${st.failed.length - 1} more ${st.failed.length > 2 ? "files" : "file"})`) : ""} · <code>.agora/{file}</code> · {tr("改动还在这个页面里", "your changes are still in this page")}
        </span>
        {unsaved.length > 0 && <button className="btn sm ghost" onClick={() => download(unsaved)}>{tr("下载为 .excalidraw", "Download as .excalidraw")}</button>}
        <button className="btn sm quiet" onClick={() => void project.retry()}>{tr("重试", "Retry")}</button>
      </div>
    );
  }
  const slot = st.conflicts[0];
  if (slot) {
    const [kind, id] = slot.split(":");
    const what =
      kind === "workspace"
        ? tr("画布清单与布局", "The canvas list and layout")
        : kind === "session"
          ? tr("会话记录", "The session record")
          : tr(`「${docTitle(id) ?? id}」${kind === "threads" ? "的评论" : ""}`, `${kind === "threads" ? "Comments on " : ""}“${docTitle(id) ?? id}”`);
    return (
      <div className="notice save-banner" role="alert" data-tone="error">
        <IconHint size={16} />
        <b>{tr("有冲突", "Conflict")}</b>
        <span>{tr(`${what}在别处被改过（另一个窗口、编辑器或 git），这里的改动还没保存`, `${what} changed elsewhere (another window, an editor or git); changes here aren't saved yet`)} · <code>.agora/{slotFile(slot)}</code></span>
        <button className="btn sm quiet" onClick={reloadFromDisk}>{tr("载入磁盘上的版本", "Load the version on disk")}</button>
        <button className="btn sm ghost" onClick={() => void project.resolve(slot, "overwrite")}>{tr("用这里的覆盖", "Overwrite with this one")}</button>
      </div>
    );
  }
  if (st.blocked.length)
    return (
      <div className="notice save-banner" role="alert" data-tone="caution">
        <IconHint size={16} />
        <b>{tr("文件读不了", "Can't read a file")}</b>
        <span>
          {tr(
            `${st.blocked.map((b) => b.reason).join("；")}。这个文件先不保存，其余照常；在编辑器里解决后刷新页面。`,
            `${st.blocked.map((b) => b.reason).join("; ")}. This file won't be saved for now; everything else saves as usual. Fix it in an editor, then reload the page.`,
          )}
        </span>
        <button className="btn sm quiet" onClick={() => location.reload()}>{tr("刷新", "Reload")}</button>
      </div>
    );
  if (st.offline)
    return (
      <div className="notice save-banner" role="status" data-tone="caution">
        <IconHint size={16} />
        <b>{tr("未连接", "Offline")}</b>
        <span>{tr("项目服务连不上，改动暂存在这个页面里，恢复后自动写入。", "Can't reach the project server. Changes are kept in this page and written once it's back.")}</span>
      </div>
    );
  return null;
}

/** Save a canvas as it is in this page as an .excalidraw file (opens on excalidraw.com as-is). */
function downloadScene(title: string, elements: readonly El[]) {
  const file = { type: "excalidraw", version: 2, source: "agora", elements: elements.filter((e) => !e.isDeleted), appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${title.replace(/[\\/:*?"<>|]/g, "_") || "canvas"}.excalidraw` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What happened to this copy of the project since the page last looked (server/canvas/local.py):
 * moved (Pi logs moved along), copied (sessions read-only until forked), a fresh clone or another
 * machine (sessions shown as read-only cards). Shown once; 知道了 tells the server.
 */
export function ChangeBanner({ change, onDismiss }: { change: LocalChange; onDismiss: () => void }) {
  const failed = change.failed ?? [];
  const [title, text] =
    change.kind === "moved"
      ? [
          tr("项目移动过", "Project moved"),
          tr(
            `从 ${change.from} 移到了这里。Claude Code 和 Codex 的会话照常续接${change.migrated?.length ? `；${change.migrated.length} 个 Pi 会话的日志已迁到新目录（旧文件留了 .agora-moved.bak）` : ""}${failed.length ? `；${failed.length} 个 Pi 会话没迁移：${failed.map((f) => f.error).join("；")}` : ""}。`,
            `Moved here from ${change.from}. Claude Code and Codex sessions resume as usual${change.migrated?.length ? `; logs of ${change.migrated.length} Pi ${change.migrated.length === 1 ? "session" : "sessions"} moved to the new folder (the old files are kept as .agora-moved.bak)` : ""}${failed.length ? `; ${failed.length} Pi ${failed.length === 1 ? "session wasn't" : "sessions weren't"} moved: ${failed.map((f) => f.error).join("; ")}` : ""}.`,
          ),
        ]
      : change.kind === "copied"
        ? [
            tr("这是一份副本", "This is a copy"),
            tr(
              `从 ${change.from} 复制而来：带过来的 ${change.sessions?.length ?? 0} 个会话在这里只读（原来那份还在用它们），可以在会话里「在这里分叉继续」。`,
              `Copied from ${change.from}: the ${change.sessions?.length ?? 0} ${(change.sessions?.length ?? 0) === 1 ? "session" : "sessions"} it brought along are read-only here (the original still uses them); fork one from inside the session to continue here.`,
            ),
          ]
        : change.kind === "fresh"
          ? [tr("会话不在这台机器上", "Sessions aren't on this machine"), tr("这份项目是新 clone、换了机器或本机记录被清掉了：带着的会话显示为只读卡片，能在本机找回的会给出「恢复」。", "This project is a fresh clone, on another machine, or its local records were cleared: its sessions show as read-only cards, and any that can be found on this machine offer Restore.")]
          : [tr("已认回这份项目", "Project recognized again"), tr("本机记录（.agora/local）不见了，已按本机注册表认回；会话绑定可以在会话里恢复，或运行 agora doctor。", "The local records (.agora/local) were missing, so the project was recognized from this machine's registry; restore session bindings from inside each session, or run agora doctor.")];
  return (
    <div className="notice save-banner" role="status" data-tone={failed.length ? "caution" : undefined}>
      <IconHint size={16} />
      <b>{title}</b>
      <span>{text}</span>
      <button className="btn sm ghost" onClick={onDismiss}>{tr("知道了", "Got it")}</button>
    </div>
  );
}
