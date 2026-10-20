// The cards a two-way CLI's requests become in the session pane: a question (its options, one send button) or an
// approval (allow / allow for the rest of this session / deny with a word). They stay until the CLI's turn
// answers, is interrupted or ends — the server withdraws them (`request_cancel`), nothing here decides that.
import { useState } from "react";
import { agents, useAgents } from "./agents";
import { answerBody, answered, pick, type HostRequest, type Picks } from "./requestModel";
import { tr } from "../i18n";

const NONE: HostRequest[] = [];

export function RequestCards({ sessionId }: { sessionId: string }) {
  const list = useAgents().requests[sessionId] ?? NONE;
  if (!list.length) return null;
  return (
    <div className="sp-requests" role="region" aria-label={tr("等你回答", "Waiting for your answer")}>
      {list.map((r) => (r.kind === "question" ? <QuestionCard key={r.id} r={r} /> : <ApprovalCard key={r.id} r={r} />))}
    </div>
  );
}

function useSend(r: HostRequest) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (d: Parameters<typeof agents.answerRequest>[2]) => {
    setBusy(true);
    setErr(null);
    try {
      await agents.answerRequest(r.sessionId, r.id, d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, send };
}

function QuestionCard({ r }: { r: HostRequest }) {
  const [picks, setPicks] = useState<Picks>({});
  const { busy, err, send } = useSend(r);
  return (
    <section className="sp-req" data-kind="question" aria-label={tr("它在问你", "It's asking you")}>
      {(r.questions ?? []).map((q) => (
        <fieldset key={q.question} className="sp-req-q">
          <legend>
            {q.header ? <b className="sp-req-head">{q.header}</b> : null}
            {q.question}
            {q.multiSelect ? <em className="sp-req-hint">{tr("可多选", "Select any")}</em> : null}
          </legend>
          {q.options.map((o) => {
            const on = (picks[q.question] ?? []).includes(o.label);
            return (
              <button key={o.label} type="button" className="sp-req-opt" role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} data-on={on || undefined} onClick={() => setPicks((p) => pick(q, p, o.label))}>
                <span>{o.label}</span>
                {o.description ? <small>{o.description}</small> : null}
              </button>
            );
          })}
        </fieldset>
      ))}
      <div className="sp-req-actions">
        <button className="btn primary sm" disabled={busy || !answered(r, picks)} onClick={() => void send(answerBody(r, picks))}>{tr("回答", "Answer")}</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void send({ decision: "deny", message: "The person chose not to answer." })}>{tr("不回答", "Skip")}</button>
        {err ? <span className="sp-req-err">{err}</span> : null}
      </div>
    </section>
  );
}

function ApprovalCard({ r }: { r: HostRequest }) {
  const [why, setWhy] = useState("");
  const { busy, err, send } = useSend(r);
  return (
    <section className="sp-req" data-kind="approval" aria-label={tr("它要你批准", "It needs your approval")}>
      <p className="sp-req-title">
        <b>{r.tool}</b> <code title={r.summary}>{r.summary}</code>
      </p>
      {r.reason ? <p className="sp-req-reason">{r.reason}</p> : null}
      <div className="sp-req-actions">
        <button className="btn primary sm" disabled={busy} onClick={() => void send({ decision: "allow" })}>{tr("允许", "Allow")}</button>
        {r.canSession ? <button className="btn sm" disabled={busy} onClick={() => void send({ decision: "allow_session" })} title={tr("这个会话里同类的以后都不再问", "Don't ask again for this kind in this session")}>{tr("这个会话都允许", "Allow for this session")}</button> : null}
        <input className="sp-req-why" value={why} onChange={(e) => setWhy(e.target.value)} placeholder={tr("拒绝时可以说一句原因", "Reason for denying (optional)")} aria-label={tr("拒绝的原因", "Reason for denying")} />
        <button className="btn sm ghost" disabled={busy} onClick={() => void send({ decision: "deny", message: why })}>{tr("拒绝", "Deny")}</button>
        {err ? <span className="sp-req-err">{err}</span> : null}
      </div>
    </section>
  );
}
