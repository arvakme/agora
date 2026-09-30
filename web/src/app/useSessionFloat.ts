// Whether the session panel floats now, and what the workspace needs to draw it so (web/docs/workstation.md §15). The preference is the viewer's (prefs.ts
// floatSession); a window under FLOAT_MIN_W, or a layout with no canvas column to float over, docks it whatever the preference says — the panel is the same
// component either way, so nothing of it is lost, and a window that grows floats it again.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { agents } from "../session/agents";
import { sessionContent } from "../session/floatContent";
import { groups, type Node } from "../workspace/layout";
import { groupKind } from "../workspace/model";
import type { FloatSpec } from "../workspace/Workspace";
import { useClaim, useShell } from "./shellParts";
import { floatFocus, floatWanted } from "./floatShell";
import { prefs, usePrefs } from "./prefs";

const subscribeSize = (l: () => void) => (addEventListener("resize", l), () => removeEventListener("resize", l));
export const useWindowWidth = () => useSyncExternalStore(subscribeSize, () => innerWidth);

export function useSessionFloat(a: { root: Node; kindOf: (tab: string) => "canvas" | "session" | undefined; sessionOf: (tab: string) => string | undefined; title: (tab: string) => string }): FloatSpec | undefined {
  const { floatSession } = usePrefs();
  const windowW = useWindowWidth();
  const [shell, set] = useShell("session");
  const all = groups(a.root);
  const sg = all.find((g) => groupKind(g.tabs, a.kindOf) === "session");
  const wanted = !!sg && floatWanted({ pref: floatSession, windowW, canvasColumn: all.length > 1 });
  const focus = useClaim("session", wanted && !shell.folded);
  // the comment list being the open shell folds this one to its capsule, without changing what the viewer chose for it
  const folded = shell.folded || focus === "comments";
  const sid = sg && a.sessionOf(sg.active);
  const count = useSyncExternalStore(agents.subscribe, () => (sid ? agents.get().items[sid]?.length ?? 0 : 0));
  const seen = useRef(count);
  useEffect(() => void (!folded && (seen.current = count)));
  if (!wanted || !sg) return undefined;
  return {
    group: sg.id,
    shell,
    set,
    folded,
    label: a.title(sg.active),
    dot: folded && count > seen.current,
    measure: sessionContent,
    onFold: () => set({ ...shell, folded: true }),
    onUnfold: () => (set({ ...shell, folded: false }), floatFocus.set("session")),
    onDock: () => prefs.set({ floatSession: false }),
  };
}
