// 工位视图 (docs/workstation.md): an optional view on a canvas. Each agent session is a small
// worker that walks to the node whose code it reads or writes and works there; a timeline below
// has one lane per session (read / write / command / thinking / waiting for the person), and
// dragging it replays the workers and the progress pointers from the logs. The ordinary pointers
// are unchanged; this only adds a layer.
import { useMemo, useRef, useState } from "react";
import { IconClose, IconHistory, IconPause, IconPlay, IconUser } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { footprint, inflate, type Box } from "../canvas/clearance";
import { clipPath } from "../canvas/chrome";
import { live } from "../canvas/scene";
import { effectiveLinks } from "../nested/graph";
import { useNested } from "../nested/store";
import { elementFor } from "../pointer/codeLinks";
import { useFollowedSession } from "../pointer/follow";
import { useSessionLabel } from "../pointer/PointerLayer";
import { activeSessions } from "../multi/pointers";
import { useSessionFolds } from "../multi/writes";
import { AgentAvatar } from "../session/AgentAvatar";
import { useAgents, type AgentKind, type Item } from "../session/agents";
import { highlight, openTrajectory, ui } from "../session/ui";
import { clock, prefersReducedMotion, replayTime, useNow, useReplay, useWorkstation } from "./clock";
import { FIGURE, Figure } from "./Figure";
import { buildAxis, buildLane, figureAt, HOME, OUTSIDE, SEG_NAMES, segAt, WALK_MS, type Lane, type Seg, type SegKind } from "./timeline";
import "./workstation.css";

const KINDS: (SegKind | "idle")[] = ["read", "write", "exec", "think", "wait", "idle"];
const SPEEDS = [1, 4, 16, 60];
const hhmm = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const laneCache = new WeakMap<readonly Item[], { key: string; lane: Lane }>();
/** Lanes for every bound session that has done something (memoised per transcript). */
function useLanes(now: number): Lane[] {
  const ag = useAgents();
  const root = rootHint();
  const sec = Math.floor(now / 1000);
  return useMemo(() => {
    const out: Lane[] = [];
    for (const sid of Object.keys(ag.bindings)) {
      const items = ag.items[sid] ?? [];
      const live = !!(ag.status[sid]?.running || ag.status[sid]?.busy);
      const key = `${live}|${live ? sec : 0}`;
      let hit = laneCache.get(items);
      if (!hit || hit.key !== key) {
        // A running turn reaches a little past "now", so the worker is never idle between refreshes.
        hit = { key, lane: buildLane(sid, items, { live, now: (sec + 2) * 1000, root }) };
        laneCache.set(items, hit);
      }
      if (hit.lane.segs.length) out.push(hit.lane);
    }
    return out.sort((a, b) => a.turns[0].start - b.turns[0].start);
  }, [ag.bindings, ag.items, ag.status, sec, root]);
}
/** The project root, for reading tool inputs (absolute paths) as project-relative files. */
let rootValue = "";
export const setWorkstationRoot = (r: string) => void (rootValue = r);
const rootHint = () => rootValue;

/** The top-right switch: 工位视图 on / off for this canvas. */
export function WorkstationToggle({ canvasId }: { canvasId: string }) {
  const on = useWorkstation(canvasId);
  return (
    <button className="ws-toggle ws-ui" aria-pressed={on} onClick={() => clock.toggle(canvasId)} title={on ? "关闭工位视图" : "工位视图：每个会话一个小人，在它读写的节点旁工作；下方时间线可回放"}>
      <IconUser size={14} />
      工位视图
    </button>
  );
}

/** The workers, drawn over the diagram. */
export function Workers({ view, chrome = [] }: { view: CanvasViewState; chrome?: Box[] }) {
  const replay = useReplay();
  const still = prefersReducedMotion();
  const now = useNow(true);
  const t = replay ? replayTime(replay, now) : now;
  const lanes = useLanes(now);
  const folds = useSessionFolds();
  const followed = useFollowedSession();
  const st = useNested();
  const ag = useAgents();
  const label = useSessionLabel();
  const links = useMemo(() => effectiveLinks(view.id, new Map(st.scenes).set(view.id, view.elements)), [view.id, view.elements, st.scenes]);
  const locate = useMemo(() => {
    const cache = new Map<string, string | null>();
    return (p: string) => {
      if (!cache.has(p)) cache.set(p, elementFor(p, links)?.link.id ?? null);
      return cache.get(p)!;
    };
  }, [links]);
  // Live: the active sessions. Replay: everyone who had started by then.
  const shown = useMemo(() => {
    if (replay) return lanes.filter((l) => l.turns[0].start <= t);
    const ids = activeSessions(folds.map((f) => f.sessionId), (id) => {
      const f = folds.find((x) => x.sessionId === id)!;
      return { lastAt: f.lastAt, running: f.running };
    }, now, followed);
    return lanes.filter((l) => ids.includes(l.sessionId));
  }, [lanes, replay ? Math.floor(t / 1000) : 0, !!replay, folds, followed, Math.floor(now / 30_000)]);

  const a = view.appState;
  const z = a.zoom.value;
  const states = shown.map((l) => ({ l, s: figureAt(l, t, locate, still ? 0 : WALK_MS) }));
  // Slots: workers at the same spot stand side by side.
  const slot = new Map<string, number>();
  const count = new Map<string, number>();
  for (const { l, s } of states) {
    const k = s.at;
    slot.set(l.sessionId, count.get(k) ?? 0);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const spot = (where: string, i: number, n: number) => {
    const step = FIGURE.W + 4;
    if (where === OUTSIDE || where === HOME || !view.map.get(where) || !live(view.map.get(where))) {
      // The desk for work outside the diagram (and home before any work): bottom right.
      const x = a.width - 76 - i * step;
      return { x, y: a.height - (where === HOME ? 112 : 170) };
    }
    const el = view.map.get(where)!;
    const b = footprint(el, view.map, view.elements);
    const r = inflate({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z }, 6);
    // Stand just below the node's left end, side by side (arrows usually leave from the middle).
    return { x: r.x + 2 + i * step, y: r.y + r.h + 4 };
  };
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  return (
    <div className="ws-layer" style={{ clipPath: clipPath({ x: 0, y: 0, w: a.width, h: a.height }, chrome) }}>
      {(count.get(OUTSIDE) ?? 0) > 0 && (
        <span className="ws-desk" style={{ transform: `translate(${snap(a.width - 76 - ((count.get(OUTSIDE) ?? 1) - 1) * (FIGURE.W + 4) - 10)}px, ${snap(a.height - 170 + FIGURE.H)}px)` }}>
          图外
        </span>
      )}
      {states.map(({ l, s }) => {
        const n = count.get(s.at) ?? 1;
        const to = spot(s.at, slot.get(l.sessionId) ?? 0, n);
        const from = spot(s.from, 0, 1);
        const k = ease(s.walk);
        const x = s.walk < 1 ? from.x + (to.x - from.x) * k : to.x;
        const y = s.walk < 1 ? from.y + (to.y - from.y) * k : to.y;
        const kind = ag.bindings[l.sessionId]?.agent as AgentKind | undefined;
        const name = label(l.sessionId, shown.map((x) => x.sessionId));
        const doing = s.seg ? s.seg.label : s.pose === "idle" ? SEG_NAMES.idle : "";
        return (
          <button
            key={l.sessionId}
            className="ws-worker ws-ui"
            data-followed={l.sessionId === followed || undefined}
            style={{ transform: `translate(${snap(x)}px, ${snap(y)}px)` }}
            onClick={() => ui.openSession(l.sessionId)}
            title={`${name} · ${doing}`}
            aria-label={`${name}：${doing}`}
          >
            <Figure kind={kind} pose={s.pose} t={t} still={still} faded={s.pose === "idle"} />
            {/* Idle workers go without a caption (the faded figure says it); busy neighbours stagger theirs. */}
            {s.pose !== "idle" && (
              <span className="ws-cap" style={(slot.get(l.sessionId) ?? 0) % 2 ? { transform: "translateY(18px)" } : undefined}>
                {s.pose === "walk" ? "走过去" : doing}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The timeline under the canvas: one lane per session; drag to replay, click a piece to jump. */
export function TimelinePanel({ canvasId, view }: { canvasId: string; view: CanvasViewState | null }) {
  const replay = useReplay();
  const now = useNow(!!replay?.playing || !replay);
  const lanes = useLanes(now);
  const ag = useAgents();
  const label = useSessionLabel();
  const st = useNested();
  const [open, setOpen] = useState(true);
  // The axis runs to "now" in both modes, so switching to replay (or dragging) does not rescale it.
  const axis = useMemo(() => buildAxis(lanes, { now: Math.floor(now / 1000) * 1000 }), [lanes, Math.floor(now / 1000)]);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const t = replay ? replayTime(replay, now) : now;
  const links = useMemo(() => (view ? effectiveLinks(view.id, new Map(st.scenes).set(view.id, view.elements)) : []), [view?.id, view?.elements, st.scenes]);
  if (!axis) {
    return (
      <section className="ws-panel ws-ui" aria-label="工位时间线">
        <header className="ws-head-row">
          <IconHistory size={14} />
          <b>工位时间线</b>
          <span className="ws-empty">还没有会话做过事。开一个会话让它改代码，这里会出现它的泳道。</span>
          <button className="icon-btn sm muted" aria-label="关闭工位视图" onClick={() => clock.toggle(canvasId)}><IconClose size={14} /></button>
        </header>
      </section>
    );
  }
  const pct = (time: number) => (axis.toX(time) / axis.span) * 100;
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return axis.fromX(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * axis.span);
  };
  const jump = (lane: Lane, seg: Seg) => {
    clock.seek(seg.start + (seg.end - seg.start) / 2, axis.end); // mid-call: the worker is at it
    ui.openSession(lane.sessionId);
    setTimeout(() => openTrajectory(lane.sessionId, seg.turn), 120);
    const el = seg.path ? elementFor(seg.path, links)?.link.id : undefined;
    if (el) {
      highlight.set({ canvasId, ids: [el] });
      setTimeout(() => highlight.get()?.ids[0] === el && highlight.set(null), 2200);
    }
  };
  const playing = !!replay?.playing;
  return (
    <section className="ws-panel ws-ui" data-open={open} aria-label="工位时间线">
      <header className="ws-head-row">
        <button className="ws-fold" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "收起时间线" : "展开时间线"}>
          <IconHistory size={14} />
          <b>工位时间线</b>
        </button>
        <ul className="ws-legend" aria-label="图例">
          {KINDS.map((k) => (
            <li key={k} data-kind={k}>
              <i />
              {SEG_NAMES[k]}
            </li>
          ))}
        </ul>
        <span className="ws-gap" />
        <time className="ws-time" data-replay={!!replay || undefined}>{replay ? `回放 ${hhmm(t)}` : `实时 ${hhmm(now)}`}</time>
        <button
          className="icon-btn sm"
          aria-label={playing ? "暂停回放" : "从头回放"}
          title={playing ? "暂停" : replay ? "从这里播放" : "从头回放"}
          onClick={() => (playing ? clock.pause() : clock.play(replay ? (t >= axis.end ? axis.start : t) : axis.start, axis.end))}
        >
          {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
        </button>
        <select className="ws-speed" value={replay?.speed ?? 4} onChange={(e) => (replay ? clock.speed(Number(e.target.value)) : clock.play(axis.start, axis.end, Number(e.target.value)))} aria-label="回放速度">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
        {replay && (
          <button className="btn sm quiet" onClick={() => clock.live()}>
            回到实时
          </button>
        )}
        <button className="icon-btn sm muted" aria-label="关闭工位视图" title="关闭工位视图" onClick={() => clock.toggle(canvasId)}>
          <IconClose size={14} />
        </button>
      </header>
      {open && (
        <div className="ws-lanes">
          <div className="ws-names">
            {lanes.map((l) => {
              const kind = ag.bindings[l.sessionId]?.agent as AgentKind | undefined;
              return (
                <button key={l.sessionId} className="ws-name" onClick={() => ui.openSession(l.sessionId)} title="打开这个会话">
                  {kind && <AgentAvatar kind={kind} size={16} />}
                  <span>{label(l.sessionId, lanes.map((x) => x.sessionId))}</span>
                </button>
              );
            })}
          </div>
          <div
            className="ws-track"
            ref={track}
            style={{ height: lanes.length * 26 }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, moved: false };
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              if (Math.abs(e.clientX - drag.current.x) > 3) drag.current.moved = true;
              if (drag.current.moved) clock.seek(timeAt(e.clientX), axis.end);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (!d) return;
              if (d.moved) return clock.seek(timeAt(e.clientX), axis.end);
              // A click: the piece under it (a few px of slop), else just move the playhead.
              const r = track.current!.getBoundingClientRect();
              const row = Math.floor((e.clientY - r.top) / 26);
              const lane = lanes[row];
              const x = ((e.clientX - r.left) / r.width) * axis.span;
              const seg = lane && segAt(lane, axis, x, (4 / r.width) * axis.span);
              if (lane && seg) jump(lane, seg);
              else clock.seek(timeAt(e.clientX), axis.end);
            }}
            role="slider"
            aria-label="回放位置"
            aria-valuemin={axis.start}
            aria-valuemax={axis.end}
            aria-valuenow={Math.round(t)}
            aria-valuetext={hhmm(t)}
            tabIndex={0}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 60_000 : 5_000;
              if (e.key === "ArrowLeft") clock.seek(Math.max(axis.start, t - step), axis.end);
              if (e.key === "ArrowRight") clock.seek(Math.min(axis.end, t + step), axis.end);
              if (e.key === "Escape") clock.live();
            }}
          >
            {lanes.map((l, i) => (
              <div key={l.sessionId} className="ws-lane" style={{ top: i * 26 }}>
                {l.segs.map((s) => (
                  <span
                    key={`${s.kind}${s.start}`}
                    className="ws-seg"
                    data-kind={s.kind}
                    style={{ left: `${pct(s.start)}%`, width: `max(2px, ${pct(s.end) - pct(s.start)}%)` }}
                    title={`${SEG_NAMES[s.kind]} · ${s.label} · 第 ${s.turn} 轮 · ${hhmm(s.start)}–${hhmm(s.end)}`}
                  />
                ))}
              </div>
            ))}
            {axis.breaks.map((b) => (
              <span key={b.from} className="ws-break" style={{ left: `${(b.x / axis.span) * 100}%` }} title={`空闲 ${Math.round((b.to - b.from) / 60_000)} 分钟（已压缩）`} />
            ))}
            <span className="ws-playhead" data-replay={!!replay || undefined} style={{ left: `${pct(Math.min(t, axis.end))}%`, height: lanes.length * 26 }} />
          </div>
          <div className="ws-axis">
            <time>{hhmm(axis.start)}</time>
            <time>{hhmm(axis.end)}</time>
          </div>
        </div>
      )}
    </section>
  );
}
