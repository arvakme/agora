// The top bar's ⋯ (web/docs/workbench-focus.md): everything that is a view setting rather than
// work — layout, theme, the 工位视图 (and, on trial, its footprints and the 等你 notification:
// web/docs/workstation.md「新想法」), resolved comments on the canvas, canvas hints, and help.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import { BuildReplayHost } from "../buildreplay/BuildReplay";
import { buildReplay } from "../buildreplay/store";
import { canvasFromUrl, nested } from "../nested/store";
import { clock, useWorkstation } from "../workstation/clock";
import { canNotify, notifyBlocked, setWaitNotify } from "../workstation/WaitNotifier";
import { IconCheck, IconComment, IconEnter, IconHint, IconMessage, IconMore, IconPath, IconTarget, IconUser } from "./icons";
import { FloatChoice } from "./FloatChoice";
import { prefs, usePrefs } from "./prefs";
import { theme, useTheme, type ThemePref } from "./theme";
import type { Preset } from "../workspace/layout";
import { lang, setLang, tr } from "../i18n";

const LAYOUTS: [Preset, string][] = [
  ["single", tr("单窗", "Single")],
  ["row", tr("左右", "Side by side")],
  ["col", tr("上下", "Stacked")],
  ["grid", tr("平铺", "Grid")],
];
const THEMES: [ThemePref, string][] = [
  ["system", tr("跟随系统", "System")],
  ["light", tr("浅色", "Light")],
  ["dark", tr("深色", "Dark")],
];

export function ViewMenu({ onLayout, onRestore, layouts }: { onLayout: (p: Preset) => void; /** 恢复默认布局: canvases left, sessions right. */ onRestore: () => void; layouts: boolean }) {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const t = useTheme();
  const p = usePrefs();
  const ws = useWorkstation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("pointerdown", close, true);
    addEventListener("keydown", key, true);
    return () => (removeEventListener("pointerdown", close, true), removeEventListener("keydown", key, true));
  }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) return;
      setHelp((h) => !h);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const sw = (on: boolean, label: string, icon: React.ReactNode, act: () => void) => (
    <button role="menuitemcheckbox" aria-checked={on} onClick={act}>
      {icon}
      {label}
      <span className="sw" aria-hidden />
    </button>
  );
  return (
    <div className="view-menu" ref={box}>
      <button className="icon-btn" aria-label={tr("视图与布局", "View and layout")} aria-haspopup="menu" aria-expanded={open} title={tr("视图与布局", "View and layout")} onClick={() => setOpen((o) => !o)}>
        <IconMore size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu view-pop" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }} transition={SPRING}>
            <p className="menu-title">{tr("布局", "Layout")}</p>
            <div className="seg vm-seg" role="group" aria-label={tr("布局", "Layout")}>
              {LAYOUTS.map(([k, label]) => (
                <button key={k} disabled={!layouts && k !== "single"} onClick={() => onLayout(k)}>{label}</button>
              ))}
            </div>
            <button role="menuitem" className="vm-restore" onClick={() => (onRestore(), setOpen(false))}>{tr("恢复默认布局", "Reset layout")}</button>
            <p className="menu-title">{tr("会话面板", "Session panel")}</p>
            <FloatChoice />
            <p className="menu-title">{tr("主题", "Theme")}</p>
            <div className="seg vm-seg" role="radiogroup" aria-label={tr("主题", "Theme")}>
              {THEMES.map(([k, label]) => (
                <button key={k} role="radio" aria-checked={t.pref === k} data-on={t.pref === k} onClick={() => theme.set(k)}>{label}</button>
              ))}
            </div>
            <p className="menu-title">语言 · Language</p>
            <div className="seg vm-seg" role="radiogroup" aria-label="语言 · Language">
              {([["zh", "中文"], ["en", "English"]] as const).map(([k, label]) => (
                <button key={k} role="radio" aria-checked={lang() === k} data-on={lang() === k} onClick={() => lang() !== k && setLang(k)}>{label}</button>
              ))}
            </div>
            <hr />
            {sw(ws, tr("工位视图（小人）", "Workstation view (avatars)"), <IconUser size={14} />, () => clock.setEnabled(!ws))}
            {sw(p.followCamera, tr("镜头跟随主 agent", "Camera follows main agent"), <IconTarget size={14} />, () => prefs.set({ followCamera: !p.followCamera }))}
            {sw(p.footprints, tr("小人的脚印", "Avatar footprints"), <IconPath size={14} />, () => prefs.set({ footprints: !p.footprints }))}
            {canNotify() && sw(p.notifyWait, notifyBlocked() ? tr("等你时通知我（浏览器已拦截）", "Notify me when waiting for me (blocked by browser)") : tr("等你时通知我", "Notify me when waiting for me"), <IconMessage size={14} />, () => void setWaitNotify(!p.notifyWait))}
            {sw(p.showResolved, tr("显示已解决的评论", "Show resolved comments"), <IconCheck size={14} />, () => prefs.set({ showResolved: !p.showResolved }))}
            {sw(p.hints, tr("画布操作提示", "Canvas hints"), <IconHint size={14} />, () => prefs.set({ hints: !p.hints }))}
            <hr />
            <button role="menuitem" onClick={() => (buildReplay.open(canvasFromUrl() ?? [...nested.get().scenes.keys()][0] ?? "c1"), setOpen(false))}>
              <IconEnter size={14} />
              {tr("看这张图是怎么搭起来的", "See how this diagram was built")}
            </button>
            <button role="menuitem" onClick={() => (setHelp(true), setOpen(false))}>
              <IconComment size={14} />
              {tr("快捷键与帮助", "Shortcuts and help")}
              <kbd>?</kbd>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{help && <Help onClose={() => setHelp(false)} />}</AnimatePresence>
      <BuildReplayHost />
    </div>
  );
}

const KEYS: [string, string][] = [
  ["V", tr("浏览", "Browse")],
  ["C", tr("评论模式：点一个元素钉评论；先选中几个元素再按 C，评论这组选区", "Comment mode: click an element to pin a comment; select a few elements first, then press C to comment on the selection")],
  ["Esc", tr("退出评论模式 / 回到实时 / 取消选中", "Exit comment mode / back to live / deselect")],
  ["⇧↵", tr("进入选中节点的子图（节点右下角的小图标也行）；双击仍是 Excalidraw 自己的：改文字", "Open the selected node's sub-diagram (or the small icon at the node's bottom right); double-click is still Excalidraw's own: edit text")],
  ["⌘↑", tr("从子图回到上一层", "Back up from a sub-diagram")],
  [tr("时间线 ← →", "Timeline ← →"), tr("回放时前后 1 秒（⇧ 5 秒），[ ] 上一步 / 下一步，空格 播放", "While replaying: back/forward 1 s (⇧ 5 s), [ ] previous / next step, Space to play")],
  ["?", tr("打开或关闭这张表", "Show or hide this sheet")],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="menu-scrim help-scrim" onPointerDown={onClose} />
      <motion.div className="menu help-pop" role="dialog" aria-label={tr("快捷键与帮助", "Shortcuts and help")} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={SPRING}>
        <p className="menu-title">{tr("快捷键与帮助", "Shortcuts and help")}</p>
        <dl>
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="help-note">{tr("小人就是 agent 在图上的位置：它读写哪个节点的代码就站在哪；空闲一分钟后离开画布。时间线拖动可以回放。", "The avatar is where the agent is on the diagram: it stands on whichever node's code it is reading or writing, and leaves the canvas after a minute idle. Drag the timeline to replay.")}</p>
      </motion.div>
    </>
  );
}
