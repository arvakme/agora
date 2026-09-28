// Linking a node to its child canvas: `customData.childCanvas` on the parent node, one undoable
// scene update (⌘Z in the canvas), with an undo batch for the session card when an agent did it.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { byId, type El } from "../canvas/scene";
import type { Batch } from "../ops/apply";
import { childOf } from "./graph";

/** Set (or with null, remove) the child canvas a node opens. Returns the undo batch, or null when nothing changed. */
export function writeChildLink(api: ExcalidrawImperativeAPI, elementId: string, child: string | null): Batch | null {
  const scene = api.getSceneElementsIncludingDeleted() as readonly El[];
  const before = new Map<string, El | null>();
  const next = scene.map((e) => {
    if (e.id !== elementId || childOf(e) === child) return e;
    before.set(e.id, e);
    const { childCanvas: _old, ...rest } = (e.customData ?? {}) as Record<string, unknown>;
    return {
      ...e,
      customData: child ? { ...rest, childCanvas: child } : Object.keys(rest).length ? rest : undefined,
      version: e.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as El;
  });
  if (!before.size) return null;
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  const settled = byId(api.getSceneElementsIncludingDeleted() as readonly El[]);
  return { before, after: new Map([...before.keys()].map((id) => [id, settled.get(id)!.version])) };
}
