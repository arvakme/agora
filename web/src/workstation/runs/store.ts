// The runs the 工位视图 draws: one tree per bound session. Top-level runs come from the transcripts
// on the page; sub-agents from the adapter layer's run trees when the server serves them (fetched
// again, at most every few seconds, when a session's transcript changes), or from the dev mock
// (`?mock=runs`, fixtures.ts). Recomputed on data events only (and once a second while a session
// runs, since its running turn ends at "now"), never per frame.
import { useSyncExternalStore } from "react";
import { AGENT_NAMES, agents, type AgentKind } from "../../session/agents";
import { sessionNames } from "../../multi/writes";
import { fetchRunTree } from "./client";
import { runFromTranscript } from "./derive";
import { scenario } from "./fixtures";
import { flatten, type AgentRun, type FlatRun } from "./types";

export type Runs = { roots: AgentRun[]; flat: FlatRun[]; byId: Map<string, AgentRun>; at: number };

const MOCK = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "runs";
const mockBase = Date.now() + 1500;

let root = "";
export const setRunsRoot = (r: string) => void (root = r);

const empty: Runs = { roots: [], flat: [], byId: new Map(), at: 0 };
let value: Runs = empty;
const ls = new Set<() => void>();
const trees = new Map<string, AgentRun>();
const fetched = new Map<string, { items: unknown; at: number }>();
const derived = new WeakMap<object, { key: string; run: AgentRun }>();

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
    const roots = scenario(mockBase, now);
    return { roots, flat: flatten(roots), byId: new Map(flatten(roots).map((f) => [f.run.id, f.run])), at: now };
  }
  const st = agents.get();
  const names = sessionNames.get();
  const roots: AgentRun[] = [];
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
    if (tree?.children.length) run = { ...run, children: tree.children, receipts: tree.receipts.length ? tree.receipts : run.receipts };
    roots.push(run);
    maybeFetch(sid, items);
  }
  roots.sort((a, b) => a.segs[0].start - b.segs[0].start);
  const flat = flatten(roots);
  return { roots, flat, byId: new Map(flat.map((f) => [f.run.id, f.run])), at: now };
}

function maybeFetch(sid: string, items: unknown) {
  const f = fetched.get(sid);
  if (f && (f.items === items || Date.now() - f.at < 3000)) return;
  fetched.set(sid, { items, at: Date.now() });
  void fetchRunTree(sid).then((tree) => {
    if (!tree) return;
    trees.set(sid, tree);
    refresh();
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
    if (MOCK || value.roots.some((r) => r.running)) refresh();
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
  /** Tests / dev: replace what the server would serve for a session. */
  setTree(sessionId: string, tree: AgentRun | null) {
    if (tree) trees.set(sessionId, tree);
    else trees.delete(sessionId);
    refresh();
  },
  mock: MOCK,
};

export const useRuns = () => useSyncExternalStore(runs.subscribe, runs.get);
