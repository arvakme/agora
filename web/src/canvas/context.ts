// Freezes what the agent sees at submit time: thread text, anchors, selection,
// element versions, and the model-facing scene projection.
import { toModelView, type ModelView } from "./modelView";
import { byId, live, nameOf, versionOf, type Scene } from "./scene";
import type { Thread } from "../comments/threads";

export type FrozenContext = {
  /** Where the request came from; chat turns carry the conversation so far. */
  origin: "comment" | "chat";
  threadId: string;
  frozenAt: string;
  messages: { author: string; text: string }[];
  anchors: { id: string; label: string; version: string }[];
  selection: string[];
  /** Freshness tokens for every live element at freeze time. */
  versions: Record<string, string>;
  scene: ModelView;
};

/** Anything that can be handed to the agent: a comment thread or a chat turn. */
export type Request = { id: string; origin: "comment" | "chat"; messages: { author: string; text: string }[]; anchorIds: string[] };

export const threadRequest = (thread: Thread): Request => ({
  id: thread.id,
  origin: "comment",
  messages: thread.messages.filter((m) => m.author === "you").map((m) => ({ author: "user", text: m.text })),
  anchorIds: thread.anchor?.ids ?? [],
});

export function freeze(scene: Scene, req: Request, selectedIds: string[]): FrozenContext {
  const map = byId(scene);
  const versions: Record<string, string> = {};
  for (const e of scene) if (live(e)) versions[e.id] = versionOf(e, map);
  // Bound labels resolve to their container, so the model only sees addressable ids.
  const containerOf = (id: string) => {
    const e = map.get(id);
    return e?.type === "text" && e.containerId ? e.containerId : id;
  };
  return {
    origin: req.origin,
    threadId: req.id,
    frozenAt: new Date().toISOString(),
    messages: req.messages,
    anchors: req.anchorIds
      .map((id) => map.get(id))
      .filter(live)
      .map((e) => ({ id: e.id, label: nameOf(e, map), version: versionOf(e, map) })),
    selection: [...new Set(selectedIds.map(containerOf))].filter((id) => live(map.get(id))),
    versions,
    scene: toModelView(scene),
  };
}

/** Elements (by id) whose freshness token no longer matches the frozen one. */
export function staleIds(ctx: Pick<FrozenContext, "versions">, ids: string[], scene: Scene): string[] {
  const map = byId(scene);
  return ids.filter((id) => {
    const frozen = ctx.versions[id];
    if (frozen === undefined) return false; // created by this plan
    const e = map.get(id);
    return !live(e) || versionOf(e, map) !== frozen;
  });
}
