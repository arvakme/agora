// The selection sent with a chat message. What is selected is named (name and id, a box counted with its label);
// the picture is Excalidraw's own export of just those elements: an svg for the thumbnail under the message, a png
// for the CLIs that take an image (the server keeps both: server/canvas/selection.py).
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { elementNames } from "../canvas/anchors";
import { byId, live, type El, type Scene } from "../canvas/scene";

export type SelEl = { id: string; name: string };
/** What goes to the server with the message (agent_router.py `SelectionIn`). */
export type SelectionPayload = { canvasId: string; elements: SelEl[]; svg: string; png: string | null };

export const selectionLabel = (n: number) => `选区 · ${n} 个元素`;

/** The elements a set of selected ids stands for: a label counts with its box, what is gone is left out. */
export function selectionElements(scene: readonly El[], selectedIds: readonly string[]): SelEl[] {
  const map = byId(scene as Scene);
  const container = (id: string) => {
    const e = map.get(id);
    return e?.type === "text" && e.containerId ? e.containerId : id;
  };
  const ids = [...new Set(selectedIds.map(container))].filter((id) => live(map.get(id)));
  return elementNames(ids, map).map(({ id, name }) => ({ id, name }));
}

export const selectedIds = (api: ExcalidrawImperativeAPI): string[] => Object.keys(api.getAppState().selectedElementIds ?? {});

const SVG_LIMIT = 1_400_000; // the server keeps at most SVG_MAX (1.5 MB)
const PNG_SIDE = 1024; // the longest side of the picture a CLI is given
const PAD = 16;

const toBase64 = (blob: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(blob);
  });

/**
 * The selection as it is now: names, the svg and the png of just those elements (and their labels), on white.
 * Null when nothing is selected. A picture that cannot be made (a canvas the export chokes on) is not an error:
 * the words still go, `svg` empty says there is no picture.
 */
export async function captureSelection(api: ExcalidrawImperativeAPI, canvasId: string): Promise<SelectionPayload | null> {
  const ids = selectedIds(api);
  const scene = api.getSceneElements() as unknown as El[];
  const elements = selectionElements(scene, ids);
  if (!elements.length) return null;
  const keep = new Set(elements.map((e) => e.id));
  const chosen = scene.filter((e) => keep.has(e.id) || (e.type === "text" && !!e.containerId && keep.has(e.containerId)));
  const appState = { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false };
  const files = api.getFiles();
  try {
    const draw = async (withFiles: boolean) => {
      const node = await exportToSvg({ elements: chosen as never, appState, files: withFiles ? files : {}, exportPadding: PAD, skipInliningFonts: true });
      return new XMLSerializer().serializeToString(node);
    };
    let svg = await draw(true);
    if (svg.length > SVG_LIMIT) svg = await draw(false); // big embedded images: draw the shapes without them
    const blob = await exportToBlob({ elements: chosen as never, appState, files, mimeType: "image/png", exportPadding: PAD, maxWidthOrHeight: PNG_SIDE });
    return { canvasId, elements, svg, png: await toBase64(blob) };
  } catch {
    return { canvasId, elements, svg: "", png: null };
  }
}
