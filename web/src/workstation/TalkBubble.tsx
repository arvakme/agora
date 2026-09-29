// 对小人说话 (web/docs/workstation.md §12): click a figure and a small input opens just under it;
// Enter sends the words to that agent's session (`agents.send`), Esc closes it. A sub-agent has no
// session of its own: the box says so and sends to the session that dispatched it instead, naming the
// sub-agent. After Enter the box says who got it — 已发给 Claude Code — and, when a turn is running, that it
// 会在这一轮结束后送达 (panel messages wait for the turn to end); the figure turns and nods when the message
// really shows up in the session, not when it is sent (./talk.ts `watchDelivery`). Mount it in the
// overlay's layer (screen coordinates of the canvas pane); it follows the selected figure's feet in
// the one frame loop. `data-esc-local`: the app's global Esc leaves it alone.
import { useEffect, useRef, useState } from "react";
import { viewport } from "../canvas/viewport";
import { agentName, agents } from "../session/agents";
import { figurePositions, useFocus } from "./focus";
import { frame } from "./frame";
import { useRuns } from "./runs/store";
import type { FlatRun } from "./runs/types";
import { deliveryNote, sendState, talk, watchDelivery, type SendState } from "./talk";
import "./TalkBubble.css";

export function TalkBubble({ canvasId }: { canvasId: string }) {
  const fo = useFocus();
  const runs = useRuns();
  const f = fo.selected ? runs.flat.find((x) => x.run.id === fo.selected) : undefined;
  // a new selection starts a new, empty box
  return f ? <Talk key={f.run.id} f={f} canvasId={canvasId} /> : null;
}

function Talk({ f, canvasId }: { f: FlatRun; canvasId: string }) {
  const [shut, setShut] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ agent: string; state: SendState } | null>(null);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = f.run.id;
  // Just under the figure's feet (bubbles sit above the heads, neighbours stand on the same line), in
  // the canvas pane's pixels, every frame; hidden until first placed. Focus waits until after the click
  // that selected the figure (its mousedown focuses the figure, a button) and places the box first: a
  // hidden input cannot take focus.
  useEffect(() => {
    if (shut) return;
    const place = () => {
      const p = figurePositions.get(canvasId, id);
      const v = viewport.get(canvasId);
      const el = box.current;
      if (!el || !p || !v) return;
      el.style.transform = `translate3d(${((p.x + v.scrollX) * v.zoom - 18).toFixed(1)}px, ${((p.y + v.scrollY) * v.zoom + 9).toFixed(1)}px, 0)`;
      el.style.visibility = "";
    };
    const t = setTimeout(() => (place(), input.current?.focus({ preventScroll: true })), 0);
    const off = frame.add(place);
    return () => (clearTimeout(t), off());
  }, [shut, id, canvasId]);
  if (shut) return null;
  // who gets it: the agent's own session, or — for a sub-agent — the session that dispatched it
  const sub = !f.run.sessionId;
  const to = f.root;
  const send = async () => {
    const words = text.trim();
    if (!words || busy || !to.sessionId) return;
    setBusy(true);
    setErr(null);
    try {
      const sid = to.sessionId;
      const state = sendState(sid); // before the send: is a turn running now?
      const sentAt = Date.now() - 1500; // the log's clock and the page's are one machine's; a little slack
      await agents.send(sid, sub ? `关于子代理 ${f.run.name}${f.run.task ? `（${f.run.task}）` : ""}：${words}` : words, { canvasId });
      const agent = agentName(agents.get().bindings[sid]?.agent);
      setSent({ agent, state });
      stop.current = watchDelivery(sid, words, sentAt, () => {
        setSent({ agent, state: "delivered" });
        talk.said(to.id);
        setTimeout(() => setShut(true), 4000);
      });
    } catch (e) {
      setErr(`没发出去：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ws-talk" ref={box} style={{ visibility: "hidden" }} data-esc-local onPointerDown={(e) => e.stopPropagation()}>
      {sent ? (
        <p className="ws-talk-note" role="status" data-state={sent.state}>{deliveryNote(sent.agent, sent.state)}</p>
      ) : (
      <input
        ref={input}
        value={text}
        placeholder={sub ? `对 ${f.run.name} 说…` : `对 ${f.run.name} 说…（回车发送）`}
        aria-label={`对 ${f.run.name} 说`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setShut(true);
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      )}
      {sub && !sent && (
        <p className="ws-talk-sub">
          子代理不能直接对话，发给派它的 {to.name}？
          <button disabled={busy || !text.trim()} onClick={() => void send()}>改发给 {to.name}</button>
        </p>
      )}
      {err && <p className="ws-talk-err" role="alert">{err}</p>}
    </div>
  );
}
