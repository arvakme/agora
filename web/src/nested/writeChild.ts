// Linking a node to its child canvas: `customData.childCanvas` on the parent node, one undoable
// scene update (⌘Z in the canvas), with an undo batch for the session card when an agent did it.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { byId, type El } from "../canvas/scene";
import type { Batch } from "../ops/apply";
import { withChildLink } from "./graph";

/** Set (or with null, remove) the child canvas a node opens. Returns the undo batch, or null when nothing changed. */
export function writeChildLink(api: ExcalidrawImperativeAPI, elementId: string, child: string | null): Batch | null {
  const scene = api.getSceneElementsIncludingDeleted() as readonly El[];
  const next = withChildLink(scene, elementId, child);
  if (!next) return null;
  const before = new Map<string, El | null>([[elementId, scene.find((e) => e.id === elementId)!]]);
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  const settled = byId(api.getSceneElementsIncludingDeleted() as readonly El[]);
  return { before, after: new Map([[elementId, settled.get(elementId)!.version]]) };
}
