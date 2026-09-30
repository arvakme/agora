// The wire shape of "how this canvas was built" (server/canvas/build_log.py `build_timeline`,
// GET /api/project/build?canvas=<id>; web/docs/share-build-replay.md §3). Sanitized on the server:
// elements are what a guest sees (no customData but the child link), sentences use the canvas's
// own words, actors are an agent kind and its name — never a request, a session or a code path.
import type { El } from "../canvas/scene";

export type Actor = { kind: "agent"; agent: string; name: string } | { kind: "you" };

export type ItemKind = "add-node" | "add-arrows" | "expand" | "rename" | "move" | "restyle" | "delete" | "note" | "link";
export type BuildItem = {
  kind: ItemKind;
  /** What it did, in words. */
  say: string;
  /** The node (of the step's canvas) the figure stands at to do it. */
  place: string | null;
  ids: string[];
  /** Changes nothing that shows (linking a node to code). */
  quiet: boolean;
  /** `expand`: the canvas the node now opens. */
  child?: string;
  add?: El[];
  change?: El[];
  remove?: string[];
};

export type BuildStep = { i: number; at: number; until: number; canvas: string; actor: Actor; items: BuildItem[] };

export type BuildTimeline = {
  format: "agora-build-timeline";
  version: 1;
  root: string;
  canvases: Record<string, { title: string; parent: { canvas: string; node: string } | null }>;
  /** Per canvas, the elements alive before its first step (bottom to top). */
  start: Record<string, El[]>;
  steps: BuildStep[];
  sources: { changes: number; yourSteps: number; unseenEdits: number; steps: number; dropped: number };
};
