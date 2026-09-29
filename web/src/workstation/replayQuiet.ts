// While a camera (a played turn's, or the live one's) has taken the canvas somewhere by itself, nothing of it
// is kept: the project's layout is not saved (persist.ts, through ../layoutSaves.ts) and the 「在子图里」 hint
// stays away. Several cameras may ask at once; it is quiet while any of them does.
import { layoutSaves } from "../layoutSaves";
import { backHintQuiet } from "../nested/up";

/** 「可能过时」 is quiet while a camera has taken the canvas away by itself (as the 「在子图里」 hint is): the sub-diagram is not one the person went to. */
export const staleVisible = (files: number, quiet: boolean) => files > 0 && !quiet;

const holds = new Set<string>();

export const quiet = {
  hold(who: string, on: boolean) {
    const was = holds.size > 0;
    if (on) holds.add(who);
    else holds.delete(who);
    const now = holds.size > 0;
    if (now === was) return;
    layoutSaves.pause(now);
    backHintQuiet.set(now);
  },
};

if (typeof window !== "undefined") Object.assign(window, { __wsQuiet: () => [...holds] });
