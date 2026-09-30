// While a turn plays, the trajectory follows the current step until the person scrolls. What counts as the person
// scrolling: a wheel / touch move or a paging key — but not the program's own scrolling, not the pane switching views, and
// not a trackpad's leftover momentum from before the play started (all of which come inside a short quiet time). Pure.

/** After the pane starts a play or scrolls by itself, wheel and touch events this long are not the person's. */
export const QUIET_MS = 900;
const PAGING = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export type ScrollEvent = { kind: "wheel"; dx?: number; dy?: number } | { kind: "touch" } | { kind: "key"; key: string; onButton: boolean };

export function isUserScroll(e: ScrollEvent, now: number, quietUntil: number): boolean {
  if (e.kind === "key") return PAGING.has(e.key) && !(e.key === " " && e.onButton); // Space on a button presses it
  if (now < quietUntil) return false;
  return e.kind === "touch" || !!(e.dx || e.dy);
}

/** The quiet time after something the program did at `now`; it only ever extends. */
export const quietFor = (now: number, until: number) => Math.max(until, now + QUIET_MS);
