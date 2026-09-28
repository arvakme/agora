// Agent sessions on the page: each Agora session is one native Pi / Claude Code / Codex
// session (server/canvas/sessions.py). This store holds what the server pushes over
// /api/agent/events — the binding (agent, model, effort, native id; fixed once chosen),
// the transcript read from the CLI's own log, and live status — and sends messages.
// Canvas bridge requests from `agora canvas …` are executed by ./agentBridge.ts.
import { useSyncExternalStore } from "react";
import type { Origin } from "../persist";

/**
 * A CLI Agora has an adapter for (server/canvas/adapters/). Any string: the server's adapter
 * registry is the list (`GET /api/agent/adapters` → `AgentInfo[]`); the page knows nothing
 * CLI-specific beyond these fallbacks for before that list has loaded.
 */
export type AgentKind = string;
export type Tier = "T1" | "T2" | "T3" | "T0";
/** One CLI as the server's adapter registry describes it (server/canvas/adapters/registry.py `info`). */
export type AgentInfo = {
  kind: AgentKind;
  name: string;
  /** T1 session agent (picker), T2 observed (trajectory, read-only), T3 receipts only, T0 inferred. */
  tier: Tier;
  maxTier: Tier;
  installed: boolean;
  version?: string;
  /** Versions the adapter was tested with, e.g. "0.128–<0.158". */
  tested: string;
  testedSpec?: string;
  /** Notify-only for now: the tier drift would take it to, and why (`agora doctor --agents`). */
  degraded?: { from: Tier; to: Tier; reason: string; trusted?: boolean } | null;
  drift?: { unknown: Record<string, number>; records: number; versionOk: boolean | null } | null;
  caps: { headless: boolean; terminal: boolean; catalog: boolean; subagents: boolean; forkHeadless: boolean; cost: boolean; waits: "native" | "inferred" | "none" };
  icon: { kind: "mark" | "svg" | "bitmap"; src: string };
  /** Where its native conversations live, for people. */
  logDir: string;
  /** Command that deletes a native session by hand ("{id}" = its id); null = remove the log file. */
  deleteCommand: string | null;
  seedmuxNames: string[];
  catalog?: CatalogEntry;
};
/** Unified lifecycle of a run (server/canvas/adapters/runs.py `STATES`; Seedmux receipts map onto it). */
export type RunState = "dispatched" | "acknowledged" | "running" | "waiting" | "idle_no_reply" | "done" | "failed" | "blocked" | "exited" | "session_changed" | "unknown" | "idle";
/** One lane segment of a run: what it did, when, on which file (and canvas node when `canvas=` was given). */
export type RunSegment = { kind: "read" | "write" | "exec" | "think" | "wait"; start: number; end: number; itemId: string; turn: number; label: string; path?: string; node?: string; spawn?: NonNullable<Item["tool"]>["spawn"] };
export type RunMoment = { kind: "dispatch" | "handoff" | "receipt"; at: number; childRunId?: string; toolCallId?: string; taskId?: string; state?: RunState | string };
/** A Seedmux ticket as the receipts reader sees it (read-only: meta.json core keys, delivery.json, reply.md). */
export type Receipt = { taskId: string; agent: string; cwd?: string; createdAt?: number; repliedAt?: number; seedmuxState?: string; status?: string; state: RunState; toPane?: string; fromPane?: string; sid?: string; changed?: string[]; accept?: string | null; replyPreview?: string; replyPath?: string };
/**
 * A session, one of its native sub-agents, or a worker it dispatched through Seedmux
 * (`GET /api/agent/runs?session=…`, web/docs/cli-adapters.md §7). `parent.via` says how the link is known.
 */
export type AgentRun = {
  id: string;
  kind: AgentKind;
  nativeId?: string;
  tier: Tier;
  sessionId?: string;
  label: string;
  role?: string;
  model?: string;
  depth: number;
  parent?: { runId: string; via: "native" | "seedmux" | "inferred"; toolCallId?: string; taskId?: string; evidence: string };
  cwd?: string;
  worktree?: string;
  state: RunState;
  startedAt?: number | null;
  endedAt?: number | null;
  lastAt?: number | null;
  logPath?: string;
  /** Runs below this one that the server did not expand (`depth=N`; the default `all` expands everything). */
  hiddenDescendants: number;
  childCount: number;
  /** Every run below this one (expanded or not): the page shows one level and folds the rest into this badge. */
  descendants: number;
  receipt?: Receipt;
  timeline: { segments: RunSegment[]; turns: { n: number; start: number; end: number }[]; moments: RunMoment[]; timesInferred?: boolean };
  items?: Item[];
};
export type RunTree = { root: string; runs: AgentRun[]; folded: Record<string, number>; depth: number | null; generatedAt: number };
/** The run tree of a session (no UI consumes it yet: the workstation's child figures build on it). */
export async function fetchRuns(sessionId: string, opts: { depth?: number | "all"; canvas?: string; items?: boolean; receipts?: boolean } = {}): Promise<RunTree> {
  const q = new URLSearchParams({ session: sessionId, depth: String(opts.depth ?? "all"), ...(opts.canvas ? { canvas: opts.canvas } : {}), ...(opts.items ? { items: "1" } : {}), ...(opts.receipts === false ? { receipts: "0" } : {}) });
  const r = await fetch(`/api/agent/runs?${q}`);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
  return (await r.json()) as RunTree;
}

/** Fallbacks until `/api/agent/adapters` answers (and for older servers). */
export const AGENT_NAMES: Record<AgentKind, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
export const AGENT_KINDS: AgentKind[] = ["pi", "claude", "codex"];
const FALLBACK: Record<string, Pick<AgentInfo, "logDir" | "deleteCommand"> & { forkHeadless: boolean }> = {
  pi: { logDir: "~/.pi/agent/sessions/", deleteCommand: null, forkHeadless: true },
  claude: { logDir: "~/.claude/projects/", deleteCommand: null, forkHeadless: true },
  codex: { logDir: "~/.codex/sessions/", deleteCommand: "codex delete {id}", forkHeadless: false },
};
let adapterList: AgentInfo[] | null = null;
let adaptersP: Promise<AgentInfo[]> | null = null;
/** The registry's AgentInfo list (fetched once per page; `?versions=0`: no `--version` probes). */
export function loadAdapters(): Promise<AgentInfo[]> {
  adaptersP ??= fetch("/api/agent/adapters?versions=0")
    .then((r) => (r.ok ? (r.json() as Promise<AgentInfo[]>) : []))
    .then((list) => {
      adapterList = Array.isArray(list) ? list : [];
      for (const a of adapterList) AGENT_NAMES[a.kind] = a.name;
      return adapterList;
    })
    .catch(() => (adapterList = []));
  return adaptersP;
}
export const agentInfo = (kind: AgentKind | undefined): AgentInfo | undefined => (kind ? adapterList?.find((a) => a.kind === kind) : undefined);
export const agentName = (kind: AgentKind | undefined): string => (kind ? (agentInfo(kind)?.name ?? AGENT_NAMES[kind] ?? kind) : "Agent");
/** The session agents (T1) to offer in the picker, in the registry's order. */
export const sessionKinds = (): AgentKind[] => (adapterList?.length ? adapterList.filter((a) => a.tier === "T1").map((a) => a.kind) : AGENT_KINDS);
export const logDirOf = (kind: AgentKind | undefined): string => agentInfo(kind)?.logDir || (kind && FALLBACK[kind]?.logDir) || "CLI 自己的目录";
export const deleteCommandOf = (kind: AgentKind | undefined): string | null => agentInfo(kind)?.deleteCommand ?? (kind ? FALLBACK[kind]?.deleteCommand : null) ?? null;
export const forkHeadless = (kind: AgentKind | undefined): boolean => agentInfo(kind)?.caps.forkHeadless ?? (kind ? FALLBACK[kind]?.forkHeadless : undefined) ?? true;

/**
 * `started`: the native session exists (it ran once); from then on it is only ever resumed.
 * `pendingFork`: the next run continues `from` as a fork (a new native id with its history) — a
 * session copied along with the project, or a Pi log that could not be moved. `natives`: every
 * native id the session has had (a fork or a fresh start after a lost log adds one).
 */
export type Binding = {
  agent: AgentKind;
  model: string;
  effort: string;
  nativeId: string | null;
  createdAt: number;
  started?: boolean;
  pendingFork?: { from: string; path?: string | null; reason?: string; at?: number } | null;
  natives?: { id: string; at: number; reason: string }[];
};
export type FileOp = "edit" | "write" | "add" | "delete";
/** One model request's accounting (server/canvas/transcript.py `_usage`, runner `Usage`). */
export type Usage = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  durationMs?: number | null;
};
/** A transcript item from the native log (server/canvas/transcript.py). */
export type Item = {
  id: string;
  kind: "user" | "assistant" | "tool" | "usage" | "context" | "end" | "run";
  text?: string;
  at: number;
  endAt?: number;
  startAt?: number;
  /** Model message this text / tool call belongs to (one request = one trajectory step). */
  msg?: string;
  source?: "agora" | "terminal";
  tool?: {
    name?: string;
    input?: string;
    /** Full input (preview when `argsLen` is set: fetch the item for the rest). */
    args?: string;
    argsLen?: number;
    output?: string;
    outputLen?: number;
    isError?: boolean;
    files?: { path: string; op: FileOp }[];
    /**
     * Tool facts the server derives from the CLI's own vocabulary (server/canvas/adapters/): the
     * page never needs to know tool names. Older snapshots lack them: `activityOf` / `readPath`
     * are the fallback.
     */
    activity?: string;
    /** Files this call reads, relative to the project root. */
    reads?: string[];
    /** The call waits for the person (a question, an approval gate). */
    waitsUser?: boolean;
    /** The call started another agent: a native sub-agent, or a Seedmux ticket (`taskId`, `pane`). */
    spawn?: { childKind?: string; childId?: string; taskId?: string; pane?: string; role?: string; state?: string; via?: "native" | "seedmux" | "inferred" };
  };
  usage?: Usage;
  model?: string;
  effort?: string;
  durationMs?: number;
  error?: string;
  turn?: string;
};
/**
 * The native log of a session that already ran is not usable (server/canvas/agents.py
 * `NativeMissing`): `missing`, `ambiguous` (several copies) or `elsewhere` (Pi: another directory).
 * These block sending and the terminal: resuming would silently start a new conversation.
 * `duplicates` only informs: other copies exist, the project's own one is followed.
 */
export type NativeProblem = { state: "missing" | "ambiguous" | "elsewhere" | "duplicates"; blocking: boolean; nativeId: string; candidates: string[]; message: string };
export type Status = {
  native?: NativeProblem | null;
  /** Brought along by `cp -r` of the project: read-only here until forked. */
  copy?: { from: string; fromInstance: string; at: number } | null;
  /** A Claude Code session idle for 20+ days: Claude deletes session logs after 30 by default. */
  stale?: { days: number; path: string } | null;
  /** Agora holds a trajectory snapshot of this session (shown read-only if the native log is gone). */
  snapshot?: boolean;
  running: boolean;
  busy: boolean;
  queued: number;
  held: string | null;
  activity: string | null;
  error: string | null;
  /** Who holds the session's terminal: Agora's own tmux pane (Kitty / Terminal attach to it) or a Seedmux pane. */
  terminal: { alive: boolean; attach: string; clients: number; app: "tmux" | "seedmux" | null; paneId?: string | null };
};
/** Where「在终端打开」opens: Kitty (Agora's tmux pane in a Kitty window) or a new Seedmux pane. */
export type TerminalApp = "kitty" | "seedmux";
export type TerminalApps = { kitty: boolean; seedmux: { available: boolean; reason?: string } };
export type CatalogEntry = {
  kind: AgentKind;
  name: string;
  installed: boolean;
  default: string;
  models: string[];
  featured: string[];
  /** Every level any listed model takes (the CLI's vocabulary when nothing more is known). */
  efforts: string[];
  defaultEffort: string;
  /** Levels per model, read from the CLI's own catalog (server/canvas/agent_models.py); "" = no --model. */
  modelEfforts?: Record<string, string[]>;
  /** The level a model starts on ("" = leave it to the CLI). */
  modelDefaultEffort?: Record<string, string>;
  effortSource?: string;
  /** Friendly names by model id (the CLI's display name). */
  names?: Record<string, string>;
  /** Provider by model id (Pi's `provider/…`); the picker groups the non-featured models by it. */
  providers?: Record<string, string>;
  /** Models a binding may use (the server refuses others); null = not known, not checked. */
  allowed?: string[] | null;
  /** Where the list comes from. Pi: `enabledModels` (its own scope) or every `available` model. */
  scope?: { kind: "enabledModels" | "available" | "cli"; source?: string; patterns?: string[] };
};
export type Catalog = Record<AgentKind, CatalogEntry>;

/**
 * The effort picker for one model: the levels that model really takes and the one to start on.
 * `cliDefault` adds a "CLI 默认" choice (value "") when Agora does not know the model's default.
 */
export function effortChoices(entry: CatalogEntry | undefined, model: string): { levels: string[]; initial: string; cliDefault: boolean } {
  if (!entry) return { levels: [], initial: "", cliDefault: true };
  const levels = entry.modelEfforts?.[model] ?? entry.efforts;
  const def = entry.modelDefaultEffort?.[model] ?? "";
  const initial = levels.includes(def) ? def : "";
  return { levels, initial, cliDefault: initial === "" };
}
/** A message Agora sent that has not finished yet (comment hand-offs wait on it). */
export type Inflight = { sendId: string; sessionId: string; canvasId: string; threadId?: string; threadN?: number; anchor?: string; turnIds: string[] };

type State = {
  connected: boolean;
  bindings: Record<string, Binding>;
  /** Listed sessions that cannot simply be resumed here (copied, recoverable, another copy's, another machine's). */
  origins: Record<string, Origin>;
  items: Record<string, Item[]>;
  status: Record<string, Status>;
  /** Last time something happened in a session (picks the canvas's session for comments). */
  activeAt: Record<string, number>;
  inflight: Record<string, Inflight>;
};

let state: State = { connected: false, bindings: {}, origins: {}, items: {}, status: {}, activeAt: {}, inflight: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

type DoneEvent = { sessionId: string; sendId: string; text: string; error?: string | null; route: string };
const doneWaiters = new Map<string, (e: DoneEvent) => void>();

function upsert(sessionId: string, incoming: Item[], reset: boolean) {
  const cur = reset ? [] : [...(state.items[sessionId] ?? [])];
  const index = new Map(cur.map((it, i) => [it.id, i]));
  for (const it of incoming) {
    const i = index.get(it.id);
    if (i === undefined) {
      index.set(it.id, cur.length);
      cur.push(it);
    } else cur[i] = { ...cur[i], ...it, tool: { ...cur[i].tool, ...it.tool } };
  }
  const last = incoming.reduce((m, it) => Math.max(m, it.at), state.activeAt[sessionId] ?? 0);
  set({ items: { ...state.items, [sessionId]: cur }, activeAt: { ...state.activeAt, [sessionId]: last } });
}

export type BridgeHandler = (req: { rid: string; kind: string } & Record<string, unknown>) => Promise<unknown>;
let bridgeHandler: BridgeHandler | null = null;
export const setBridgeHandler = (h: BridgeHandler) => void (bridgeHandler = h);

/** Apply one server event (exported for tests). */
export async function handleEvent(e: Record<string, unknown> & { t: string }) {
  if (e.t === "hello") return set({ connected: true });
  if (e.t === "transcript") return upsert(e.sessionId as string, e.items as Item[], !!e.reset);
  if (e.t === "status") {
    const { binding, sessionId, t: _t, ...status } = e as unknown as { binding: Binding | Record<string, never>; sessionId: string; t: string } & Status;
    set({
      status: { ...state.status, [sessionId]: status },
      bindings: binding && "agent" in binding ? { ...state.bindings, [sessionId]: binding as Binding } : state.bindings,
    });
    return;
  }
  if (e.t === "done") {
    const d = e as unknown as DoneEvent;
    set({ activeAt: { ...state.activeAt, [d.sessionId]: Date.now() } });
    doneWaiters.get(d.sendId)?.(d);
    doneWaiters.delete(d.sendId);
    return;
  }
  if (e.t === "bridge" && bridgeHandler) {
    const { rid } = e as unknown as { rid: string };
    let result: unknown;
    try {
      result = await bridgeHandler(e as unknown as Parameters<BridgeHandler>[0]);
    } catch (err) {
      result = { status: "error", error: String(err) };
    }
    await fetch(`/api/agent/bridge/${rid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result ?? {}) }).catch(() => {});
  }
}

let source: EventSource | null = null;
/** Subscribe to the project's agent events; this page executes canvas bridge requests. */
export function connectAgents() {
  if (source) return;
  void loadAdapters();
  source = new EventSource("/api/agent/events?executor=1");
  source.onmessage = (m) => {
    try {
      void handleEvent(JSON.parse(m.data));
    } catch {
      /* keepalive or garbage */
    }
  };
  source.onerror = () => set({ connected: false });
}

const json = async (r: Response) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string; detail?: string }).error ?? (body as { detail?: string }).detail ?? r.statusText);
  return body;
};

let catalogP: Promise<Catalog> | null = null;
export const agents = {
  get: () => state,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  hydrateBindings: (b: Record<string, Binding>) => set({ bindings: { ...state.bindings, ...b } }),
  hydrateOrigins: (o: Record<string, Origin>) => set({ origins: o }),
  /** The session went to the trash: its binding, status and transcript leave this page (the pointer moves on). */
  forget(sessionId: string) {
    const drop = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== sessionId));
    set({ bindings: drop(state.bindings), status: drop(state.status), items: drop(state.items), activeAt: drop(state.activeAt), inflight: drop(state.inflight), origins: drop(state.origins) });
  },

  /**
   * Continue here as a fork of the session's native session: one this copy of the project brought
   * along, or (with `source`) one another copy on this machine owns. The next message — or the
   * terminal — creates the new native id with the full history.
   */
  async fork(sessionId: string, source?: Origin): Promise<Binding> {
    const b = (await json(
      await fetch(`/api/agent/sessions/${sessionId}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: source ?? null }) }),
    )) as Binding;
    const { [sessionId]: _, ...origins } = state.origins;
    set({ bindings: { ...state.bindings, [sessionId]: b }, origins });
    return b;
  },
  catalog: () => (catalogP ??= fetch("/api/agent/catalog").then(json) as Promise<Catalog>),

  /** Fix the session's agent, model and effort (once; the server refuses a different choice). */
  async bind(sessionId: string, agent: AgentKind, model: string, effort: string, nativeId?: string | null, started?: boolean): Promise<Binding> {
    const b = (await json(
      await fetch(`/api/agent/sessions/${sessionId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, model, effort, nativeId: nativeId ?? null, started: started ?? null }) }),
    )) as Binding;
    const { [sessionId]: _, ...origins } = state.origins;
    set({ bindings: { ...state.bindings, [sessionId]: b }, origins, activeAt: { ...state.activeAt, [sessionId]: Date.now() } });
    return b;
  },

  /** Send a message into the native session (terminal pane if one holds it, else a headless turn). */
  async send(sessionId: string, text: string, opts: { canvasId?: string; context?: string; thread?: Omit<Inflight, "sendId" | "sessionId" | "turnIds" | "canvasId"> } = {}) {
    const r = (await json(
      await fetch(`/api/agent/sessions/${sessionId}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, canvasId: opts.canvasId, context: opts.context ?? "" }) }),
    )) as { sendId: string; route: "terminal" | "headless" };
    const inflight: Inflight = { sendId: r.sendId, sessionId, canvasId: opts.canvasId ?? "", turnIds: [], ...opts.thread };
    set({ inflight: { ...state.inflight, [sessionId]: inflight }, activeAt: { ...state.activeAt, [sessionId]: Date.now() } });
    const done = new Promise<DoneEvent>((ok) => doneWaiters.set(r.sendId, ok)).then((d) => {
      if (state.inflight[sessionId]?.sendId === r.sendId) {
        const { [sessionId]: _, ...rest } = state.inflight;
        set({ inflight: rest });
      }
      return { ...d, turnIds: inflight.turnIds };
    });
    return { ...r, done };
  },
  /** Apply turns created while a send is in flight belong to it (a comment's undo, its reply link). */
  noteTurn(sessionId: string, turnId: string) {
    const f = state.inflight[sessionId];
    if (f) f.turnIds.push(turnId);
  },

  async openTerminal(sessionId: string, canvasId: string, launch = true, app: TerminalApp = "kitty") {
    return (await json(
      await fetch(`/api/agent/sessions/${sessionId}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch, canvasId, app }) }),
    )) as { attach: string; launched: "kitty" | "terminal" | "seedmux" | null; created: boolean; paneId?: string; attached?: boolean };
  },
  terminalApps: async () => (await json(await fetch("/api/agent/terminals"))) as TerminalApps,
  /** A transcript item in full (tool args / output past the preview). */
  item: async (sessionId: string, itemId: string) => (await json(await fetch(`/api/agent/sessions/${sessionId}/items/${encodeURIComponent(itemId)}`))) as Item,
  closeTerminal: (sessionId: string) => fetch(`/api/agent/sessions/${sessionId}/terminal`, { method: "DELETE" }),
  interrupt: (sessionId: string) => fetch(`/api/agent/sessions/${sessionId}/interrupt`, { method: "POST" }),
  /** What was said so far (from Agora's snapshot), as a message to carry into a new native session. */
  summary: async (sessionId: string) => ((await json(await fetch(`/api/agent/sessions/${sessionId}/summary`))) as { text: string }).text,
  /** The native log is gone: the next message starts a new native session for this same Agora session. */
  async restart(sessionId: string): Promise<Binding> {
    const b = (await json(await fetch(`/api/agent/sessions/${sessionId}/restart`, { method: "POST" }))) as Binding;
    set({ bindings: { ...state.bindings, [sessionId]: b }, status: { ...state.status, [sessionId]: { ...state.status[sessionId], native: null } } });
    return b;
  },

  /** The session a canvas's comments go to: the most recently active agent session on it. */
  forCanvas(sessionIds: string[]): string | undefined {
    const bound = sessionIds.filter((id) => state.bindings[id]);
    return bound.sort((a, b) => (state.activeAt[b] ?? state.bindings[b].createdAt) - (state.activeAt[a] ?? state.bindings[a].createdAt))[0];
  },
};

export const useAgents = () => useSyncExternalStore(agents.subscribe, agents.get);
