// 对小人说话 (web/docs/workstation.md §12): click a figure and a small input opens just under it;
// Enter sends the words to that agent's session (`agents.send`), Esc closes it. A sub-agent has no
// session of its own: the box says so and sends to the session that dispatched it instead, naming the
// sub-agent. After Enter the box says who got it — 已发给 Claude Code, or 已插话给 Claude Code when a turn was
// running and the CLI takes words into it (steer); a CLI that cannot asks first: 停下这一轮，改说这句 (Enter, the
// default) or 等这一轮做完再说 (../session/steerModel.ts). The figure turns and nods when the message
// really shows up in the session, not when it is sent (./talk.ts `watchDelivery`). Mount it in the
// overlay's layer (screen coordinates of the canvas pane); it follows the selected figure's feet in
// the one frame loop. `data-esc-local`: the app's global Esc leaves it alone.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { viewport } from "../canvas/viewport";
import { agentName, agents, steerOf } from "../session/agents";
import { CHOICES, defaultChoice, planSend, whyNoSteer, type SendMode } from "../session/steerModel";
import { InputRight } from "../session/InputRight";
import { figurePositions, useFocus } from "./focus";
import { boxesIn } from "./bubbles";
import { frame } from "./frame";
import { occupiedOf } from "./replayDom";
import { useRuns } from "./runs/store";
import type { FlatRun } from "./runs/types";
import { deliveryNote, placeTalk, sendState, talkDismissed, talkHost, talkSent, talkTarget, type SendState, type Side, type TBox } from "./talk";
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

/** What words to this session do now (../session/steerModel.ts). */
function sayPlan(sid: string) {
  const s = agents.get();
  return planSend({ running: !!s.status[sid]?.running, terminalAlive: !!s.status[sid]?.terminal.alive, ...steerOf(s.bindings[sid]?.agent, s.status[sid]) });
}

function Talk({ f, canvasId, obstacles }: { f: FlatRun; canvasId: string; obstacles: () => TBox[] }) {
  const [shut, setShut0] = useState(() => talkDismissed.run === f.run.id);
  const setShut = (v: boolean) => (v && (talkDismissed.run = f.run.id), setShut0(v));
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false); // the words are held while the person picks: stop and say it now, or wait
  // the note under the box is the module's (./talk.ts `talkSent`): it survives this box unmounting while the figure is in another view
  const sent = useSyncExternalStore(talkSent.subscribe, () => talkSent.get(f.run.id));
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = f.run.id;
  // Under the figure's feet (bubbles sit above the heads); when that would cover a node or a label, above the
  // bubble or beside it (./talk.ts `placeTalk`; the drawing and every shown bubble are what it keeps off), inside what the toolbar and the strip leave free — in the
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
        // the .excalidraw of this canvas's own pane, not the first one on the page
        const ex = el.closest<HTMLElement>("[data-pane]")?.querySelector<HTMLElement>(".excalidraw") ?? null;
        const o = ex ? occupiedOf(ex) : { top: 0, bottom: 0 };
        inset.current = { at: performance.now(), top: o.top + 8, bottom: o.bottom + 8 };
      }
      const { top, bottom } = inset.current;
      const feet = { x: (p.x + v.scrollX) * v.zoom, y: (p.y + v.scrollY) * v.zoom };
      const drawing = obsRef.current().map((b) => ({ x: (b.x + v.scrollX) * v.zoom, y: (b.y + v.scrollY) * v.zoom, w: b.w * v.zoom, h: b.h * v.zoom }));
      // the bubbles in this layer too (they move on their own): the box never sits over one, the selected figure's own included
      const layer = el.offsetParent;
      const bubbles = layer ? boxesIn(layer.getBoundingClientRect(), [...layer.querySelectorAll<HTMLElement>(".ws-bub-pos:not([data-folded]) > .ws-bub:not([data-exit])")].filter((b) => b.parentElement!.style.opacity !== "0").map((b) => b.getBoundingClientRect())) : [];
      const obs = [...drawing, ...bubbles];
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
  // what the words do now: into the running turn, a choice of two, or the ordinary send (../session/steerModel.ts)
  const planKind = useSyncExternalStore(agents.subscribe, () => (f.root.sessionId ? sayPlan(f.root.sessionId).kind : "send"));
  const target = talkTarget({ name: f.run.name, hasSession: !!f.run.sessionId, rootName: f.root.name, working, plan: planKind === "steer" || planKind === "choose" ? planKind : undefined });
  // closed by Esc, or after the delivery note had been up for a while
  const dismissed = useSyncExternalStore(talkSent.subscribe, () => talkDismissed.run === f.run.id);
  if (shut || dismissed) return null;
  // who gets it: the agent's own session, or — for a sub-agent — the session that dispatched it
  const to = f.root;
  const send = async (way?: "interrupt" | "wait") => {
    const words = text.trim();
    if (!words || busy || !to.sessionId) return;
    const sid = to.sessionId;
    const plan = sayPlan(sid);
    // an agent that cannot take words mid-turn: the box asks which way first (Enter takes the first), nothing is queued unasked
    if (plan.kind === "choose" && !way) return void setAsk(true);
    setBusy(true);
    setErr(null);
    try {
      const state: SendState = plan.kind === "steer" ? "steered" : plan.kind === "choose" ? (way === "interrupt" ? "interrupted" : "queued") : sendState(sid); // before the send: is a turn running now?
      const sentAt = Date.now() - 1500; // the log's clock and the page's are one machine's; a little slack
      const mode: SendMode | undefined = plan.kind === "steer" ? "steer" : plan.kind === "choose" ? way : undefined;
      await agents.send(sid, target.prefix + words, { canvasId: canvasId.startsWith("follow:") ? canvasId.slice(7) : canvasId, ...(mode && { mode }) });
      const agent = agentName(agents.get().bindings[sid]?.agent);
      setAsk(false);
      talkSent.start({ runId: f.run.id, nodId: to.id, sessionId: sid, words, sentAt, agent, state });
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
      ask ? (
        <div className="ws-talk-ways" role="group" aria-label="这一轮还在跑，你的话怎么说" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setAsk(false))}>
          <p className="ws-talk-sub">{whyNoSteer(agentName(agents.get().bindings[to.sessionId ?? ""]?.agent), steerOf(agents.get().bindings[to.sessionId ?? ""]?.agent, agents.get().status[to.sessionId ?? ""]).noSteer)}</p>
          <p className="ws-talk-sub">
            {CHOICES.map((c) => (
              <button key={c.mode} type="button" autoFocus={c.mode === defaultChoice()} disabled={busy} onClick={() => void send(c.mode)}>
                {c.label}
              </button>
            ))}
          </p>
        </div>
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
      ))}
      {target.note && !sent && <p className="ws-talk-sub">{target.note}</p>}
      {err && <p className="ws-talk-err" role="alert">{err}</p>}
      {to.sessionId && <InputRight sessionId={to.sessionId} />}
    </div>
  );
}
