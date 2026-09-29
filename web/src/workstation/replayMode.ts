// PR 回放 mode (web/docs/workstation.md「PR 回放」): which merged PR is being played, and the run that
// stands in for the sessions while it is. The data is the server's `GET /api/project/replays` (a list)
// and `/api/project/replays/<id>` (a PR's commits); the run is ./replay.ts's `replayRun`, made with the
// main canvas's own picture (nodes, sub-diagrams, walking times), so it follows the diagram. While a PR
// plays the runs store (./runs/store.ts) shows this one run and nothing else. `?replay=<id>` opens one
// at load; Esc leaves.
import { useSyncExternalStore } from "react";
import { backHintQuiet } from "../nested/up";
import { layoutSaves } from "../layoutSaves";
import { nested } from "../nested/store";
import { clock, replayTime } from "./clock";
import { canvasWhere, DOOR_MS, OUTSIDE, planFor } from "./place";
import { replayRun, type ReplayCtx, type ReplayItem, type ReplaySpec } from "./replay";
import type { WorkRun } from "./runs/types";
import { createCamera } from "./replayView";
import { subviewCtx } from "./subview";

export type ReplayState = {
  /** The list, once it has answered (empty: this server has none). */
  items: ReplayItem[] | null;
  /** The PR now played. */
  id: string | null;
  spec: ReplaySpec | null;
  /** A 连播's PRs in play order (empty when one is played alone). */
  series: string[];
  loading: boolean;
  error: string | null;
  /** The summary, said by the bar when the badge over the node has no clear place. */
  barNote: string | null;
  /** The person has taken the camera (panned or zoomed): it does not follow until 「跟随小人」. Only for this replay. */
  manual: boolean;
};

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
let state: ReplayState = { items: null, id: null, spec: null, series: [], loading: false, error: null, barNote: null, manual: false };
const ls = new Set<() => void>();
const set = (p: Partial<ReplayState>) => {
  const was = !!state.id;
  state = { ...state, ...p };
  // the layout is not saved while the camera moves the view around: paused as the replay starts (what was pending is written first)
  if (!was && state.id) layoutSaves.pause(true);
  // no 「在子图里」 hint over the menu while the camera goes in and out by itself
  backHintQuiet.set(!!state.id);
  ls.forEach((l) => l());
};
/** The canvas the PR is drawn on (the one it was started from). */
let main: string | null = null;
/** When the run starts (ms): set once per PR so it lies just before now. */
let anchor = 0;
let started = "";

const mainCanvas = () => (main ??= [...canvasWhere.keys()].find((k) => !k.startsWith("follow:")) ?? null);
/** The camera: the main view follows the figure into sub-diagrams (./replayView.ts). */
const camera = createCamera(() => (state.id ? mainCanvas() : null), () => (state.id ? run() : null), { setManual: (on) => state.manual !== on && set({ manual: on }) });
const byMerged = (items: readonly ReplayItem[]) => [...items].sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.number - b.number));

/** What the run needs to know of the diagram: main canvas `id`'s places, docks and walking times (null until its overlay has published them). */
function envOf(id: string): ReplayCtx | null {
  const where = canvasWhere.get(id);
  if (!where) return null;
  const st = nested.get();
  const sub = subviewCtx(id, st.scenes, st.titles, () => undefined);
  const loc = (p: string) => where.ctx.locate(p);
  const mainPlace = (p: string) => loc(p)?.place ?? OUTSIDE;
  return {
    place: (p) => sub.place(p),
    dock: (p) => {
      const pl = mainPlace(p);
      return pl === OUTSIDE ? null : where.ctx.dock(pl);
    },
    // the walk between two nodes as the figure will walk it (./rig.ts), and a door each way into a sub-diagram
    walkMs: (from, to) => {
      if (from == null) return 0;
      const a = mainPlace(from);
      const b = mainPlace(to);
      const trip = a === b ? 0 : (() => { const t = planFor({ from: a, to: b, t: 0, slot: 0 }, where.ctx); return t.t1 - t.t0; })();
      return trip + (loc(to)?.portal && a !== b ? DOOR_MS : 0) + (loc(from)?.portal && a !== b ? DOOR_MS : 0);
    },
  };
}

const made = new WeakMap<object, { key: string; run: WorkRun }>();
/** The PR's run on the main canvas (memoised on the diagram's context and scenes), or null. */
function run(): WorkRun | null {
  const spec = state.spec;
  const id = mainCanvas();
  if (!spec || !id) return null;
  const where = canvasWhere.get(id);
  const env = envOf(id);
  if (!where || !env) return null;
  const st = nested.get();
  const key = `${spec.id}|${anchor}`;
  const memo = made.get(where.ctx);
  if (memo && memo.key === key && (memo as { scenes?: unknown }).scenes === st.scenes) return memo.run;
  if (!anchor || started !== spec.id) {
    // it lies just before now, so the strip's axis has no idle stretch before it
    const len = replayRun(spec, env, 0);
    anchor = Date.now() - (len.lastAt - 0) - 4000;
  }
  const r = replayRun(spec, env, anchor);
  made.set(where.ctx, Object.assign({ key, run: r }, { scenes: st.scenes }));
  if (started !== spec.id) {
    started = spec.id;
    // from a moment before its first beat, playing at 1× (the timeline's own play and slow-motion buttons take over)
    queueMicrotask(() => clock.play(r.segs[0].start - 400, r.lastAt - 1, 1));
  }
  return r;
}

async function loadList() {
  if (state.items || state.loading) return;
  set({ loading: true });
  try {
    const res = await fetch("/api/project/replays");
    if (!res.ok) throw new Error(res.statusText);
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body) ? body : ((body as { replays?: unknown }).replays ?? (body as { items?: unknown }).items ?? []);
    set({ items: byMerged(list as ReplayItem[]), loading: false });
  } catch (e) {
    // a server without replays (404) or down: none to offer; try again in a minute
    set({ items: [], loading: false, error: String((e as Error).message) });
  }
}

async function open(id: string, canvasId?: string, series?: string[]) {
  if (canvasId) main = canvasId;
  started = "";
  anchor = 0;
  set({ id, spec: null, series: series ?? state.series, error: null });
  try {
    const res = await fetch(`/api/project/replays/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.statusText);
    const spec = (await res.json()) as ReplaySpec;
    if (state.id !== id) return;
    set({ spec });
  } catch (e) {
    if (state.id === id) set({ id: null, spec: null, series: [], error: String((e as Error).message) });
  }
}

const order = () => byMerged(state.items ?? []).map((x) => x.id);
/** Everything the page shows of the mode. */
export const replays = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  run,
  active: () => !!state.id,
  load: () => void loadList(),
  resumeFollow: () => camera.resume(),
  setBarNote: (note: string | null) => void (state.barNote !== note && set({ barNote: note })),
  /** Play one PR. */
  open: (id: string, canvasId?: string) => void open(id, canvasId, []),
  /** 连播: the latest `n` PRs, earliest merged first, one after another. */
  playLatest(n: number, canvasId?: string) {
    const ids = order().slice(-Math.max(1, n));
    if (ids.length) void open(ids[0], canvasId, ids.length > 1 ? ids : []);
  },
  /** The PR before / after this one: in a 连播, in its order; alone, in the list's. False at either end. */
  step(d: 1 | -1) {
    const ids = state.series.length ? state.series : order();
    const to = ids[ids.indexOf(state.id ?? "") + d];
    if (!state.id || ids.indexOf(state.id) < 0 || !to) return false;
    void open(to);
    return true;
  },
  exit() {
    if (!state.id) return;
    started = "";
    anchor = 0;
    set({ id: null, spec: null, series: [] });
    clock.live();
    // back to the canvas and the view the replay was entered from
    // …and saving comes back once the canvas and the view it was entered from are back (the layout is as it was: nothing to save)
    void camera.exit().then(() => (main = null, state.id || layoutSaves.pause(false)));
  },
  /** Position in a 连播: 1-based k of n, or null when one PR is played alone. */
  position: () => (state.series.length > 1 ? { k: state.series.indexOf(state.id ?? "") + 1, n: state.series.length } : null),
};

export const useReplays = () => useSyncExternalStore(replays.subscribe, replays.get);

// The end of a PR: a 连播 goes on to the next after a beat; one PR alone stays at its last frame.
if (typeof window !== "undefined") {
  let doneFor = "";
  window.setInterval(() => {
    if (!state.id || !state.spec) return void (doneFor = "");
    const r = run();
    const c = clock.get();
    if (!r || !c?.playing || doneFor === state.id) return;
    if (replayTime(c, Date.now()) >= r.lastAt - 1) {
      doneFor = state.id;
      const next = state.series[state.series.indexOf(state.id) + 1];
      if (next) window.setTimeout(() => state.id === doneFor && void open(next), 1200);
    }
  }, 400);
  window.setInterval(() => camera.tick(), 200);
  let lastFrame = 0;
  const loop = (n: number) => {
    if (state.id) camera.frame(lastFrame ? n - lastFrame : 16);
    lastFrame = n;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Esc leaves (before the app's own Esc: trace, follow, selection)
  addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !state.id) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.stopPropagation();
      replays.exit();
    },
    true,
  );
  const want = params.get("replay");
  if (want) queueMicrotask(() => (replays.load(), replays.open(want)));
}
