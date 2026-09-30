// A native session imported by hand — `PUT /api/agent/sessions/<id>` with the `nativeId` of a session that already exists (a Pi fork, a Claude session begun in a terminal) — has a binding
// and a transcript on the server, and both reach the page (`agents.ts`), but the page has no Agora session for it: no tab, no doc, nothing to open, so its history is in the store
// and never shown. The page adopts every bound session it has no session for: one on the canvas the latest session is on (else the one open), which the workspace sync then gives
// a doc — the list has it, the agent chip opens it. Started from `agentBridge.ts` `installBridge` (after boot has hydrated the sessions, so nothing that is about to be loaded is made twice).
import { agents } from "./agents";
import { sessions } from "./store";

/** The bound sessions (ids) that have no session, in binding order, but the ones in `skip`. */
export function adoptTargets(bound: readonly string[], have: Record<string, unknown>, skip: ReadonlySet<string>): string[] {
  return bound.filter((id) => !(id in have) && !skip.has(id));
}

/** Give every bound session without a session one, on `openCanvas()` when the page has no session to follow. Does nothing while there is no canvas to put it on. */
export function adoptBound(openCanvas: () => string | null): void {
  const have = sessions.get().sessions;
  const ids = adoptTargets(Object.keys(agents.get().bindings), have, new Set());
  if (!ids.length) return;
  const latest = Object.values(have).sort((a, b) => b.createdAt - a.createdAt)[0]?.canvasId ?? openCanvas();
  if (!latest) return;
  for (const id of ids) sessions.create(latest, id);
}

/** Keep adopting as bindings arrive (and as sessions come and go; `also`: anything else to run again on, e.g. the canvases being there). Returns the function that stops it. */
export function installAdopt(openCanvas: () => string | null, ...also: ((l: () => void) => () => void)[]): () => void {
  const run = () => adoptBound(openCanvas);
  run();
  const offs = [agents.subscribe(run), sessions.subscribe(run), ...also.map((sub) => sub(run))];
  return () => offs.forEach((off) => off());
}
