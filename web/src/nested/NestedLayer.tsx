// Nested canvases on a canvas (docs/nested-canvas.md): the "can be entered" marker at the
// bottom-right of every node that opens a child canvas (with the child's open comments and a
// "may be out of date" mark), the breadcrumb above a child canvas, and the node menu that makes,
// expands (by the session's agent), enters or unlinks a child.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IconBack, IconEnter, IconHint, IconNested, IconSparkles } from "../app/icons";
import { lang, tr } from "../i18n";
import type { CanvasViewState } from "../canvas/CanvasView";
import { codePathsOf, isShape, labelOf, live, type El } from "../canvas/scene";
import { nodeBox } from "../canvas/nodes";
import { clipPath } from "../canvas/chrome";
import type { Box } from "../canvas/clearance";
import { threadStores } from "../comments/threads";
import { useSessionFolds } from "../multi/writes";
import { agents } from "../session/agents";
import { DRAW_CHILD_MARK } from "../session/pageMessage";
import { sessions } from "../session/store";
import { ui } from "../session/ui";
import { pointerFollow } from "../pointer/follow";
import { ancestry, childOf, descendants, openThreads, staleness, type Staleness } from "./graph";
import { blankChild, nav, nested, useNested } from "./store";
import { ENTER_KEY_LABEL, MARK_SIZE } from "./enter";
import { BACK_HINT_MS, backHintDue, backHintQuiet, backHintSeen, backHintVisible, markBackHintSeen, onBackHintSeen, staleDot, staleNote, upKeyLabel } from "./up";
import { writeChildLink } from "./writeChild";
import "./nested.css";

const noSub = () => () => {};

/** Open comments in a canvas and everything below it (owner page: the live thread stores). */
function useOpenBelow(ids: string[]): Record<string, number> {
  const key = ids.join(",");
  const sub = useMemo(() => (l: () => void) => {
    const offs = [...threadStores.entries()].map(([, s]) => s.subscribe(l));
    return () => offs.forEach((f) => f());
  }, [key, threadStores.size]);
  const snap = () => ids.map((id) => openThreads(threadStores.get(id)?.get().threads ?? [])).join(",");
  const joined = useSyncExternalStore(ids.length ? sub : noSub, snap);
  return Object.fromEntries(joined.split(",").map((n, i) => [ids[i], Number(n) || 0]));
}

export type ChildInfo = { title: string; open: number; stale?: Staleness };

/** Marker per node with a child canvas; `info` says which children exist (owner page or share guest). */
export function ChildMarkers({ view, canvasId, info, onEnter, chrome = [] }: { view: CanvasViewState; canvasId: string; info: (child: string) => ChildInfo | null; onEnter: (child: string, node: string) => void; chrome?: Box[] }) {
  const a = view.appState;
  const z = a.zoom.value;
  const nodes = view.elements.filter((e) => live(e) && childOf(e) && (isShape(e) || e.type === "frame") && childOf(e) !== canvasId);
  const clip = useMemo(() => clipPath({ x: 0, y: 0, w: a.width, h: a.height }, chrome), [a.width, a.height, chrome]);
  return (
    <div className="nest-layer" style={{ clipPath: clip }}>
      {nodes.map((e) => {
        const child = childOf(e)!;
        const i = info(child);
        if (!i) return null;
        // Bottom-right of the whole node: a library icon's or group's parts and label included.
        const b = nodeBox(e, view.map, view.elements);
        const x = (b.x + b.w + a.scrollX) * z;
        const y = (b.y + b.h + a.scrollY) * z;
        const stale = !!i.stale?.files.length;
        return (
          <button
            key={e.id}
            className="nest-mark"
            data-stale={stale || undefined}
            style={{ transform: `translate(${Math.round(x - MARK_SIZE / 2 - 2)}px, ${Math.round(y - MARK_SIZE / 2)}px)`, minWidth: MARK_SIZE, height: MARK_SIZE }}
            onClick={() => onEnter(child, e.id)}
            title={tr(
              `进入子图「${i.title}」${i.open ? ` · ${i.open} 条未解决评论` : ""}${stale ? ` · 可能过时：${i.stale!.files.length} 次改动发生在子图画好之后` : ""}（选中节点后 ${ENTER_KEY_LABEL}）`,
              `Enter sub-diagram “${i.title}”${i.open ? ` · ${i.open} unresolved ${i.open === 1 ? "comment" : "comments"}` : ""}${stale ? ` · may be out of date: ${i.stale!.files.length} ${i.stale!.files.length === 1 ? "change" : "changes"} since it was drawn` : ""} (select the node, then ${ENTER_KEY_LABEL})`,
            )}
            aria-label={tr(`进入子图 ${i.title}`, `Enter sub-diagram ${i.title}`)}
          >
            <IconEnter size={14} />
            {i.open > 0 && <em>{i.open}</em>}
            {stale && <span className="nest-dot" aria-label={tr("可能过时", "May be out of date")} />}
          </button>
        );
      })}
    </div>
  );
}

/** The owner page's markers: children that exist in this workspace, their open comments, staleness. */
export function OwnerChildMarkers({ view, canvasId, chrome }: { view: CanvasViewState; canvasId: string; chrome?: Box[] }) {
  const st = useNested();
  const folds = useSessionFolds();
  const writes = useMemo(() => folds.flatMap((f) => f.files), [folds]);
  const kids = useMemo(() => [...new Set(view.elements.map((e) => (live(e) ? childOf(e) : null)).filter((c): c is string => !!c && st.scenes.has(c)))], [view.elements, st.scenes]);
  const below = useMemo(() => Object.fromEntries(kids.map((k) => [k, [k, ...descendants(k, st.scenes)]])), [kids, st.scenes]);
  const counts = useOpenBelow([...new Set(Object.values(below).flat())]);
  const stale = useMemo(() => {
    const out: Record<string, Staleness> = {};
    for (const e of view.elements) {
      const k = live(e) ? childOf(e) : null;
      if (k && st.scenes.has(k)) out[k] = staleness(k, st.scenes, writes, codePathsOf(e), st.reviewed[k] ?? 0);
    }
    return out;
  }, [view.elements, st.scenes, st.reviewed, writes]);
  return (
    <ChildMarkers
      view={view}
      canvasId={canvasId}
      chrome={chrome}
      info={(k) => (st.scenes.has(k) ? { title: st.titles[k] ?? k, open: (below[k] ?? [k]).reduce((n, id) => n + (counts[id] ?? 0), 0), stale: stale[k] } : null)}
      onEnter={(k, node) => nav.fly(canvasId, k, node)}
    />
  );
}

/**
 * The canvas's place in its tree, shown only on a child canvas: a 「← 返回 <父画布>」 button first
 * (the obvious way back), then 总架构 › 后端 › 订单模块 (any level is one click).
 */
export function Breadcrumb({ path, current, onGo, extra, keyLabel, hint, mark }: { path: { id: string; title: string }[]; current: string; onGo: (id: string) => void; extra?: React.ReactNode; keyLabel?: string; hint?: React.ReactNode; /** By the current canvas's name (the 「可能过时」 dot). */ mark?: React.ReactNode }) {
  if (path.length < 2) return null;
  const at = path.findIndex((p) => p.id === current);
  const up = path[(at < 0 ? path.length - 1 : at) - 1];
  const name = (t: string) => t || tr("未命名画布", "Untitled canvas");
  return (
    <nav className="nest-crumbs" aria-label={tr("画布层级", "Canvas levels")}>
      {up && (
        <span className="nest-back-wrap">
          <button className="nest-back" onClick={() => onGo(up.id)} title={tr(`返回上一级「${name(up.title)}」${keyLabel ? `（${keyLabel}）` : ""}`, `Back up to “${name(up.title)}”${keyLabel ? ` (${keyLabel})` : ""}`)} aria-keyshortcuts={keyLabel === "⌘↑" ? "Meta+ArrowUp" : keyLabel ? "Control+ArrowUp" : undefined}>
            <IconBack size={14} />
            <span>{tr(`返回 ${name(up.title)}`, `Back to ${name(up.title)}`)}</span>
          </button>
        </span>
      )}
      <ol>
        {path.map((p, i) => (
          <li key={p.id}>
            {i > 0 && <span className="nest-sep" aria-hidden>›</span>}
            {p.id === current ? (
              <b aria-current="page">{name(p.title)}</b>
            ) : (
              <button onClick={() => onGo(p.id)} title={tr(`回到「${name(p.title)}」`, `Go to “${name(p.title)}”`)}>
                {name(p.title)}
              </button>
            )}
          </li>
        ))}
      </ol>
      {up && hint}
      {mark}
      {extra}
    </nav>
  );
}

/** 「在子图里。点左上角返回，或按 ⌘↑」 the first time someone is on a child canvas (once per browser). */
function BackHint({ keyLabel }: { keyLabel: string }) {
  const [show, setShow] = useState(() => !backHintSeen());
  useEffect(() => onBackHintSeen(() => setShow(false)), []);
  const quiet = useSyncExternalStore(backHintQuiet.subscribe, backHintQuiet.get);
  const visible = backHintVisible(!show, quiet);
  // once per browser: after it has been on screen a while it counts as seen (a refresh does not bring it back)
  useEffect(() => {
    if (!visible) return;
    const t0 = Date.now();
    const tm = window.setTimeout(() => backHintDue(Date.now() - t0) && markBackHintSeen(), BACK_HINT_MS);
    return () => clearTimeout(tm);
  }, [visible]);
  if (!visible) return null;
  return (
    <span className="nest-hint" role="status">
      <span>{tr(`在子图里。点左上角返回，或按 ${keyLabel}`, `In a sub-diagram — go back top left, or press ${keyLabel}`)}</span>
      <button className="nest-act quiet" onClick={() => markBackHintSeen()}>
        {tr("知道了", "Got it")}
      </button>
    </span>
  );
}

/** The owner page's breadcrumb, with the "may be out of date" notice of this child canvas. */
export function OwnerBreadcrumb({ canvasId }: { canvasId: string }) {
  const st = useNested();
  const folds = useSessionFolds();
  const chain = ancestry(canvasId, st.index);
  const parent = st.index.get(canvasId);
  const parentEl = parent ? st.scenes.get(parent.canvasId)?.find((e) => e.id === parent.elementId) : undefined;
  const stale = useMemo(
    () => (parent ? staleness(canvasId, st.scenes, folds.flatMap((f) => f.files), codePathsOf(parentEl), st.reviewed[canvasId] ?? 0) : null),
    [canvasId, st.scenes, st.reviewed, folds, parentEl],
  );
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [canvasId]);
  const files = [...new Set(stale?.files.map((f) => f.path) ?? [])];
  const keyLabel = upKeyLabel();
  return (
    <Breadcrumb
      path={chain.map((id) => ({ id, title: st.titles[id] ?? id }))}
      current={canvasId}
      onGo={(id) => (markBackHintSeen(), nav.fly(canvasId, id))}
      keyLabel={keyLabel}
      hint={<BackHint keyLabel={keyLabel} />}
      mark={
        staleDot(files.length) && (
          // a small dot by the name; the words and 「让 AI 更新」 open on hover or focus
          <span className="nest-stale-dot">
            <button className="nest-dot-btn" aria-label={staleNote(files)}>
              <span className="nest-dot" aria-hidden />
            </button>
            <span className="nest-stale-pop" role="status">
              <span className="nest-stale-note" title={files.join("\n")}>{staleNote(files)}</span>
              <button
                className="nest-act"
                disabled={sent}
                onClick={() => {
                  setSent(true);
                  void askAgent(canvasId, updatePrompt(canvasId, st.titles[canvasId] ?? canvasId, files));
                }}
              >
                <IconSparkles size={14} />
                {sent ? tr("已交给 Agent", "Handed to agent") : tr("让 AI 更新", "Ask AI to update")}
              </button>
              <button className="nest-act quiet" onClick={() => nav.review(canvasId, Date.now())} title={tr("子图和代码仍然一致：清掉这个标记", "The sub-diagram still matches the code: clear this mark")}>
                {tr("已核对", "Still accurate")}
              </button>
            </span>
          </span>
        )
      }
    />
  );
}

/** The session that acts for a canvas tree: the followed one, else the tree's most recent, else ask. */
export async function sessionFor(canvasId: string): Promise<string | undefined> {
  const st = nested.get();
  const root = ancestry(canvasId, st.index)[0];
  const family = new Set([root, ...descendants(root, st.scenes)]);
  const f = pointerFollow.get();
  if (f && agents.get().bindings[f] && family.has(sessions.get().sessions[f]?.canvasId ?? "")) return f;
  const mine = Object.values(sessions.get().sessions).filter((s) => family.has(s.canvasId)).map((s) => s.id);
  return agents.forCanvas(mine) ?? (f && agents.get().bindings[f] ? f : undefined) ?? (await ui.chooseAgent(root));
}

async function askAgent(canvasId: string, text: string) {
  const sid = await sessionFor(canvasId);
  if (!sid) return;
  ui.openSession(sid);
  await agents.send(sid, text, { canvasId, page: DRAW_CHILD_MARK });
}

const expandPrompt = (canvasId: string, el: El, label: string) => {
  const paths = codePathsOf(el);
  if (lang() === "en")
    return [
      `Expand node “${label}” into a sub-diagram that shows its inner structure one level deeper.`,
      `1. \`agora canvas child create --parent ${canvasId} --node ${el.id}\` creates the child canvas (if one exists, keep the one it returns).`,
      `2. Read the code it stands for: ${paths.length ? paths.join(", ") : "this node has no linked code paths yet; find the matching code in the repo by the node's name"}.`,
      "3. In the child canvas (`--canvas <child canvas id>`), draw the inner modules and the calls between them; link nodes that map to code to finer paths with `agora canvas link`. A level further down can be code logic or a call flow.",
      "Write commands as `agora canvas …` (agora is on PATH). Finish with a sentence or two on what the sub-diagram shows.",
    ].join("\n");
  return [
    `把节点「${label}」展开成子图，画出它内部更细一层的结构。`,
    `1. \`agora canvas child create --parent ${canvasId} --node ${el.id}\` 建子画布（已有就沿用它返回的那一块）。`,
    `2. 读它代表的代码：${paths.length ? paths.join("、") : "这个节点还没有关联代码路径，按节点名在仓库里找对应的代码"}。`,
    "3. 在子画布里（`--canvas <子画布 id>`）画出内部的模块和它们之间的调用；能对应到代码的节点用 `agora canvas link` 关联更细的路径。再往下一层可以是代码逻辑或调用流程。",
    "命令直接写 `agora canvas …`（agora 在 PATH 上）。最后用一两句话说明子图里画了什么。",
  ].join("\n");
};
const updatePrompt = (canvasId: string, title: string, files: string[]) =>
  lang() === "en"
    ? [
        files.length
          ? `Sub-diagram “${title}” (canvas=${canvasId}) may be out of date: these files changed after it was drawn: ${files.slice(0, 12).join(", ")}${files.length > 12 ? " …" : ""}.`
          : `Check sub-diagram “${title}” (canvas=${canvasId}) against the current code: is it still accurate?`,
        `Read \`agora canvas read --canvas ${canvasId}\` and that code, update only what changed (nodes, arrows, code paths), then say what you changed.`,
      ].join("\n")
    : [
    files.length
      ? `子图「${title}」（canvas=${canvasId}）可能过时：它画好之后，这些文件改过：${files.slice(0, 12).join("、")}${files.length > 12 ? " …" : ""}。`
      : `对照现在的代码检查子图「${title}」（canvas=${canvasId}）是否还准确。`,
    `读 \`agora canvas read --canvas ${canvasId}\` 和这些代码，只更新变了的部分（节点、连线、代码路径），然后说明改了什么。`,
  ].join("\n");

/** The label a node's 「子图」 pill shows (node action bar, canvas/NodeBar.tsx). */
export function useChildPill(target: El): { has: boolean; text: string; title: string } {
  const st = useNested();
  const child = childOf(target);
  const has = !!child && st.scenes.has(child);
  return has
    ? { has, text: `${tr("子图", "Sub-diagram")} · ${st.titles[child!] ?? ""}`, title: tr(`这个节点打开子图「${st.titles[child!] ?? child}」`, `This node opens sub-diagram “${st.titles[child!] ?? child}”`) }
    : { has, text: tr("子图", "Sub-diagram"), title: tr("把这个节点展开成一张子画布", "Expand this node into a child canvas") };
}

/** The 「子图」 menu of the selected node: make a blank child, let the agent expand it, enter it, or unlink it. */
export function ChildMenu({ api, view, canvasId, target, onAct }: { api: ExcalidrawImperativeAPI; view: CanvasViewState; canvasId: string; target: El; onAct: (what: string) => void }) {
  const st = useNested();
  const label = labelOf(target, view.map).replace(/\s+/g, " ").trim() || tr("未命名节点", "Untitled node");
  const firstLine = labelOf(target, view.map).split("\n").map((l) => l.trim()).find(Boolean) ?? label;
  const child = childOf(target);
  const has = !!child && st.scenes.has(child);
  const act = (what: string, f: () => Promise<unknown> | unknown) => {
    onAct(what);
    void f();
  };
  return (
    <div className="nest-pop" role="menu">
      {has ? (
        <>
          <button role="menuitem" onClick={() => act("enter", () => nav.fly(canvasId, child!, target.id))}>
            <IconEnter size={14} />{tr("进入子图", "Enter sub-diagram")}<kbd>{ENTER_KEY_LABEL}</kbd>
          </button>
          {st.scenes.get(child!)?.some((e) => live(e)) ? (
            <button role="menuitem" onClick={() => act("ai", () => askAgent(child!, updatePrompt(child!, st.titles[child!] ?? child!, [])))}>
              <IconSparkles size={14} />{tr("让 AI 更新子图", "Ask AI to update sub-diagram")}
            </button>
          ) : (
            <button role="menuitem" onClick={() => act("ai", () => askAgent(canvasId, expandPrompt(canvasId, target, label)))}>
              <IconSparkles size={14} />{tr("让 AI 画子图", "Ask AI to draw sub-diagram")}
              <span className="nest-sub">{tr("子图还是空的：读代码，画出下一层", "The sub-diagram is empty: read the code, draw the next level")}</span>
            </button>
          )}
          <button role="menuitem" onClick={() => act("unlink", () => writeChildLink(api, target.id, null))} title={tr("节点不再打开它；子画布本身留在「所有画布」里", "The node stops opening it; the child canvas stays in “All canvases”")}>
            <IconHint size={14} />{tr("断开（子图保留）", "Unlink (keep sub-diagram)")}
          </button>
        </>
      ) : (
        <>
          <button role="menuitem" onClick={() => act("ai", () => askAgent(canvasId, expandPrompt(canvasId, target, label)))}>
            <IconSparkles size={14} />{tr("让 AI 展开", "Ask AI to expand")}
            <span className="nest-sub">{tr(`读${codePathsOf(target).length ? "关联的" : "对应的"}代码，画出下一层`, `Read the ${codePathsOf(target).length ? "linked" : "matching"} code, draw the next level`)}</span>
          </button>
          <button role="menuitem" onClick={() => act("blank", () => blankChild(canvasId, firstLine.slice(0, 60), (id) => writeChildLink(api, target.id, id)))}>
            <IconNested size={14} />{tr("新建空白子图", "New blank sub-diagram")}
          </button>
        </>
      )}
    </div>
  );
}
