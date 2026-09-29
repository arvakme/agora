// 「在图上看这一轮」 and ▶ (web/docs/workstation.md §11 按轮追踪): in a turn's head, in the conversation and in
// the trajectory view. The first traces this turn of the session's agent on the canvas — stops, route and
// sub-agents are this turn's only — and glides the canvas to its first stop (once, only on this click).
// ▶ plays the turn again on the diagram (the timeline's replay: its speed buttons slow it down) with the trace
// kept, and here — the person asked for it — the camera follows the agent close up, in and out of sub-diagrams
// (workstation/replayMode.ts). A running turn ends "now", so its stops grow with the tool calls.
import { sessionNames } from "../multi/writes";
import { focus } from "../workstation/focus";
import { plays } from "../workstation/replayMode";
import { useRuns } from "../workstation/runs/store";
import { sessions } from "./store";
import type { TurnWindow } from "../workstation/trace";
import type { TrajTurn } from "./trajectoryModel";
import "./traceTurn.css";

export const windowOfTurn = (t: Pick<TrajTurn, "n" | "startedAt" | "endedAt" | "running">): TurnWindow => ({ n: t.n, start: t.startedAt, end: t.running || t.endedAt == null ? null : t.endedAt });

export function TraceTurn({ sessionId, turn }: { sessionId: string; turn: TrajTurn }) {
  const runs = useRuns();
  const run = runs.flat.find((f) => f.depth === 0 && f.run.sessionId === sessionId)?.run;
  const win = windowOfTurn(turn);
  const off = !run;
  const why = off ? "这个会话还没有出现在工位视图里" : undefined;
  return (
    <span className="ds-trace-turn">
      <button className="ds-trace-btn" disabled={off} title={why ?? "在图上看这一轮：编号站点、路线和子代理，只算这一轮"} onClick={() => run && focus.traceTurn(run.id, win)}>
        在图上看这一轮
      </button>
      <button
        className="ds-trace-btn"
        disabled={off}
        aria-label="在图上回放这一轮"
        title={why ?? "在图上回放这一轮：镜头跟着 agent 走（用时间线的回放，可以慢放）"}
        onClick={() => {
          if (!run) return;
          focus.trace(run.id, win);
          focus.select(run.id);
          plays.start({ runId: run.id, n: turn.n, name: sessionNames.get()[sessionId] || run.name, win, canvasId: sessions.get().sessions[sessionId]?.canvasId });
        }}
      >
        ▶
      </button>
    </span>
  );
}
