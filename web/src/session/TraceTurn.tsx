// 「▶ 回放这一轮」 (web/docs/workstation.md §11 按轮追踪): in a turn's head, in the conversation and in the trajectory view.
// It traces this turn of the session's agent on the canvas — numbered stops, route and sub-agents are this turn's only — and
// plays it again on the diagram (the timeline's replay: its speed buttons slow it down) with the camera following the agent
// close up, in and out of sub-diagrams (workstation/replayMode.ts). When the play ends the route and stops stay on the
// canvas under 「第 N 轮的路线」 with 「关闭」 (Esc too). A running turn ends "now", so its stops grow with the tool calls.
import { useRuns } from "../workstation/runs/store";
import { playTurn, runOf } from "./playTurn";
import type { TrajTurn } from "./trajectoryModel";
import "./traceTurn.css";
import { tr } from "../i18n";

export function TraceTurn({ sessionId, turn }: { sessionId: string; turn: TrajTurn }) {
  const off = !runOf(useRuns(), sessionId);
  const why = off ? tr("这个会话还没有出现在工位视图里", "This session isn't in the workstation view yet") : undefined;
  return (
    <span className="ds-trace-turn">
      <button className="ds-trace-btn" disabled={off} title={why ?? tr("在图上回放这一轮：镜头跟着 agent 走，播完路线和站点留在图上（可以慢放，Esc 关闭）", "Replay this turn on the diagram: the camera follows the agent, and the route and stops stay on the diagram afterwards (slow it down if you like; Esc closes)")} onClick={() => playTurn(sessionId, turn)}>
        ▶ {tr("回放这一轮", "Replay this turn")}
      </button>
    </span>
  );
}
