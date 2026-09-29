// The selection a message was sent with, under its bubble: a thumbnail of just those elements (saved with the
// message: server/canvas/selection.py) and 「选区 · N 个元素」. Hovering lists the names; a click lights the
// elements up on the canvas. A message from before pictures has the names only, no thumbnail.
import { useEffect, useState } from "react";
import { IconSelect } from "../app/icons";
import { elementNames } from "../canvas/anchors";
import { byId, type El, type Scene } from "../canvas/scene";
import type { Item } from "./agents";
import { selectionLabel, type SelEl } from "./selection";
import { canvases, highlight, ui } from "./ui";
import "./agentCard.css";

export function SelectionView({ elements, thumb, onPick }: { elements: SelEl[]; thumb?: string; onPick: () => void }) {
  return (
    <div className="sel-view" data-thumb={thumb ? "" : undefined}>
      <button className="sel-btn" onClick={onPick} aria-label={`在画布上高亮这 ${elements.length} 个元素`}>
        {thumb && <img className="sel-thumb" src={thumb} alt="" loading="lazy" />}
        <span className="sel-count">
          <IconSelect size={12} />
          {selectionLabel(elements.length)}
        </span>
      </button>
      <ul className="sel-names" role="tooltip">
        {elements.map((e) => (
          <li key={e.id}>{e.name}</li>
        ))}
      </ul>
    </div>
  );
}

type Meta = { id: string; canvasId: string; elements: SelEl[]; hasThumb?: boolean };
const metaCache = new Map<string, Meta | null>();
function useSelectionMeta(id: string | undefined): Meta | null {
  const [m, setM] = useState<Meta | null>(id ? (metaCache.get(id) ?? null) : null);
  useEffect(() => {
    if (!id || metaCache.has(id)) return;
    let live = true;
    void fetch(`/api/agent/selections/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<Meta>) : null))
      .catch(() => null)
      .then((got) => {
        metaCache.set(id, got);
        if (live) setM(got);
      });
    return () => void (live = false);
  }, [id]);
  return m;
}

const HOLD_MS = 2600;
/** Bring the canvas forward and light up the elements (the ones that are still there). */
function light(canvasId: string, ids: string[]) {
  ui.focusPane(canvasId);
  const h = { canvasId, ids };
  highlight.set(h);
  setTimeout(() => highlight.get() === h && highlight.set(null), HOLD_MS);
}

/** The selection of one user message, from the saved record (`{id}`) or, for an old message, the ids it named. */
export function SelectionAttachment({ sel, canvasId }: { sel: NonNullable<Item["selection"]>; canvasId: string }) {
  const meta = useSelectionMeta("id" in sel ? sel.id : undefined);
  let elements: SelEl[] = meta?.elements ?? [];
  let target = meta?.canvasId ?? canvasId;
  if ("ids" in sel) {
    const scene = canvases.get(canvasId)?.api.getSceneElements() as unknown as El[] | undefined;
    elements = elementNames(sel.ids, scene ? byId(scene as Scene) : new Map()).map(({ id, name }) => ({ id, name }));
    target = canvasId;
  }
  if (!elements.length) return null;
  const thumb = "id" in sel && meta?.hasThumb ? `/api/agent/selections/${sel.id}/thumb.svg` : undefined;
  return <SelectionView elements={elements} thumb={thumb} onPick={() => light(target, elements.map((e) => e.id))} />;
}
