// The top bar's ⋯ (web/docs/workbench-focus.md): everything that is a view setting rather than
// work — layout, theme, the 工位视图 (and, on trial, its footprints and the 等你 notification:
// web/docs/workstation.md「新想法」), resolved comments on the canvas, canvas hints, and help.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import { clock, useWorkstation } from "../workstation/clock";
import { canNotify, notifyBlocked, setWaitNotify } from "../workstation/WaitNotifier";
import { IconCheck, IconComment, IconEnter, IconHint, IconMessage, IconMore, IconPath, IconTarget, IconUser } from "./icons";
import { prefs, usePrefs } from "./prefs";
import { theme, useTheme, type ThemePref } from "./theme";
import type { Preset } from "../workspace/layout";

const LAYOUTS: [Preset, string][] = [
  ["single", "单窗"],
  ["row", "左右"],
  ["col", "上下"],
  ["grid", "平铺"],
];
const THEMES: [ThemePref, string][] = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

export function ViewMenu({ onLayout, layouts }: { onLayout: (p: Preset) => void; layouts: boolean }) {
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
      <button className="icon-btn" aria-label="视图与布局" aria-haspopup="menu" aria-expanded={open} title="视图与布局" onClick={() => setOpen((o) => !o)}>
        <IconMore size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu view-pop" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }} transition={SPRING}>
            <p className="menu-title">布局</p>
            <div className="seg vm-seg" role="group" aria-label="布局">
              {LAYOUTS.map(([k, label]) => (
                <button key={k} disabled={!layouts && k !== "single"} onClick={() => onLayout(k)}>{label}</button>
              ))}
            </div>
            <p className="menu-title">主题</p>
            <div className="seg vm-seg" role="radiogroup" aria-label="主题">
              {THEMES.map(([k, label]) => (
                <button key={k} role="radio" aria-checked={t.pref === k} data-on={t.pref === k} onClick={() => theme.set(k)}>{label}</button>
              ))}
            </div>
            <hr />
            {sw(ws, "工位视图（小人）", <IconUser size={14} />, () => clock.setEnabled(!ws))}
            {sw(p.followCamera, "镜头跟随主 agent", <IconTarget size={14} />, () => prefs.set({ followCamera: !p.followCamera }))}
            {sw(p.autoFollowTab, "有 agent 进子图时自动打开跟随窗口", <IconEnter size={14} />, () => prefs.set({ autoFollowTab: !p.autoFollowTab }))}
            {sw(p.footprints, "小人的脚印", <IconPath size={14} />, () => prefs.set({ footprints: !p.footprints }))}
            {canNotify() && sw(p.notifyWait, notifyBlocked() ? "等你时通知我（浏览器已拦截）" : "等你时通知我", <IconMessage size={14} />, () => void setWaitNotify(!p.notifyWait))}
            {sw(p.showResolved, "显示已解决的评论", <IconCheck size={14} />, () => prefs.set({ showResolved: !p.showResolved }))}
            {sw(p.hints, "画布操作提示", <IconHint size={14} />, () => prefs.set({ hints: !p.hints }))}
            <hr />
            <button role="menuitem" onClick={() => (setHelp(true), setOpen(false))}>
              <IconComment size={14} />
              快捷键与帮助
              <kbd>?</kbd>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{help && <Help onClose={() => setHelp(false)} />}</AnimatePresence>
    </div>
  );
}

const KEYS: [string, string][] = [
  ["V", "浏览"],
  ["C", "评论模式：点一个元素钉评论；先选中几个元素再按 C，评论这组选区"],
  ["Esc", "退出评论模式 / 回到实时 / 取消选中"],
  ["⌘↑", "从子图回到上一层"],
  ["双击节点", "进入它的子图"],
  ["时间线 ← →", "回放时前后 1 秒（⇧ 5 秒），[ ] 上一步 / 下一步，空格 播放"],
  ["?", "打开或关闭这张表"],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="menu-scrim help-scrim" onPointerDown={onClose} />
      <motion.div className="menu help-pop" role="dialog" aria-label="快捷键与帮助" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={SPRING}>
        <p className="menu-title">快捷键与帮助</p>
        <dl>
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="help-note">小人就是 agent 在图上的位置：它读写哪个节点的代码就站在哪；空闲一分钟后离开画布。时间线拖动可以回放。</p>
      </motion.div>
    </>
  );
}
