// A small label over the canvas while a turn plays (web/docs/workstation.md §11 按轮追踪): 「回放中 · 第 N 轮」, no buttons —
// pause, speed and leave are on the trajectory panel (session/PlayControls.tsx), and Esc leaves. It also carries the summary when
// the badge over the node has no clear place, and 「跟随小人」 after the person has taken the camera. Mounted in the canvas
// overlay (./Overlay.tsx). After the play (or a trace of a turn) the route stays on the canvas, and TraceBar says whose it is:
// 「第 N 轮的路线」 with 「关闭」 (Esc too), and what the numbers mean.
import { focus } from "./focus";
import { plays, usePlay } from "./replayMode";
import { ROUTE_LEGEND, routeBarText } from "./traceText";

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

export function TraceBar({ turn }: { turn: number | null }) {
  return (
    <div className="ws-trace-bar" role="status">
      <div className="ws-trace-head">
        <b className="k">{routeBarText(turn)}</b>
        <button className="btn sm ghost" onClick={() => focus.trace(null)} title="关闭路线（Esc）">关闭</button>
      </div>
      <p className="ws-trace-legend">{ROUTE_LEGEND}</p>
    </div>
  );
}
