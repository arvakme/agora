// The bar over the canvas while a PR plays (web/docs/workstation.md「PR 回放」): which PR, that it is
// made from git and not what an agent did, 第 k/N 个 in a 连播, and previous / next / leave (Esc too).
// Mounted in the canvas overlay (./Overlay.tsx), in the place of the replay banner.
import { IconBack, IconClose } from "../app/icons";
import { replays, useReplays } from "./replayMode";

export function ReplayBar() {
  const st = useReplays();
  const pos = replays.position();
  if (!st.id) return null;
  const n = st.spec?.number ?? Number(st.id.replace(/\D+/g, ""));
  return (
    <div className="ws-banner ws-pr-bar" role="status">
      {pos && <b className="k">第 {pos.k}/{pos.n} 个</b>}
      <span>
        PR #{n} 回放 · 按 git 提交生成（不是 agent 的真实操作）
      </span>
      {st.barNote ? <b className="k">{st.barNote}</b> : st.spec && <span className="ttl" title={st.spec.title}>{st.spec.title}</span>}
      <button className="icon-btn sm" onClick={() => replays.step(-1)} aria-label="上一个 PR" title="上一个 PR"><IconBack size={14} /></button>
      <button className="icon-btn sm" onClick={() => replays.step(1)} aria-label="下一个 PR" title="下一个 PR"><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><IconBack size={14} /></span></button>
      <button className="icon-btn sm" onClick={() => replays.exit()} aria-label="退出回放（Esc）" title="退出回放（Esc）"><IconClose size={14} /></button>
    </div>
  );
}
