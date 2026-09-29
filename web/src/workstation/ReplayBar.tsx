// The bar over the canvas while a turn plays (web/docs/workstation.md §11 按轮追踪): 「第 N 轮 · <会话名>」,
// the summary when the badge over the node has no clear place, 「跟随小人」 after the person has taken the
// camera, and leave (Esc too). Mounted in the canvas overlay (./Overlay.tsx), in the place of the replay banner.
import { IconClose } from "../app/icons";
import { plays, usePlay } from "./replayMode";

export function ReplayBar() {
  const st = usePlay();
  const p = st.play;
  if (!p) return null;
  return (
    <div className="ws-banner ws-play-bar" role="status">
      <b className="k">第 {p.n} 轮</b>
      <span className="ttl" title={p.name}>· {p.name}</span>
      {st.barNote && <b className="k">{st.barNote}</b>}
      {st.manual && <button className="btn sm primary" onClick={() => plays.resumeFollow()}>跟随小人</button>}
      <button className="icon-btn sm" onClick={() => plays.exit()} aria-label="退出回放（Esc）" title="退出回放（Esc）"><IconClose size={14} /></button>
    </div>
  );
}
