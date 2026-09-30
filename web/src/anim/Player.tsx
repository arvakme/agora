// Engine-agnostic player bar, pinned under its region on the canvas. Same form as the canvas dock:
// a floating pill that follows the theme, icons through the facade.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SPEEDS, type AnimController, type ViewRect } from "./player.ts";
import { IconClose, IconNext, IconPause, IconPlay, IconPrev, IconRetry } from "../app/icons";

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
      aria-label={`动画播放器 · ${ctl.tl.script.title}`}
      style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + 10 }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === " ") (e.preventDefault(), ctl.toggle());
        else if (e.key === "ArrowRight") (e.preventDefault(), ctl.next());
        else if (e.key === "ArrowLeft") (e.preventDefault(), ctl.prev());
      }}
    >
      <div className="anim-row">
        <button className="anim-btn" onClick={ctl.reset} aria-label="复位" title="复位">
          <IconRetry size={16} />
        </button>
        <button className="anim-btn" onClick={() => ctl.prev()} disabled={pos === 0} aria-label="上一步" title="上一步 ←">
          <IconPrev size={16} />
        </button>
        <button className="anim-btn main" onClick={ctl.toggle} aria-label={s.playing ? "暂停" : done ? "重播" : "播放"} title="播放 / 暂停 · 空格">
          {s.playing ? <IconPause size={16} /> : done ? <IconRetry size={16} /> : <IconPlay size={16} />}
        </button>
        <button className="anim-btn" onClick={() => ctl.next()} disabled={done || s.playing} aria-label="下一步" title="下一步 →">
          <IconNext size={16} />
        </button>
        <input
          className="anim-progress"
          type="range"
          min={0}
          max={s.total}
          step={0.01}
          value={pos}
          aria-label="进度"
          onChange={(e) => (ctl.pause(), ctl.seek(Number(e.target.value)))}
        />
        <span className="anim-count">{Math.min(s.step + (s.t > 0 ? 1 : 0), s.total)}/{s.total}</span>
        <button className="anim-speed" onClick={() => ctl.setSpeed(SPEEDS[(SPEEDS.indexOf(s.speed as never) + 1) % SPEEDS.length])} aria-label="播放速度" title="调速">
          {s.speed}×
        </button>
        {ctl.engine.tween && (
          <button className="anim-speed" data-on={s.native} disabled={s.playing} onClick={() => ctl.setNative(!s.native)} title="原生 animateShapes / 逐帧插值">
            {s.native ? "原生" : "逐帧"}
          </button>
        )}
        <button className="anim-btn" onClick={onClose} aria-label="关闭播放器" title="关闭播放器（保留图形）">
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
