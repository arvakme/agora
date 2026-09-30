// 「▶ 回放这一轮」 (web/docs/workstation.md §11 按轮追踪): in a turn's head, in the conversation and in the trajectory view.
// It traces this turn of the session's agent on the canvas — numbered stops, route and sub-agents are this turn's only — and
// plays it again on the diagram (the timeline's replay: its speed buttons slow it down) with the camera following the agent
// close up, in and out of sub-diagrams (workstation/replayMode.ts). When the play ends the route and stops stay on the
// canvas under 「第 N 轮的路线」 with 「关闭」 (Esc too). A running turn ends "now", so its stops grow with the tool calls.
import { useRuns } from "../workstation/runs/store";
import { playTurn, runOf } from "./playTurn";
import type { TrajTurn } from "./trajectoryModel";
import "./traceTurn.css";

export function TraceTurn({ sessionId, turn }: { sessionId: string; turn: TrajTurn }) {
  const off = !runOf(useRuns(), sessionId);
  const why = off ? "这个会话还没有出现在工位视图里" : undefined;
  return (
    <span className="ds-trace-turn">
      <button className="ds-trace-btn" disabled={off} title={why ?? "在图上回放这一轮：镜头跟着 agent 走，播完路线和站点留在图上（可以慢放，Esc 关闭）"} onClick={() => playTurn(sessionId, turn)}>
        ▶ 回放这一轮
      </button>
    </span>
  );
}
