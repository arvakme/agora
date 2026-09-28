// The progress pointer on an architecture diagram: one marker on the element whose code the
// followed session changed last, the files that fall outside every element, and the editor
// for an element's code paths. Rules and data flow: docs/progress-pointer.md.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { threadStores } from "../comments/threads";
import { layoutPins } from "../comments/pinLayout";
import { IconCode, IconHint, IconTarget } from "../app/icons";
import type { CanvasViewState } from "../canvas/CanvasView";
import { bbox, codePathsOf, isShape, labelOf, live, type El } from "../canvas/scene";
import { footprint, inflate, obstacles, overlaps, placeBeside, type Box } from "../canvas/clearance";
import { AGENT_NAMES, useAgents } from "../session/agents";
import { AgentAvatar } from "../session/AgentAvatar";
import { buildTurns, filesOf } from "../session/trajectoryModel";
import { openTrajectory, ui } from "../session/ui";
import { elementFor, place, type Placed } from "./codeLinks";
import { useFollowedSession } from "./follow";
import { linksOf, writeCodePaths } from "./writeLinks";
import "./pointer.css";

const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const OP: Record<string, string> = { edit: "改", write: "写", add: "新建", delete: "删" };
const base = (p: string) => p.split("/").pop() || p;
const GLIDE = { type: "spring", stiffness: 170, damping: 26 } as const;

const NONE: never[] = [];
const noSub = () => () => {};

function goTurn(sessionId: string, turn: number) {
  ui.openSession(sessionId);
  setTimeout(() => openTrajectory(sessionId, turn), 120);
}

export function PointerLayer({ api, view }: { api: ExcalidrawImperativeAPI; view: CanvasViewState }) {
  const sid = useFollowedSession();
  const ag = useAgents();
  const binding = sid ? ag.bindings[sid] : undefined;
  const items = sid ? ag.items[sid] : undefined;
  const status = sid ? ag.status[sid] : undefined;
  const links = useMemo(() => linksOf(view.elements), [view.elements]);
  const turns = useMemo(() => buildTurns(items ?? [], { model: binding?.model, effort: binding?.effort }, !!(status?.running || status?.busy)), [items, binding, status?.running, status?.busy]);
  const state = useMemo(() => place(filesOf(turns), links), [turns, links]);
  const [open, setOpen] = useState<"pointer" | "outside" | null>(null);
  const [outsideOpen, setOutsideOpen] = useState<string | null>(null);

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
  const screen = (e: El) => {
    const b = bbox(e);
    return { x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.width * z, h: b.height * z };
  };
  const cur = state.current;
  const el = cur?.element ? view.map.get(cur.element) : undefined;
  // The ring goes around the node and its caption (an icon's name below it), with room to spare,
  // so neither its edge nor its tint crosses the node's text.
  const toScreen = (b: Box): Box => ({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z });
  const pos = live(el) ? inflate(toScreen(footprint(el, view.map, view.elements)), 6) : null;
  // The label sits outside the ring on the first side where it covers nothing else.
  const chipRef = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState({ w: 200, h: 28 });
  useLayoutEffect(() => {
    const r = chipRef.current?.firstElementChild as HTMLElement | null | undefined;
    if (r && (r.offsetWidth !== chip.w || r.offsetHeight !== chip.h)) setChip({ w: r.offsetWidth, h: r.offsetHeight });
  });
  // Comment pins count too: the label must not hide a pin on the node's corner.
  const tstore = threadStores.get(view.id);
  const threads = useSyncExternalStore(tstore?.subscribe ?? noSub, () => tstore?.get().threads ?? NONE);
  const blocks = useMemo(() => {
    if (!pos) return [];
    const drawing = obstacles(view.elements, view.map).map(toScreen).filter((b) => !overlaps(b, pos, -8));
    return [...drawing, ...layoutPins(threads, view).boxes];
  }, [view.elements, view.map, a.scrollX, a.scrollY, z, pos?.x, pos?.y, pos?.w, pos?.h, threads]);
  const label = pos ? placeBeside(pos, chip.w, chip.h, blocks, { x: 0, y: 0, w: a.width, h: a.height }, { gap: 6 }) : null;

  // Glide only when the pointer moves to another element; panning and zooming follow at once.
  const [gliding, setGliding] = useState(false);
  const lastEl = useRef<string | null>(null);
  useEffect(() => {
    if (!cur?.element || cur.element === lastEl.current) return;
    const first = lastEl.current === null;
    lastEl.current = cur.element;
    if (first) return;
    setGliding(true);
    const t = setTimeout(() => setGliding(false), 900);
    return () => clearTimeout(t);
  }, [cur?.element]);

  // The render that lands on a new element already animates (the effect above runs after it).
  const glide = gliding || (!!cur?.element && lastEl.current !== null && cur.element !== lastEl.current);
  const recent = cur?.element ? (state.byElement.get(cur.element) ?? []).slice(0, 12) : [];
  const agentName = binding ? AGENT_NAMES[binding.agent] : "Agent";

  return (
    <div className="ds ptr-layer">
      {links.length > 0 && pos && cur && sid && (
        <>
          <motion.span className="ptr-ring" initial={false} animate={{ x: pos.x, y: pos.y, width: pos.w, height: pos.h }} transition={glide ? GLIDE : { duration: 0 }} />
          <motion.div ref={chipRef} className="ptr ptr-ui" data-side={label!.side} initial={false} animate={{ x: Math.round(label!.x), y: Math.round(label!.y) }} transition={glide ? GLIDE : { duration: 0 }} data-running={turns.at(-1)?.running}>
            <button className="ptr-chip" onClick={() => setOpen(open === "pointer" ? null : "pointer")} aria-expanded={open === "pointer"} title={`${agentName} 最近在改「${labelOf(el!, view.map)}」的代码`}>
              <IconTarget size={16} replayKey={state.placed.length} />
              {binding && <AgentAvatar kind={binding.agent} size="xs" />}
              <b>{agentName}</b>
              <span className="ptr-file">{base(cur.path)}</span>
              <time>{clock(cur.at)}</time>
            </button>
            <AnimatePresence>
              {open === "pointer" && (
                <motion.div className="ptr-pop" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
                  <div className="ptr-pop-head">
                    <b>{labelOf(el!, view.map) || el!.id}</b>
                    <span>{codePathsOf(el).join("  ")}</span>
                  </div>
                  <ul className="ptr-list">
                    {recent.map((p) => (
                      <FileRow key={p.path} p={p} onTurn={() => goTurn(sid, p.turn)} />
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </>
      )}
      {links.length > 0 && sid && state.outside.length > 0 && (
        <div className="ptr-outside ptr-ui">
          <button className="ptr-pill" onClick={() => setOpen(open === "outside" ? null : "outside")} aria-expanded={open === "outside"}>
            <IconHint size={14} />
            在架构图之外
            <em>{state.outside.length}</em>
          </button>
          {open === "outside" && (
            <div className="ptr-pop ptr-pop-up">
              <div className="ptr-pop-head">
                <b>{binding && <AgentAvatar kind={binding.agent} size="xs" />}{agentName} 改了这些文件，但它们不属于任何节点</b>
                <span>给节点关联代码路径后，它们会落到节点上</span>
              </div>
              <ul className="ptr-list">
                {state.outside.map((o) => (
                  <li key={o.path} data-open={outsideOpen === o.path}>
                    <button className="ptr-row" onClick={() => setOutsideOpen(outsideOpen === o.path ? null : o.path)}>
                      <em>{OP[o.op] ?? o.op}</em>
                      <code>{o.path}</code>
                      <time>{clock(o.at)}</time>
                    </button>
                    {outsideOpen === o.path && (
                      <div className="ptr-turns">
                        在
                        {o.turns.map((n) => (
                          <button key={n} className="ptr-link" onClick={() => goTurn(sid, n)}>
                            第 {n} 轮
                          </button>
                        ))}
                        改过 · 点轮次看轨迹
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <LinkEditor api={api} view={view} placed={state.placed} links={links} screen={screen} />
    </div>
  );
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

/** Selected box or frame → "代码路径" chip → edit its globs (one per line). */
function LinkEditor({ api, view, placed, links, screen }: { api: ExcalidrawImperativeAPI; view: CanvasViewState; placed: Placed[]; links: ReturnType<typeof linksOf>; screen: (e: El) => { x: number; y: number; w: number; h: number } }) {
  const ids = Object.keys(view.appState.selectedElementIds ?? {}).map((id) => {
    const e = view.map.get(id);
    return e?.type === "text" && e.containerId ? e.containerId : id;
  });
  const uniq = [...new Set(ids)].filter((id) => {
    const e = view.map.get(id);
    return live(e) && (isShape(e) || e.type === "frame");
  });
  const target = uniq.length === 1 ? view.map.get(uniq[0]) : undefined;
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (editing && editing !== target?.id) setEditing(null);
  }, [target?.id]);
  if (!target) return null;
  const paths = codePathsOf(target);
  const s = screen(target);
  const draft = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const preview = editing
    ? (() => {
        const others = links.filter((l) => l.id !== target.id);
        const mine = { id: target.id, label: "", globs: draft };
        const hits = [...new Set(placed.filter((p) => elementFor(p.path, [...others, mine])?.link.id === target.id).map((p) => p.path))];
        return hits;
      })()
    : [];
  const save = (globs: string[]) => {
    writeCodePaths(api, new Map([[target.id, globs]]));
    setEditing(null);
  };
  return (
    <div className="ptr-edit ptr-ui" style={{ left: s.x + s.w + 8, top: s.y }}>
      {editing !== target.id ? (
        <button
          className="ptr-pill"
          onClick={() => {
            setText(paths.join("\n"));
            setEditing(target.id);
          }}
          title={paths.length ? paths.join("\n") : "让这个节点代表一部分代码，进度指针就能落在它上面"}
        >
          <IconCode size={14} />
          {paths.length ? `代码路径 · ${paths.length}` : "关联代码路径"}
        </button>
      ) : (
        <div className="ptr-pop ptr-editor">
          <div className="ptr-pop-head">
            <b>「{labelOf(target, view.map) || target.id}」代表的代码</b>
            <span>相对项目根目录，一行一个，如 server/** 或 web/src/api/*.ts</span>
          </div>
          <textarea
            autoFocus
            rows={Math.max(3, draft.length + 1)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(draft);
            }}
            spellCheck={false}
            aria-label="代码路径"
          />
          {draft.length > 0 && <p className="ptr-hint">{preview.length ? `会话改过的 ${preview.length} 个文件会落到这里：${preview.slice(0, 3).join("、")}${preview.length > 3 ? " …" : ""}` : "会话里还没有改过匹配的文件"}</p>}
          <div className="ptr-actions">
            {paths.length > 0 && (
              <button className="ptr-quiet" onClick={() => save([])}>
                清除
              </button>
            )}
            <button className="ptr-quiet" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="ptr-primary" onClick={() => save(draft)}>
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
