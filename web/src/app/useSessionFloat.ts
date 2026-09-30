// Which form the session panel has now, and what the workspace needs to draw it so (web/docs/workstation.md §15). The person's choice is prefs.ts `floatSession`
// (dock / card / bar); a window under FLOAT_MIN_W × FLOAT_MIN_H, or a layout with no canvas column to float over, docks it whatever the choice — the panel is the same
// component in every form, so nothing of it is lost, and a window that grows gives the chosen form back.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agents, type AgentKind } from "../session/agents";
import { lastSaid, statusLine, type StatusLine } from "../session/floatStatus";
import { groups, type Node } from "../workspace/layout";
import { groupKind } from "../workspace/model";
import { useBar, useClaim, useShell } from "./shellParts";
import { floatFocus, floatMode, type Bar, type Shell } from "./floatShell";
import { prefs, usePrefs } from "./prefs";

const subscribeSize = (l: () => void) => (addEventListener("resize", l), () => removeEventListener("resize", l));
export const useWindowWidth = () => useSyncExternalStore(subscribeSize, () => innerWidth);
const useWindowHeight = () => useSyncExternalStore(subscribeSize, () => innerHeight);

/** One group drawn floating over the rest, out of the layout: the card or the bar, and everything the workspace draws for it. */
export type FloatSpec = {
  group: string;
  mode: "card" | "bar";
  shell: Shell;
  setShell: (s: Shell, keep?: boolean) => void;
  bar: Bar;
  setBar: (b: Bar, keep?: boolean) => void;
  /** Drawn as its rail tab (card) / its pill (bar): its own fold, or the comment list is the open card. The panes stay mounted, hidden. */
  folded: boolean;
  /** The agent of the session shown, its name (the tab's), the state line, the last thing said, and whether something new came while it was folded. */
  kind: AgentKind | undefined;
  label: string;
  status: StatusLine;
  said: string;
  dot: boolean;
  onFold: () => void;
  onUnfold: () => void;
  onDock: () => void;
  onExpand: () => void;
  onShrink: () => void;
};

const useTick = (ms: number, on: boolean) => {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
};

export function useSessionFloat(a: { root: Node; kindOf: (tab: string) => "canvas" | "session" | undefined; sessionOf: (tab: string) => string | undefined; title: (tab: string) => string }): FloatSpec | undefined {
  const { floatSession } = usePrefs();
  const windowW = useWindowWidth();
  const windowH = useWindowHeight();
  const [shell, setShell] = useShell("session");
  const [bar, setBar] = useBar();
  const all = groups(a.root);
  const sg = all.find((g) => groupKind(g.tabs, a.kindOf) === "session");
  const form = sg ? floatMode({ pref: floatSession, windowW, windowH, canvasColumn: all.length > 1 }) : "dock";
  const mode = form === "dock" ? null : form;
  // only the card is "the open card": the comment list being the open one folds it to its rail tab, without changing what the person chose. The bar and the comment list can be up together.
  const open = useClaim("session", mode === "card" && !shell.folded);
  const folded = mode === "bar" ? bar.folded : shell.folded || open === "comments";
  const sid = sg && a.sessionOf(sg.active);
  useTick(20000, !!mode);
  const key = useSyncExternalStore(agents.subscribe, () => {
    const st = sid ? agents.get().status[sid] : undefined;
    const items = sid ? agents.get().items[sid] : undefined;
    return `${!!st?.running}|${!!st?.busy}|${!!st?.waiting}|${!!st?.held}|${items?.length ?? 0}|${items?.at(-1)?.at ?? 0}`;
  });
  const count = Number(key.split("|")[4]);
  const seen = useRef(count);
  useEffect(() => void (!folded && (seen.current = count)));
  if (!mode || !sg) return undefined;
  const st = sid ? agents.get().status[sid] : undefined;
  const items = (sid && agents.get().items[sid]) || [];
  return {
    group: sg.id,
    mode,
    shell,
    setShell,
    bar,
    setBar,
    folded,
    kind: sid ? agents.get().bindings[sid]?.agent : undefined,
    label: a.title(sg.active),
    status: statusLine({ running: !!st?.running, busy: !!st?.busy, waiting: !!st?.waiting, held: !!st?.held, lastAt: items.at(-1)?.at ?? null, now: Date.now() }),
    said: lastSaid(items),
    dot: folded && count > seen.current,
    onFold: () => (mode === "bar" ? setBar({ ...bar, folded: true, expanded: false }) : setShell({ ...shell, folded: true })),
    onUnfold: () => (mode === "bar" ? setBar({ ...bar, folded: false }) : (setShell({ ...shell, folded: false }), floatFocus.set("session"))),
    onDock: () => prefs.set({ floatSession: "dock" }),
    onExpand: () => setBar({ ...bar, expanded: true }),
    onShrink: () => setBar({ ...bar, expanded: false }),
  };
}
