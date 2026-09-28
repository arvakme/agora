// Progress pointers on an architecture diagram: one per active agent session, on the node whose
// code that session changed last (docs/progress-pointer.md, docs/multi-agent.md). Several sessions
// on one node share its ring and their labels sit side by side. Files outside every node are listed
// per session; two sessions writing the same file or node close together get a conflict mark.
// On a canvas with child canvases, a node also stands for the code its child canvases claim
// (docs/nested-canvas.md), so the overview lights the node the work is happening under.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { threadStores } from "../comments/threads";
import { layoutPins } from "../comments/pinLayout";
import { IconHint, IconTarget } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { bbox, codePathsOf, isShape, labelOf, live, type El } from "../canvas/scene";
import { footprint, inflate, obstacles, overlaps, placeBeside, type Box } from "../canvas/clearance";
import { NodeBar } from "../canvas/NodeBar";
import type { NodePop } from "../canvas/nodeBarLayout";
import { clipPath, edgeSpot, notOwn, occluded } from "../canvas/chrome";
import { AGENT_NAMES, useAgents, type AgentKind } from "../session/agents";
import { AgentAvatar } from "../session/AgentAvatar";
import { openTrajectory, ui } from "../session/ui";
import { effectiveLinks } from "../nested/graph";
import { useNested } from "../nested/store";
import { activeSessions, conflicts, sessionPointers, stacks, until, type Conflict } from "../multi/pointers";
import { useSessionFolds, useSessionNames } from "../multi/writes";
import { useReplayAt } from "../workstation/clock";
import { elementFor, type Placed } from "./codeLinks";
import { useFollowedSession } from "./follow";
import "./pointer.css";

const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const OP: Record<string, string> = { edit: "改", write: "写", add: "新建", delete: "删" };
const base = (p: string) => p.split("/").pop() || p;
const GLIDE = { type: "spring", stiffness: 170, damping: 26 } as const;
const CHIP_GAP = 6;
const CLASH_W = 84;

const NONE: never[] = [];
const noSub = () => () => {};

function goTurn(sessionId: string, turn: number) {
  ui.openSession(sessionId);
  setTimeout(() => openTrajectory(sessionId, turn), 120);
}

/** How a session is called on the canvas: the agent, or the session's name when two of one agent are active. */
export function useSessionLabel() {
  const ag = useAgents();
  const names = useSessionNames();
  return (sid: string, among: string[] = []) => {
    const kind = ag.bindings[sid]?.agent;
    const agent = kind ? AGENT_NAMES[kind] : "Agent";
    const twins = among.filter((x) => ag.bindings[x]?.agent === kind).length > 1;
    return twins ? names[sid] || agent : agent;
  };
}

/** Sessions whose element just changed glide there; panning and zooming follow at once. */
function useGliding(at: Record<string, string>) {
  const last = useRef<Record<string, string>>({});
  const [until, setUntil] = useState<Record<string, number>>({});
  const moved = Object.keys(at).filter((k) => last.current[k] !== undefined && last.current[k] !== at[k]);
  const key = JSON.stringify(at);
  useEffect(() => {
    last.current = { ...at };
    if (!moved.length) return;
    const end = Date.now() + 900;
    setUntil((g) => ({ ...g, ...Object.fromEntries(moved.map((k) => [k, end])) }));
    const t = setTimeout(() => setUntil((g) => Object.fromEntries(Object.entries(g).filter(([, u]) => u > Date.now()))), 950);
    return () => clearTimeout(t);
  }, [key]);
  return (sid: string) => moved.includes(sid) || (until[sid] ?? 0) > Date.now();
}

type Open = { kind: "pointer"; sid: string } | { kind: "outside" } | { kind: "conflict"; element: string } | null;

export function PointerLayer({ api, view, chrome = [] }: { api: ExcalidrawImperativeAPI; view: CanvasViewState; chrome?: Box[] }) {
  const followed = useFollowedSession();
  const ag = useAgents();
  const folds = useSessionFolds();
  const st = useNested();
  const at = useReplayAt(true);
  const label = useSessionLabel();
  const links = useMemo(() => effectiveLinks(view.id, new Map(st.scenes).set(view.id, view.elements)), [view.id, view.elements, st.scenes]);
  const minute = Math.floor((at ?? Date.now()) / 60_000);
  const active = useMemo(() => {
    const info = (id: string) => {
      const f = folds.find((x) => x.sessionId === id)!;
      return { lastAt: f.lastAt, running: f.running };
    };
    return activeSessions(folds.map((f) => f.sessionId), info, at ?? Date.now(), followed);
  }, [folds, followed, minute, at == null]);
  const activeFolds = useMemo(() => folds.filter((f) => active.includes(f.sessionId)), [folds, active]);
  const pointers = useMemo(() => sessionPointers(activeFolds, links, at).filter((p) => p.state.placed.length), [activeFolds, links, at]);
  const piles = useMemo(() => stacks(pointers, followed), [pointers, followed]);
  const clashes = useMemo(() => conflicts(folds, links, { now: Date.now(), at }), [folds, links, at, minute]);
  const followedState = pointers.find((p) => p.sessionId === followed)?.state ?? pointers[0]?.state;
  const [open, setOpen] = useState<Open>(null);
  const [outsideOpen, setOutsideOpen] = useState<string | null>(null);
  // The node action bar's popover (代码路径 / 子图): one popover open at a time across the canvas.
  const [nodeOpen, setNodeOpen] = useState<NodePop | null>(null);
  useEffect(() => {
    if (open) setNodeOpen(null);
  }, [open]);
  const openNode = (p: NodePop | null) => {
    setNodeOpen(p);
    if (p) (setOpen(null), setOutsideOpen(null));
  };
  // Overlays place themselves against the panels, not against the node action bar (it moves for them).
  const free = useMemo(() => notOwn(chrome), [chrome]);

  // A click anywhere outside the pointer's own UI closes its popovers.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".ptr-ui")) (setOpen(null), setOutsideOpen(null));
    };
    addEventListener("pointerdown", close, true);
    return () => removeEventListener("pointerdown", close, true);
  }, [open]);

  const a = view.appState;
  const z = a.zoom.value;
  const toScreen = (b: Box): Box => ({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z });

  // Chip widths, measured, so one node's labels can be laid side by side.
  const chipRefs = useRef(new Map<string, HTMLElement>());
  const [widths, setWidths] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    chipRefs.current.forEach((el, sid) => (next[sid] = el.offsetWidth));
    const changed = Object.keys(next).length !== Object.keys(widths).length || Object.keys(next).some((k) => Math.abs((widths[k] ?? 0) - next[k]) > 0.5);
    if (changed) setWidths(next);
  });

  const byNode = new Map<string, Conflict[]>();
  for (const c of clashes) if (c.element && view.map.has(c.element)) byNode.set(c.element, [...(byNode.get(c.element) ?? []), c]);

  const tstore = threadStores.get(view.id);
  const threads = useSyncExternalStore(tstore?.subscribe ?? noSub, () => tstore?.get().threads ?? NONE);
  const drawing = useMemo(() => obstacles(view.elements, view.map).map(toScreen), [view.elements, view.map, a.scrollX, a.scrollY, z]);
  const pins = useMemo(() => layoutPins(threads, view).boxes, [threads, view]);
  const { placed: layout, hidden } = useMemo(() => {
    const placed: { element: string; ring: Box; x: number; y: number; side: string; chips: { sid: string; dx: number }[]; clashX?: number }[] = [];
    const hidden: { element: string; sids: string[]; spot: ReturnType<typeof edgeSpot> }[] = [];
    const viewBox = { x: 0, y: 0, w: a.width, h: a.height };
    for (const s of piles) {
      const el = view.map.get(s.element);
      if (!live(el)) continue;
      const ring = inflate(toScreen(footprint(el, view.map, view.elements)), 6);
      // Behind a panel or off-screen: no ring there, an indicator on the nearest free edge instead.
      if (occluded(ring, viewBox, free)) {
        const w = 44 + 18 * s.pointers.length;
        const spot = edgeSpot(ring, viewBox, [...free, ...hidden.map((h) => h.spot)], w, 28);
        hidden.push({ element: s.element, sids: s.pointers.map((p) => p.sessionId), spot });
        continue;
      }
      const ws = s.pointers.map((p) => widths[p.sessionId] ?? 200);
      // A conflict on this node sits at the end of its label row, not on the drawing.
      const clash = byNode.has(s.element) ? CLASH_W + CHIP_GAP : 0;
      const w = ws.reduce((n, x) => n + x, 0) + CHIP_GAP * (ws.length - 1) + clash;
      // Labels stay off the drawing, the pins, other rings and the labels placed before them.
      const blocks = [...drawing.filter((b) => !overlaps(b, ring, -8)), ...pins, ...free, ...hidden.map((h) => h.spot), ...placed.flatMap((p) => [p.ring, { x: p.x, y: p.y, w: p.chips.reduce((n, c) => Math.max(n, c.dx + (widths[c.sid] ?? 200)), 0), h: 28 }])];
      const spot = placeBeside(ring, w, 28, blocks, { x: 0, y: 0, w: a.width, h: a.height }, { gap: 6 });
      let dx = 0;
      const chips = s.pointers.map((p, i) => {
        const c = { sid: p.sessionId, dx };
        dx += ws[i] + CHIP_GAP;
        return c;
      });
      placed.push({ element: s.element, ring, x: spot.x, y: spot.y, side: spot.side, chips, clashX: clash ? dx : undefined });
    }
    return { placed, hidden };
  }, [drawing, pins, piles, view.elements, view.map, a.scrollX, a.scrollY, z, a.width, a.height, threads, widths, clashes, free]);
  const clip = useMemo(() => clipPath({ x: 0, y: 0, w: a.width, h: a.height }, chrome), [a.width, a.height, chrome]);

  const elOf = Object.fromEntries(pointers.flatMap((p) => (p.state.current?.element ? [[p.sessionId, p.state.current.element]] : [])));
  const glides = useGliding(elOf);
  const running = (sid: string) => !!(ag.status[sid]?.running || ag.status[sid]?.busy);
  const shownIds = pointers.map((p) => p.sessionId);
  const outsideCount = pointers.reduce((n, p) => n + p.state.outside.length, 0);

  // The selected node's action bar stays off the panels, every pointer label and pin, the edge
  // indicators, the conflict marks and the 「在架构图之外」 pill.
  const labelBoxes = layout.map((l) => ({ x: l.x, y: l.y, w: l.chips.reduce((n, c) => Math.max(n, c.dx + (widths[c.sid] ?? 200)), 0) + (l.clashX !== undefined ? CLASH_W : 0), h: 28 }));
  const outsideBox = outsideCount > 0 ? [{ x: 12, y: a.height - 64 - 28, w: 200, h: 28 }] : [];
  const editor = (
    <div className="ds">
      <NodeBar
        api={api}
        view={view}
        canvasId={view.id}
        open={nodeOpen}
        onOpen={openNode}
        hard={[...free, ...labelBoxes, ...hidden.map((h) => h.spot), ...pins, ...outsideBox]}
        soft={drawing}
        chrome={free}
        placed={followedState?.placed ?? []}
        links={links}
      />
    </div>
  );
  if (!links.length) return editor;
  return (
    <>
    {editor}
    <div className="ds ptr-layer" style={{ clipPath: clip }}>
      {hidden.map((h) => {
        const el = view.map.get(h.element)!;
        const names = h.sids.map((sid) => label(sid, shownIds)).join("、");
        return (
          <button
            key={`edge-${h.element}`}
            className="ptr-edge ptr-ui"
            style={{ transform: `translate(${h.spot.x}px, ${h.spot.y}px)` }}
            // Not animated: Excalidraw's animated scroll does not report the final view (onChange)
            // until the next pointer move, so the layers would lag behind it.
            onClick={() => api.scrollToContent(el, { animate: false })}
            title={`${names} 在改「${labelOf(el, view.map) || "未命名节点"}」——它被面板挡住或在视野外，点击定位`}
            aria-label={`定位到 ${labelOf(el, view.map) || "未命名节点"}`}
          >
            {h.sids.map((sid) => {
              const kind = ag.bindings[sid]?.agent as AgentKind | undefined;
              return kind ? <AgentAvatar key={sid} kind={kind} size={16} /> : null;
            })}
            <svg className="ptr-edge-arrow" width="14" height="14" viewBox="0 0 14 14" style={{ transform: `rotate(${Math.round(h.spot.angle)}deg)` }} aria-hidden>
              <path d="M2 7h9M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        );
      })}
      {layout.map((l) => (
        <motion.span
          key={`ring-${l.chips[0].sid}`}
          className="ptr-ring"
          data-shared={l.chips.length > 1 || undefined}
          initial={false}
          animate={{ x: l.ring.x, y: l.ring.y, width: l.ring.w, height: l.ring.h }}
          transition={glides(l.chips[0].sid) ? GLIDE : { duration: 0 }}
        />
      ))}
      {layout.flatMap((l) =>
        l.chips.map(({ sid, dx }) => {
          const p = pointers.find((x) => x.sessionId === sid)!;
          const cur = p.state.current!;
          const el = view.map.get(cur.element!)!;
          const kind = ag.bindings[sid]?.agent as AgentKind | undefined;
          const name = label(sid, shownIds);
          const own = links.find((x) => x.id === cur.element)?.own ?? [];
          const rolled = !!cur.glob && !own.includes(cur.glob);
          const isOpen = open?.kind === "pointer" && open.sid === sid;
          const recent = (p.state.byElement.get(cur.element!) ?? []).slice(0, 12);
          return (
            <motion.div
              key={`chip-${sid}`}
              className="ptr ptr-ui"
              data-side={l.side}
              data-followed={sid === followed || undefined}
              data-session={sid}
              initial={false}
              animate={{ x: Math.round(l.x + dx), y: Math.round(l.y) }}
              transition={glides(sid) ? GLIDE : { duration: 0 }}
              data-running={running(sid) && at == null}
            >
              <button
                ref={(n) => {
                  if (n) chipRefs.current.set(sid, n);
                  else chipRefs.current.delete(sid);
                }}
                className="ptr-chip"
                onClick={() => setOpen(isOpen ? null : { kind: "pointer", sid })}
                aria-expanded={isOpen}
                title={`${name} ${at == null ? "最近" : "在这一刻"}在改「${labelOf(el, view.map)}」${rolled ? "下面子图里" : ""}的代码`}
              >
                {sid === followed && <IconTarget size={16} replayKey={p.state.placed.length} />}
                {kind && <AgentAvatar kind={kind} size={16} />}
                <b>{name}</b>
                <span className="ptr-file">{rolled ? "子图 · " : ""}{base(cur.path)}</span>
                <time>{clock(cur.at)}</time>
              </button>
              <AnimatePresence>
                {isOpen && (
                  <motion.div className="ptr-pop" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
                    <div className="ptr-pop-head">
                      <b>{kind && <AgentAvatar kind={kind} size={16} />}{name} · {labelOf(el, view.map) || "未命名节点"}</b>
                      <span>{codePathsOf(el).join("  ") || (rolled ? "代码路径在它的子图里" : "")}</span>
                    </div>
                    <ul className="ptr-list">
                      {recent.map((f) => (
                        <FileRow key={f.path} p={f} onTurn={() => goTurn(sid, f.turn)} />
                      ))}
                    </ul>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        }),
      )}
      {[...byNode].map(([element, cs]) => {
        const el = view.map.get(element);
        if (!live(el)) return null;
        const r = inflate(toScreen(footprint(el, view.map, view.elements)), 6);
        if (occluded(r, { x: 0, y: 0, w: a.width, h: a.height }, chrome)) return null; // the edge indicator speaks for it
        const isOpen = open?.kind === "conflict" && open.element === element;
        // Next to that node's pointer labels when it has some; else just above its top-left corner.
        const row = layout.find((l) => l.element === element && l.clashX !== undefined);
        const at = row ? { x: row.x + row.clashX!, y: row.y + 3 } : { x: r.x, y: r.y - 26 };
        return (
          <div key={`clash-${element}`} className="ptr-clash ptr-ui" style={{ transform: `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)` }}>
            <button className="ptr-clash-btn" onClick={() => setOpen(isOpen ? null : { kind: "conflict", element })} aria-expanded={isOpen} title={cs.map((c) => clashText(c, label)).join("\n")}>
              <span className="nest-dot" aria-hidden />
              可能冲突
            </button>
            {isOpen && (
              <div className="ptr-pop">
                <div className="ptr-pop-head">
                  <b>「{labelOf(el, view.map) || "未命名节点"}」：两个会话短时间内都写了这里</b>
                  <span>Agora 不会阻止，只提醒：看看两边的改动是否互相覆盖</span>
                </div>
                <ul className="ptr-list">
                  {cs.map((c) => (
                    <li key={`${c.kind}${c.path}${c.sessions.join()}`} className="ptr-clash-row">
                      <p>{clashText(c, label)}</p>
                      <div>
                        {c.writes.map((w) => (
                          <button key={w.toolId} className="ptr-link" onClick={() => goTurn(w.sessionId, w.turn)}>
                            {label(w.sessionId, c.sessions)} · 第 {w.turn} 轮
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
      {outsideCount > 0 && (
        <div className="ptr-outside ptr-ui">
          <button className="ptr-pill" onClick={() => setOpen(open?.kind === "outside" ? null : { kind: "outside" })} aria-expanded={open?.kind === "outside"}>
            <IconHint size={14} />
            在架构图之外
            <em>{outsideCount}</em>
          </button>
          {open?.kind === "outside" && (
            <div className="ptr-pop ptr-pop-up">
              <div className="ptr-pop-head">
                <b>这些文件改过，但不属于任何节点</b>
                <span>按会话分组 · 给节点关联代码路径后，它们会落到节点上</span>
              </div>
              <ul className="ptr-list">
                {pointers
                  .filter((p) => p.state.outside.length)
                  .flatMap((p) => {
                    const kind = ag.bindings[p.sessionId]?.agent as AgentKind | undefined;
                    return [
                      <li key={`h-${p.sessionId}`} className="ptr-group">
                        {kind && <AgentAvatar kind={kind} size={16} />}
                        {label(p.sessionId, shownIds)}
                        <em>{p.state.outside.length}</em>
                      </li>,
                      ...p.state.outside.map((o) => {
                        const k = `${p.sessionId}:${o.path}`;
                        const clash = clashes.find((c) => c.kind === "file" && c.path === o.path && c.sessions.includes(p.sessionId));
                        return (
                          <li key={k} data-open={outsideOpen === k}>
                            <button className="ptr-row" onClick={() => setOutsideOpen(outsideOpen === k ? null : k)} title={clash ? clashText(clash, label) : undefined}>
                              <em>{OP[o.op] ?? o.op}</em>
                              <code>{o.path}</code>
                              {clash ? <span className="nest-dot" aria-label="可能冲突" /> : <span />}
                              <time>{clock(o.at)}</time>
                            </button>
                            {outsideOpen === k && (
                              <div className="ptr-turns">
                                在
                                {o.turns.map((n) => (
                                  <button key={n} className="ptr-link" onClick={() => goTurn(p.sessionId, n)}>
                                    第 {n} 轮
                                  </button>
                                ))}
                                改过 · 点轮次看轨迹
                              </div>
                            )}
                          </li>
                        );
                      }),
                    ];
                  })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

/** "Claude Code 与 Codex 在 3 分钟内都改了 server/app.py" */
export function clashText(c: Conflict, label: (sid: string, among?: string[]) => string) {
  const [a, b] = c.sessions.map((s) => label(s, c.sessions));
  const gap = Math.max(1, Math.round((c.writes[1].at - c.writes[0].at) / 60_000));
  return c.kind === "file" ? `${a} 与 ${b} 在 ${gap} 分钟内都改了 ${c.path}` : `${a} 改了 ${base(c.writes[0].path)}，${b} 在 ${gap} 分钟内改了同一节点的 ${base(c.writes[1].path)}`;
}

function FileRow({ p, onTurn }: { p: Placed; onTurn: () => void }) {
  return (
    <li>
      <div className="ptr-row">
        <em>{OP[p.op] ?? p.op}</em>
        <code title={p.glob ? `匹配 ${p.glob}` : undefined}>{p.path}</code>
        <button className="ptr-link" onClick={onTurn} title="在轨迹里看这一轮">
          第 {p.turn} 轮
        </button>
        <time>{clock(p.at)}</time>
      </div>
    </li>
  );
}
