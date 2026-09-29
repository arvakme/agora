// A small label over the canvas while a turn plays (web/docs/workstation.md §11 按轮追踪): 「回放中 · 第 N 轮」, no buttons —
// pause, speed and leave are on the trajectory panel (session/PlayControls.tsx), and Esc leaves. It also carries the summary when
// the badge over the node has no clear place, and 「跟随小人」 after the person has taken the camera. Mounted in the canvas
// overlay (./Overlay.tsx).
import { plays, usePlay } from "./replayMode";

export function ReplayBar() {
  const st = usePlay();
  const p = st.play;
  if (!p) return null;
  return (
    <div className="ws-banner ws-play-bar" role="status" title={`${p.name} · 第 ${p.n} 轮（Esc 退出）`}>
      <b className="k">回放中 · 第 {p.n} 轮</b>
      {st.barNote && <b className="k">{st.barNote}</b>}
      {st.manual && <button className="btn sm primary" onClick={() => plays.resumeFollow()}>跟随小人</button>}
    </div>
  );
}
