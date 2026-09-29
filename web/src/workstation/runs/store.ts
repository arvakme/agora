// The runs the 工位视图 draws: one tree per bound session. Top-level runs come from the transcripts
// on the page; sub-agents from the server's run tree (`GET /api/agent/runs`, `fetchRuns` in
// session/agents.ts, converted by derive.ts `fromTree`). The scripted dev mock (`?mock=runs`,
// fixtures.ts) replaces all of it only when asked for (tests, demos). Recomputed on data events
// only (and once a second while something runs, since a running turn ends at "now"), never per frame.
import { useSyncExternalStore } from "react";
import { AGENT_NAMES, agents, fetchRuns, type AgentKind } from "../../session/agents";
import { sessionNames } from "../../multi/writes";
import { fromTree, runFromTranscript } from "./derive";
import { longWindow, scenario, scratchRun } from "./fixtures";
import { flatten, type WorkRun, type FlatRun } from "./types";

export type Runs = { roots: WorkRun[]; flat: FlatRun[]; byId: Map<string, WorkRun>; at: number };

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const MOCK = params.get("mock") === "runs";
// `&mockBase=<epoch ms>` pins the script's start (the fidelity capture lines it up with the prototype's clock).
const mockBase = Number(params.get("mockBase")) || Date.now() + 1500;
// The motion capture (scripts/motion-capture.ts) times its windows from here.
if (MOCK && typeof window !== "undefined") Object.assign(window, { __mockBase: mockBase });

let root = "";
export const setRunsRoot = (r: string) => void (root = r);

const empty: Runs = { roots: [], flat: [], byId: new Map(), at: 0 };
let value: Runs = empty;
const ls = new Set<() => void>();
/** Each session's sub-agents from the server's run tree, and which of its tool calls dispatched which. */
const trees = new Map<string, { children: WorkRun[]; dispatches: Map<string, string>; live: boolean }>();
const fetched = new Map<string, { items: unknown; at: number; inflight?: boolean }>();
let unsupportedUntil = 0;
const derived = new WeakMap<object, { key: string; run: WorkRun }>();

/** How a session is called: its agent, or its tab name when two sessions of one agent are around. */
export function runName(sessionId: string, bound: Record<string, { agent: AgentKind }>, names: Record<string, string>): string {
  const kind = bound[sessionId]?.agent;
  const agent = kind ? AGENT_NAMES[kind] : "Agent";
  const twins = Object.values(bound).filter((b) => b.agent === kind).length > 1;
  return twins && names[sessionId] ? names[sessionId] : agent;
}

function compute(): Runs {
  const now = Date.now();
  if (MOCK) {
    const roots = params.has("long") ? longWindow(now, 5, Number(params.get("long")) || 100) : [...scenario(mockBase, now), ...(params.has("scratch") ? [scratchRun(mockBase)] : [])];
    return { roots, flat: flatten(roots), byId: new Map(flatten(roots).map((f) => [f.run.id, f.run])), at: now };
  }
  const st = agents.get();
  const names = sessionNames.get();
  const roots: WorkRun[] = [];
  const sec = Math.floor(now / 1000);
  for (const [sid, b] of Object.entries(st.bindings)) {
    const items = st.items[sid] ?? [];
    const running = !!(st.status[sid]?.running || st.status[sid]?.busy);
    const name = runName(sid, st.bindings, names);
    const key = `${running}|${running ? sec : 0}|${name}|${root}`;
    let hit = derived.get(items);
    if (!hit || hit.key !== key) {
      hit = { key, run: runFromTranscript({ sessionId: sid, agent: b.agent, name, items, running, now: (sec + 2) * 1000, root }) };
      derived.set(items, hit);
    }
    let run = hit.run;
    if (!run.segs.length) continue;
    const tree = trees.get(sid);
    if (tree?.children.length) {
      // the parent's 派 segments name the run they dispatched
      const segs = tree.dispatches.size ? run.segs.map((g) => (g.itemId && tree.dispatches.has(g.itemId) ? { ...g, kind: "delegate" as const, child: tree.dispatches.get(g.itemId) } : g)) : run.segs;
      run = { ...run, segs, children: tree.children, running: run.running || tree.live, lastAt: Math.max(run.lastAt, ...tree.children.map((c) => c.lastAt)) };
    }
    roots.push(run);
    maybeFetch(sid, items, running || !!tree?.live);
  }
  // A session another session gave a task to is drawn once, as the run its giver sent (not also on its own).
  const given = new Set(roots.flatMap((r) => flatten(r.children).map((f) => f.run.dispatchSession)).filter(Boolean));
  const shown = roots.filter((r) => !(r.sessionId && given.has(r.sessionId)));
  roots.length = 0;
  roots.push(...shown);
  roots.sort((a, b) => a.segs[0].start - b.segs[0].start);
  const flat = flatten(roots);
  return { roots, flat, byId: new Map(flat.map((f) => [f.run.id, f.run])), at: now };
}

/**
 * The session's run tree from the server (`fetchRuns(sid, {items: true})`): again when its
 * transcript changes, and every 3 s while it or a sub-agent runs (a sub-agent's log grows while the
 * parent only waits). A server without run trees (404) is not asked again for a minute.
 */
function maybeFetch(sid: string, items: unknown, live: boolean) {
  const now = Date.now();
  if (now < unsupportedUntil) return;
  const f = fetched.get(sid);
  if (f && (f.inflight || now - f.at < 3000 || (f.items === items && !live))) return;
  fetched.set(sid, { items, at: now, inflight: true });
  void fetchRuns(sid, { items: true })
    .then((tree) => {
      const t = fromTree(tree, sid, { now: Date.now(), root, name: (k) => AGENT_NAMES[k] ?? k });
      trees.set(sid, { ...t, live: flatten(t.children).some((x) => x.run.running) });
      refresh();
    })
    .catch((e: Error) => {
      if (/not found|404|unknown/i.test(String(e.message))) unsupportedUntil = Date.now() + 60_000;
    })
    .finally(() => {
      const g = fetched.get(sid);
      if (g) g.inflight = false;
    });
}

let scheduled = false;
function refresh() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    value = compute();
    ls.forEach((l) => l());
  });
}

let timer = 0;
function start() {
  if (timer) return;
  const offA = agents.subscribe(refresh);
  const offN = sessionNames.subscribe(refresh);
  // Running turns end at "now": refresh once a second while anything runs (or the mock plays).
  timer = window.setInterval(() => {
    if (MOCK || value.flat.some((f) => f.run.running)) refresh();
  }, 1000);
  value = compute();
  stop = () => (offA(), offN(), clearInterval(timer), (timer = 0));
}
let stop = () => {};

export const runs = {
  get: () => value,
  subscribe(l: () => void) {
    ls.add(l);
    start();
    return () => {
      ls.delete(l);
      if (!ls.size) stop();
    };
  },

  mock: MOCK,
};

export const useRuns = () => useSyncExternalStore(runs.subscribe, runs.get);
