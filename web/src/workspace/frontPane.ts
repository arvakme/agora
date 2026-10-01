// Which canvas pane is "the person's" when there are several on screen: the one they last used. The live camera moves that
// one (workstation/replayLive.ts) — the same canvas the app shell sends an agent's request from (`canvasDoc` in app/App.tsx).

export type Slot = { id: string; hidden: boolean; front: boolean };

/** The pane in front after `focused` took the focus: a canvas takes it, a session leaves it where it was. */
export const nextFront = (prev: string | null, focused: string, kindOf: (id: string) => "canvas" | "session" | undefined): string | null => (kindOf(focused) === "canvas" ? focused : prev);

/** The canvas pane on screen the camera takes: the front one, else the first one there is. */
export function pickPane(slots: readonly Slot[], isCanvas: (id: string) => boolean): string | null {
  const shown = slots.filter((s) => !s.hidden && isCanvas(s.id));
  return (shown.find((s) => s.front) ?? shown[0])?.id ?? null;
}
