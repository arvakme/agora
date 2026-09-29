// 对小人说话 (web/docs/workstation.md §12): click a figure and a small input opens just under it;
// Enter sends the words to that agent's session (`agents.send`), Esc closes it. A sub-agent has no
// session of its own: the box says so and sends to the session that dispatched it instead, naming the
// sub-agent. After Enter the box says who got it — 已发给 Claude Code — and, when a turn is running, that it
// 会在这一轮结束后送达 (panel messages wait for the turn to end); the figure turns and nods when the message
// really shows up in the session, not when it is sent (./talk.ts `watchDelivery`). Mount it in the
// overlay's layer (screen coordinates of the canvas pane); it follows the selected figure's feet in
// the one frame loop. `data-esc-local`: the app's global Esc leaves it alone.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { viewport } from "../canvas/viewport";
import { agentName, agents } from "../session/agents";
import { figurePositions, useFocus } from "./focus";
import { frame } from "./frame";
import { excalidrawEl, occupiedOf } from "./replayDom";
import { useRuns } from "./runs/store";
import type { FlatRun } from "./runs/types";
import { deliveryNote, placeTalk, sendState, talk, talkDismissed, talkHost, talkTarget, watchDelivery, type SendState, type Side, type TBox } from "./talk";
import "./TalkBubble.css";

/**
 * Mounted by every view that draws figures (the canvas, a follow tab); only the one that really draws the
 * selected figure shows the box. `obstacles`: what the box keeps off, in world coordinates (nodes, labels).
 */
export function TalkBubble({ canvasId, obstacles }: { canvasId: string; obstacles: () => TBox[] }) {
  const fo = useFocus();
  const runs = useRuns();
  const id = fo.selected;
  const f = id ? runs.flat.find((x) => x.run.id === id) : undefined;
  useEffect(() => {
    if (!id) return;
    const report = () => talkHost.report(id, canvasId, !!figurePositions.get(canvasId, id));
    report();
    const off = frame.add(report);
    return () => (off(), talkHost.report(id, canvasId, false));
  }, [id, canvasId]);
  useEffect(() => void (talkDismissed.run !== id && (talkDismissed.run = null)), [id]);
  const host = useSyncExternalStore(talkHost.subscribe, () => (id ? talkHost.of(id) : null));
  // a new selection starts a new, empty box
  return f && host === canvasId ? <Talk key={f.run.id} f={f} canvasId={canvasId} obstacles={obstacles} /> : null;
}

function Talk({ f, canvasId, obstacles }: { f: FlatRun; canvasId: string; obstacles: () => TBox[] }) {
  const [shut, setShut0] = useState(() => talkDismissed.run === f.run.id);
  const setShut = (v: boolean) => (v && (talkDismissed.run = f.run.id), setShut0(v));
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ agent: string; state: SendState } | null>(null);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = f.run.id;
  // Under the figure's feet (bubbles sit above the heads); when that would cover a node or a label, above the
  // bubble or beside it (./talk.ts `placeTalk`), inside what the toolbar and the strip leave free — in the
  // view's pixels, every frame. Focus waits until after the click that selected the figure (its mousedown
  // focuses the figure, a button) and places the box first: a hidden input cannot take focus.
  const side = useRef<Side | null>(null);
  const obsRef = useRef(obstacles);
  obsRef.current = obstacles;
  const inset = useRef({ at: 0, top: 8, bottom: 8 });
  useEffect(() => {
    if (shut) return;
    const place = () => {
      const p = figurePositions.get(canvasId, id);
      const v = viewport.get(canvasId);
      const el = box.current;
      if (!el || !p || !v) return;
      // what covers the canvas's edges (Excalidraw's toolbar, the footer): measured from the DOM twice a second
      if (!canvasId.startsWith("follow:") && performance.now() - inset.current.at > 500) {
        const ex = excalidrawEl();
        const o = ex ? occupiedOf(ex) : { top: 0, bottom: 0 };
        inset.current = { at: performance.now(), top: o.top + 8, bottom: o.bottom + 8 };
      }
      const { top, bottom } = inset.current;
      const feet = { x: (p.x + v.scrollX) * v.zoom, y: (p.y + v.scrollY) * v.zoom };
      const obs = obsRef.current().map((b) => ({ x: (b.x + v.scrollX) * v.zoom, y: (b.y + v.scrollY) * v.zoom, w: b.w * v.zoom, h: b.h * v.zoom }));
      const r = placeTalk({ feet, size: { w: el.offsetWidth, h: el.offsetHeight }, area: { x: 8, y: top, w: Math.max(0, v.width - 16), h: Math.max(0, v.height - top - bottom) }, obstacles: obs, prev: side.current });
      side.current = r.side;
      el.dataset.side = r.side;
      el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`;
      el.style.visibility = "";
    };
    const t = setTimeout(() => (place(), input.current?.focus({ preventScroll: true })), 0);
    const off = frame.add(place);
    return () => (clearTimeout(t), off());
  }, [shut, id, canvasId]);
  const working = useSyncExternalStore(agents.subscribe, () => !!f.root.sessionId && sendState(f.root.sessionId) === "queued");
  const target = talkTarget({ name: f.run.name, hasSession: !!f.run.sessionId, rootName: f.root.name, working });
  if (shut) return null;
  // who gets it: the agent's own session, or — for a sub-agent — the session that dispatched it
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
      await agents.send(sid, target.prefix + words, { canvasId: canvasId.startsWith("follow:") ? canvasId.slice(7) : canvasId });
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
        placeholder={target.placeholder}
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
      {target.note && !sent && <p className="ws-talk-sub">{target.note}</p>}
      {err && <p className="ws-talk-err" role="alert">{err}</p>}
    </div>
  );
}
