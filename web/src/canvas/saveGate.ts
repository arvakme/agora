// When a canvas may be saved, and whether an empty scene is the user's doing.
//
// A mount of the shell starts with whatever scene it was given (the page's first load, which
// may be old by now, or nothing at all while an editor is still coming up). Saving that back
// destroys the file. So a canvas is saved only after this mount has applied the server's scene
// (`arm`), and an empty scene goes out marked `clear` only when the canvas was non-empty on this
// mount before, i.e. the user emptied it. The server refuses an unmarked empty scene over a
// non-empty file as well (server/canvas/project.py `EmptyOverwrite`).
import type { El } from "./scene";

const live = (els: readonly El[]) => els.some((e) => !e.isDeleted);

export function createSaveGate() {
  const armed = new Set<string>();
  const nonEmpty = new Set<string>();
  return {
    /** The server's scene for `id` has been applied on this mount: saves are allowed from now on. */
    arm(id: string, elements: readonly El[]) {
      armed.add(id);
      if (live(elements)) nonEmpty.add(id);
      else nonEmpty.delete(id);
    },
    /** The canvas is gone or must be loaded again: no save until the next `arm`. */
    disarm(id: string) {
      armed.delete(id);
      nonEmpty.delete(id);
    },
    /** What to save for `id` right now (null: this mount has not loaded it, so it saves nothing). */
    payload(id: string, elements: readonly El[]): { elements: El[]; clear: boolean } | null {
      if (!armed.has(id)) return null;
      const kept = elements.filter((e) => !e.isDeleted);
      const clear = kept.length === 0 && nonEmpty.has(id);
      if (kept.length) nonEmpty.add(id);
      else nonEmpty.delete(id);
      return { elements: kept, clear };
    },
  };
}
