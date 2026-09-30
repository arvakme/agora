// ▶ 看这张图是怎么搭起来的 (web/docs/share-build-replay.md): the owner's page plays a canvas back from its starting picture, one thing
// at a time — the agent's figure walks to where each thing is drawn (bridges, ladders, doors into sub-diagrams), says in words what it does,
// and the canvas grows when it has got there. Idle time is gone; play, pause, speed and a scrubber. The data is the server's
// `/api/project/build` (sanitized: nothing here is not something a guest of the canvas may see, §4); the figures are the ordinary 工位视图 on a world
// of the replay's own (./sources.ts), so nothing of the page's canvases or sessions is touched.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { IconClose, IconSend } from "../app/icons";
import { GUEST } from "../guest/mode";
import { NestedSource } from "../nested/store";
import { clock, useTick } from "../workstation/clock";
import { canvasWhere } from "../workstation/place";
import { RunsSource } from "../workstation/runs/store";
import { presenceAt, subviewCtx } from "../workstation/subview";
import { BuildStage } from "./BuildStage";
import { geometryWalk } from "./geometryWalk";
import { beatAt, beatOfStep, defaultSpeed, planBuild, runId as figureId, SPEEDS, type Mode, type Plan } from "./plan";
import { BuildWorld, realId, worldId } from "./sources";
import { buildReplay, useBuildReplay } from "./store";
import type { BuildTimeline } from "./types";
import "./buildreplay.css";

/** The replay's clock: a moment long ago, so that nothing of the page's live runs is anywhere near it. */
const EPOCH = 1_700_000_000_000;
/** Play never reaches its end by the clock's own rule (that would end the replay): the player stops at the end itself. */
const FAR = EPOCH + 1e13;
const SWAP_MS = 300;

/** Mounted once (the ⋯ menu, a guest's page): the replay when it is open. `?buildreplay=<canvas>` opens it on load. */
export function BuildReplayHost() {
  const canvas = useBuildReplay();
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("buildreplay");
    if (q && !GUEST) buildReplay.open(q);
  }, []);
  return canvas ? createPortal(<BuildReplay canvas={canvas} onClose={buildReplay.close} />, document.body) : null;
}

type Load = { state: "loading" } | { state: "error"; text: string } | { state: "ready"; tl: BuildTimeline };

const MODE_KEY = "agora.buildReplayMode";
/** 精简 (the default) or 逐步, as this browser last chose. */
function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "steps" ? "steps" : "brief";
  } catch {
    return "brief";
  }
}
/** What the player starts from: the mode, the step to be at (null: the start) and whether it plays. Changing the mode keeps the step being watched. */
type Start = { mode: Mode; step: number | null; playing: boolean };

function BuildReplay({ canvas, onClose }: { canvas: string; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [start, setStart] = useState<Start>(() => ({ mode: readMode(), step: buildReplay.step(), playing: buildReplay.step() == null }));
  const setMode = (mode: Mode, step: number, playing: boolean) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode: this time only */
    }
    setStart({ mode, step, playing });
  };
  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ state: "loading" });
    // a guest gets the share's canvas only, and only when the owner allowed it (the server decides); the owner asks for any canvas
    void fetch(GUEST ? "/api/guest/build" : `/api/project/build?canvas=${encodeURIComponent(canvas)}`, { signal: ctl.signal, credentials: "same-origin" })
      .then(async (r) => (r.ok ? ((await r.json()) as BuildTimeline) : Promise.reject(new Error(((await r.json().catch(() => ({}))) as { detail?: string }).detail ?? r.statusText))))
      .then((tl) => setLoad({ state: "ready", tl }))
      .catch((e: Error) => e.name !== "AbortError" && setLoad({ state: "error", text: e.message }));
    return () => ctl.abort();
  }, [canvas]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div className="br-root" role="dialog" aria-label="这张图是怎么搭起来的">
      {load.state === "ready" && load.tl.steps.length ? (
        <Player key={start.mode} tl={load.tl} start={start} onMode={setMode} onClose={onClose} />
      ) : (
        <div className="br-empty">
          <button className="icon-btn br-x" onClick={onClose} aria-label="关闭">
            <IconClose size={16} />
          </button>
          <p>{load.state === "loading" ? "正在整理这张图的搭建过程…" : load.state === "error" ? `读不到：${load.text}` : "这张图还没有记录下搭建过程，没有可回放的内容。"}</p>
        </div>
      )}
    </div>
  );
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function Player({ tl, start, onMode, onClose }: { tl: BuildTimeline; start: Start; onMode: (m: Mode, step: number, playing: boolean) => void; onClose: () => void }) {
  const plan = useMemo(() => planBuild(tl, { ...geometryWalk(tl), author: GUEST, mode: start.mode }), [tl, start.mode]);
  const world = useMemo(() => new BuildWorld(tl, plan, EPOCH), [tl, plan]);
  const [playing, setPlaying] = useState(start.playing);
  const [speed, setSpeed] = useState(() => defaultSpeed(plan.length));
  // a comment's moment opens it there: paused on the step it was made at
  const from = useMemo(() => {
    return start.step == null ? 0 : (beatOfStep(plan, start.step)?.start ?? 0);
  }, [plan]);
  const [t, setT] = useState(from);
  const main = worldId(tl.root);
  // the clock: from the start; the world follows it; at the end it stops there
  const state = useRef({ playing, speed });
  state.current = { playing, speed };
  useEffect(() => {
    world.setTime(from);
    if (state.current.playing) clock.play(EPOCH + from, FAR, state.current.speed);
    else clock.seek(EPOCH + from, FAR);
    const tick = window.setInterval(() => {
      const now = clock.time() - EPOCH;
      world.setTime(now);
      if (now >= plan.length && state.current.playing) {
        clock.seek(EPOCH + plan.length, FAR);
        setPlaying(false);
      }
      setT(Math.min(now, plan.length));
    }, 100);
    return () => (clearInterval(tick), clock.live());
  }, [world, plan, from]);
  const seek = (at: number) => {
    const v = Math.max(0, Math.min(plan.length, at));
    world.setTime(v);
    if (state.current.playing && v < plan.length) clock.play(EPOCH + v, FAR, state.current.speed);
    else (clock.seek(EPOCH + v, FAR), setPlaying(false));
    setT(v);
  };
  const toggle = () => {
    if (playing) (clock.pause(), setPlaying(false));
    else (seek(t >= plan.length ? 0 : t), setPlaying(true), clock.play(EPOCH + (t >= plan.length ? 0 : t), FAR, speed));
  };
  const faster = (s: number) => (setSpeed(s), clock.speed(s));

  const beat = beatAt(plan, t);
  const actor = plan.actors.find((a) => a.key === beat?.actor) ?? plan.actors[0];
  const runId = figureId(actor?.key ?? "");
  const nst = useSyncExternalStore(world.nested.subscribe, world.nested.get);
  const runs = world.runs.get();

  // where the figure is: the deepest canvas its work is in (with the doors: ../workstation/subview.ts)
  useTick(250);
  const ctx = useMemo(() => subviewCtx(main, nst.scenes, nst.titles, (id) => runs.byId.get(id), () => canvasWhere.get(main)?.ctx), [main, nst.scenes, nst.titles, runs]);
  const now = clock.time();
  const ps = new Map(runs.flat.map((x) => [x.run.id, presenceAt(x.run, now, ctx)] as const));
  const levels = ps.get(runId)?.levels ?? null;
  const target = levels?.[levels.length - 1]?.canvasId ?? main;
  const [layers, setLayers] = useState<{ canvasId: string; out: boolean }[]>([]);
  const current = layers.find((l) => !l.out)?.canvasId;
  if (current !== target) setLayers(!current ? [{ canvasId: target, out: false }] : [...layers.filter((l) => l.canvasId !== target).map((l) => ({ ...l, out: true })), { canvasId: target, out: false }]);
  useEffect(() => {
    if (!layers.some((l) => l.out)) return;
    const tm = window.setTimeout(() => setLayers((ls) => ls.filter((l) => !l.out)), SWAP_MS + 40);
    return () => clearTimeout(tm);
  }, [layers]);

  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const crumbs = [...(levels ?? []).map((l) => l.title || realId(l.canvasId))];
  return (
    <RunsSource.Provider value={world.runs}>
      <NestedSource.Provider value={world.nested}>
        <header className="br-head">
          <div className="br-ttl">
            <b>这张图是怎么搭起来的</b>
            <span>{nst.titles[main]}</span>
            {crumbs.length > 1 && <span className="br-crumbs">{crumbs.join(" › ")}</span>}
          </div>
          <button className="icon-btn br-x" onClick={onClose} aria-label="关闭（Esc）" title="关闭（Esc）">
            <IconClose size={16} />
          </button>
        </header>
        <div className="br-main">
          <div className="br-body" ref={body}>
            {size && size.w > 0 && layers.map((l) => (
              <BuildStage
                key={l.canvasId}
                world={world}
                canvasId={l.canvasId}
                run={runId}
                size={size}
                out={l.out}
                only={(id) => id === runId || !!ps.get(id)?.levels?.some((lv) => lv.canvasId === l.canvasId)}
              />
            ))}
          </div>
          <div className="br-side">
            <Beats plan={plan} t={t} onSeek={(b) => seek(b.start)} names={Object.fromEntries(plan.actors.map((a) => [a.key, a.name]))} />
            <MomentComment step={beat?.step ?? 0} say={beat?.say ?? ""} />
          </div>
        </div>
        <footer className="br-bar">
          <button className="btn sm primary" onClick={toggle} aria-label={playing ? "暂停" : "播放"}>
            {playing ? "暂停" : t >= plan.length ? "重看" : "播放"}
          </button>
          <div className="seg br-mode" role="radiogroup" aria-label="演法" title="精简：小人在一片区域只走一次，够得着的就站着画，太远的直接换位置；逐步：每一件事都走到那里再画">
            {(["brief", "steps"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={start.mode === m} data-on={start.mode === m} onClick={() => start.mode !== m && onMode(m, beat?.step ?? 0, playing)}>
                {m === "brief" ? "精简" : "逐步"}
              </button>
            ))}
          </div>
          <div className="seg br-speed" role="radiogroup" aria-label="倍速">
            {SPEEDS.map((s) => (
              <button key={s} role="radio" aria-checked={speed === s} data-on={speed === s} onClick={() => faster(s)}>
                {s}×
              </button>
            ))}
          </div>
          <input className="br-scrub" type="range" min={0} max={plan.length} step={50} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="进度" />
          <span className="br-time">
            {fmt(t / speed)} / {fmt(plan.length / speed)}
          </span>
        </footer>
      </NestedSource.Provider>
    </RunsSource.Provider>
  );
}

/** Everything that was done, as a list: the current one lit, a click plays from there. */
function Beats({ plan, t, onSeek, names }: { plan: Plan; t: number; onSeek: (b: Plan["beats"][number]) => void; names: Record<string, string> }) {
  const cur = beatAt(plan, t)?.i ?? -1;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[data-cur]")?.scrollIntoView({ block: "nearest" });
  }, [cur]);
  return (
    <ol className="br-list" ref={list} aria-label="搭建过程">
      {plan.beats.map((b) => (
        <li key={b.i} data-cur={b.i === cur || undefined} data-done={b.land <= t || undefined} data-you={b.actor === "you" || undefined}>
          <button onClick={() => onSeek(b)} title={`${names[b.actor] ?? b.actor}：${b.say}`}>
            <span className="br-who">{names[b.actor] ?? b.actor}</span>
            {b.say}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** A comment on the whole canvas, noting the moment being watched (the step); it lands in the comment list like any other. */
function MomentComment({ step, say }: { step: number; say: string }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  if (!buildReplay.canComment()) return null;
  const send = () => {
    const v = text.trim();
    if (!v) return;
    buildReplay.comment(v, step);
    setText("");
    setSent(true);
    window.setTimeout(() => setSent(false), 4000);
  };
  return (
    <form className="br-comment" onSubmit={(e) => (e.preventDefault(), send())}>
      <label>
        <span>评论这一刻{say ? <em>「{say}」</em> : null}</span>
        <textarea rows={2} value={text} maxLength={4000} placeholder="对整张图或这一步说点什么…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), send())} />
      </label>
      <div className="br-comment-row">
        <span role="status">{sent ? "已发出，关掉回放后在评论列表里看" : ""}</span>
        <button type="submit" className="btn sm primary" disabled={!text.trim()} aria-label="发表评论"><IconSend size={14} />发送</button>
      </div>
    </form>
  );
}
