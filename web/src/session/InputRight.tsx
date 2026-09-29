// "终端窗口开着 · 你的话在排队": who holds a terminal session's input, said where the person types (the session
// pane's composer and the figure's talk box), with the two things they can do about it — send the queued message now
// (past the pause, this one only) or take the pane over / hand it back to Agora.
import { useState } from "react";
import { agents, useAgents } from "./agents";
import { inputRightNote } from "./requestModel";

export function InputRight({ sessionId }: { sessionId: string }) {
  const status = useAgents().status[sessionId];
  const [err, setErr] = useState<string | null>(null);
  const note = status ? inputRightNote(status) : null;
  if (!note) return null;
  const run = (f: () => Promise<unknown>) => void f().then(() => setErr(null), (e) => setErr(e instanceof Error ? e.message : String(e)));
  return (
    <div className="sp-inputright" role="status" data-by={note.by}>
      <i className="dot" data-tone="caution" />
      <span>{note.text}</span>
      {note.canSendNow ? <button className="btn sm" onClick={() => run(() => agents.deliverNow(sessionId))} title="只送出排在最前的这一条；后面的照旧等着">现在送出</button> : null}
      {note.canTakeOver ? (
        <button className="btn sm ghost" onClick={() => run(() => (note.takenOver ? agents.giveBack(sessionId) : agents.takeover(sessionId)))}>{note.takenOver ? "交回 Agora" : "接管"}</button>
      ) : null}
      {err ? <span className="sp-req-err">{err}</span> : null}
    </div>
  );
}
