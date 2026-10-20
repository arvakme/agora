// Engine-agnostic player bar, pinned under its region on the canvas. Same form as the canvas dock:
// a floating pill that follows the theme, icons through the facade.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SPEEDS, type AnimController, type ViewRect } from "./player.ts";
import { IconClose, IconNext, IconPause, IconPlay, IconPrev, IconRetry } from "../app/icons";
import { tr } from "../i18n";

export function Player({ ctl, onClose }: { ctl: AnimController; onClose: () => void }) {
  const s = useSyncExternalStore(ctl.subscribe, () => ctl.snapshot);
  const rect = useRegionRect(ctl);
  const done = s.step >= s.total;
  const pos = s.step + s.t;
  if (!rect) return null;
  return (
    <div
      className="anim-player"
      role="toolbar"
      aria-label={tr(`动画播放器 · ${ctl.tl.script.title}`, `Animation player · ${ctl.tl.script.title}`)}
      style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + 10 }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === " ") (e.preventDefault(), ctl.toggle());
        else if (e.key === "ArrowRight") (e.preventDefault(), ctl.next());
        else if (e.key === "ArrowLeft") (e.preventDefault(), ctl.prev());
      }}
    >
      <div className="anim-row">
        <button className="anim-btn" onClick={ctl.reset} aria-label={tr("复位", "Reset")} title={tr("复位", "Reset")}>
          <IconRetry size={16} />
        </button>
        <button className="anim-btn" onClick={() => ctl.prev()} disabled={pos === 0} aria-label={tr("上一步", "Previous step")} title={tr("上一步 ←", "Previous step ←")}>
          <IconPrev size={16} />
        </button>
        <button className="anim-btn main" onClick={ctl.toggle} aria-label={s.playing ? tr("暂停", "Pause") : done ? tr("重播", "Replay") : tr("播放", "Play")} title={tr("播放 / 暂停 · 空格", "Play / pause · Space")}>
          {s.playing ? <IconPause size={16} /> : done ? <IconRetry size={16} /> : <IconPlay size={16} />}
        </button>
        <button className="anim-btn" onClick={() => ctl.next()} disabled={done || s.playing} aria-label={tr("下一步", "Next step")} title={tr("下一步 →", "Next step →")}>
          <IconNext size={16} />
        </button>
        <input
          className="anim-progress"
          type="range"
          min={0}
          max={s.total}
          step={0.01}
          value={pos}
          aria-label={tr("进度", "Progress")}
          onChange={(e) => (ctl.pause(), ctl.seek(Number(e.target.value)))}
        />
        <span className="anim-count">{Math.min(s.step + (s.t > 0 ? 1 : 0), s.total)}/{s.total}</span>
        <button className="anim-speed" onClick={() => ctl.setSpeed(SPEEDS[(SPEEDS.indexOf(s.speed as never) + 1) % SPEEDS.length])} aria-label={tr("播放速度", "Playback speed")} title={tr("调速", "Speed")}>
          {s.speed}×
        </button>
        {ctl.engine.tween && (
          <button className="anim-speed" data-on={s.native} disabled={s.playing} onClick={() => ctl.setNative(!s.native)} title={tr("原生 animateShapes / 逐帧插值", "Native animateShapes / frame-by-frame interpolation")}>
            {s.native ? tr("原生", "Native") : tr("逐帧", "Frames")}
          </button>
        )}
        <button className="anim-btn" onClick={onClose} aria-label={tr("关闭播放器", "Close player")} title={tr("关闭播放器（保留图形）", "Close player (keeps the shapes)")}>
          <IconClose size={16} />
        </button>
      </div>
      <div className="anim-caption" aria-live="polite">{s.caption || ctl.tl.script.title}</div>
    </div>
  );
}

/** Tracks the region's viewport rect every frame (pan/zoom/pane resize all move it). */
function useRegionRect(ctl: AnimController) {
  const [rect, setRect] = useState<ViewRect | null>(() => ctl.engine.rect());
  const last = useRef("");
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const r = ctl.engine.rect();
      const key = r ? `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}` : "";
      if (key !== last.current) (last.current = key), setRect(r);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ctl]);
  return rect;
}
