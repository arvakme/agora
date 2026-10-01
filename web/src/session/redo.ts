// 重做: what 撤销 took off, put back. An undo (ops/apply.ts `undoBatch`) writes the batch's "before" over what the agent
// made; redo needs the agent's version of those elements, so it is taken from the scene just before the undo and held
// in memory. It is put back only while nobody touched those elements since the undo (same freshness rule as undo).
import type { Batch } from "../ops/apply";
import type { El, Scene } from "../canvas/scene";
import { byId } from "../canvas/scene";

export type Redo = {
  /** The elements as the batch left them (what the undo replaced). */
  els: Map<string, El>;
  /** The version each had right after the undo. */
  at: Map<string, number>;
};

const nonce = () => Math.floor(Math.random() * 2 ** 31);

/** `pre`: the scene before the undo, `post`: the scene the undo produced. */
export function redoOf(pre: Scene, post: readonly El[], batch: Batch): Redo {
  const was = byId(pre);
  const now = byId(post as Scene);
  const els = new Map<string, El>();
  const at = new Map<string, number>();
  for (const id of batch.after.keys()) {
    const a = was.get(id);
    const b = now.get(id);
    if (a && b) (els.set(id, a), at.set(id, b.version));
  }
  return { els, at };
}

/** Refuses (`stale`: what changed or vanished since the undo) rather than write over the person's edits. */
export function redoBatch(scene: Scene, redo: Redo): { scene?: El[]; stale: string[] } {
  const map = byId(scene);
  const stale = [...redo.at].filter(([id, v]) => map.get(id)?.version !== v).map(([id]) => id);
  if (stale.length) return { stale };
  const next = scene.map((el) => {
    const base = redo.els.get(el.id);
    return base ? ({ ...base, version: el.version + 1, versionNonce: nonce(), updated: Date.now() } as El) : el;
  });
  return { scene: next, stale };
}

/** What a batch's `after` must say once redo has written the elements: the versions they have now, so undo accepts them again. */
export function versionsAfterRedo(scene: Scene, redo: Redo): Map<string, number> {
  const map = byId(scene);
  return new Map([...redo.at.keys()].map((id) => [id, map.get(id)!.version]));
}
