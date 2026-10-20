// The play controls at the top of the trajectory while a turn plays on the diagram (web/docs/workstation.md §3, §11):
// which turn, pause / continue, speed, leave (Esc too). The engine is the clock and workstation/replayMode.ts; this
// only presses its buttons. Gone when the play ends.
import { useEffect } from "react";
import { IconClose, IconPause, IconPlay } from "../app/icons";
import { clock, replayTime, useReplay } from "../workstation/clock";
import { plays, usePlay } from "../workstation/replayMode";
import { tr } from "../i18n";

export const PLAY_SPEEDS = [0.5, 1, 2, 4] as const;

export function PlayControls() {
  const st = usePlay();
  const r = useReplay();
  const p = st.play;
  const on = !!p;
  // Esc leaves (replayMode.ts does it, except while a text box has the focus): an empty box is not being typed in, and the
  // composer is often the focused one (a person who just opened the pane), so there Esc leaves too.
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (e.key === "Escape" && t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.value) (e.stopPropagation(), plays.exit());
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [on]);
  if (!p) return null;
  const playing = !!r?.playing;
  const toggle = () => {
    if (!r) return;
    if (playing) return clock.pause();
    const at = replayTime(r, Date.now());
    clock.play(at >= r.until - 1 ? p.win.start : at, r.until, r.speed, r.gaps); // at the end: again from the start
  };
  return (
    <div className="ds-play" role="toolbar" aria-label={tr("回放控制", "Replay controls")}>
      <b className="ds-play-turn">{tr(`第 ${p.n} 轮`, `Turn ${p.n}`)}</b>
      <span className="ds-play-state">{playing ? tr("回放中", "Replaying") : tr("已暂停", "Paused")}</span>
      <button className="icon-btn sm" onClick={toggle} aria-label={playing ? tr("暂停", "Pause") : tr("继续", "Resume")} title={playing ? tr("暂停", "Pause") : tr("继续", "Resume")}>
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
      <div className="seg" data-static role="radiogroup" aria-label={tr("倍速", "Speed")}>
        {PLAY_SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={(r?.speed ?? 1) === s} data-on={(r?.speed ?? 1) === s} onClick={() => clock.speed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <span className="grow" />
      <button className="icon-btn sm" onClick={() => plays.exit()} aria-label={tr("退出回放（Esc）", "Exit replay (Esc)")} title={tr("退出回放（Esc）", "Exit replay (Esc)")}>
        <IconClose size={14} />
      </button>
    </div>
  );
}
