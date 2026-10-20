// Executes `agora canvas read | apply | anim` on this page. The page owns the live scene,
// so the checks that guard every agent edit run here, exactly as for eval planning turns:
// schema + references (validatePlan), library items exist, freshness against the versions
// the agent's read saw, then one undoable batch recorded as a turn of its session.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { animHosts } from "../anim/AnimLayer";
import { validateScript } from "../anim/script";
import { staleIds } from "../canvas/context";
import { toModelView } from "../canvas/modelView";
import { byId, codePathsOf, labelOf, libraryMeta, live, nameOf, versionOf, type Scene } from "../canvas/scene";
import { applyPlan } from "../ops/apply";
import { referencedIds, validatePlan, type Op } from "../ops/ops";
import { cleanGlobs, resolveElement, writeCodePaths } from "../pointer/writeLinks";
import { agents, setBridgeHandler } from "./agents";
import { fetchLibraryItems, sceneIndex, settle } from "./runTurn";
import { sessions, type Origin, type Turn } from "./store";
import { canvases, ui } from "./ui";
import { installAdopt } from "./adoptBound";
import { childOf, wouldCycle } from "../nested/graph";
import { nav, nested } from "../nested/store";
import { writeChildLink } from "../nested/writeChild";
import { touches, touchNodesOf, type TouchEl } from "../workstation/runs/touch";
import { holdReveal } from "../workstation/RevealLayer";
import type { RevealEl } from "../workstation/reveal";
import { tr } from "../i18n";

const all = (api: ExcalidrawImperativeAPI) => api.getSceneElementsIncludingDeleted() as Scene;

export type ApplyResult = { status: "applied" | "invalid" | "stale" | "empty" | "error"; summary?: string[]; errors?: string[]; stale?: string[]; turnId?: string; batchId?: string; note?: string };

/** Which session records this change, and how it is labelled (a comment hand-off in flight or the agent itself). */
function recordFor(sessionId: string | undefined, canvasId: string, title: string): { turnId: string; sid: string } | null {
  const st = sessions.get();
  const sid = sessionId && st.sessions[sessionId] ? sessionId : agents.forCanvas(sessions.onCanvas(canvasId).map((s) => s.id));
  if (!sid || !st.sessions[sid]) return null;
  const f = agents.get().inflight[sid];
  const origin: Origin = f?.threadId ? { kind: "comment", threadId: f.threadId, threadN: f.threadN ?? 0, anchor: f.anchor ?? "" } : { kind: "agent" };
  const turn = sessions.startTurn(sid, { canvasId, origin, request: title, refs: [] });
  agents.noteTurn(sid, turn.id);
  return { turnId: turn.id, sid };
}

/** Tell the 工位视图 the page changed these elements of a canvas for a session, now (`until`: when a change that plays over time is over). */
function announce(sid: string | undefined, canvas: string, ids: Iterable<string>, map: Map<string, Scene[number]>, say: string, until?: number): number | null {
  if (!sid) return null;
  const nodes = touchNodesOf(ids, map as unknown as Map<string, TouchEl>);
  const at = Date.now();
  if (!nodes.length) return null;
  touches.record({ session: sid, canvas, at, until: until ?? at, nodes, say });
  return at;
}

const end = (T: string | undefined, status: Turn["status"], reply: Turn["reply"]) =>
  T && sessions.patchTurn(T, (t) => ({ ...t, status, reply, endedAt: Date.now() }));

export async function readCanvas(canvasId: string) {
  const c = await ui.ensureCanvas(canvasId);
  if (!c) return { error: `canvas ${canvasId} is not in this workspace` };
  const scene = all(c.api);
  const map = byId(scene);
  const versions: Record<string, string> = {};
  for (const e of scene) if (live(e)) versions[e.id] = versionOf(e, map);
  return { canvasId, name: c.title, scene: toModelView(scene), versions };
}

export async function applyFromAgent(req: { canvasId: string; sessionId?: string; plan: { ops: Op[]; note?: string }; versions: Record<string, string> }): Promise<ApplyResult> {
  const c = await ui.ensureCanvas(req.canvasId);
  if (!c) return { status: "error", errors: [`canvas ${req.canvasId} is not in this workspace`] };
  const { api } = c;
  const note = req.plan.note;
  const rec = recordFor(req.sessionId, req.canvasId, note || tr(`改图 · ${req.plan.ops?.length ?? 0} 个操作`, `Edit · ${req.plan.ops?.length ?? 0} op${req.plan.ops?.length === 1 ? "" : "s"}`));
  const T = rec?.turnId;
  const step = (s: Parameters<typeof sessions.step>[1]) => (T ? sessions.step(T, s) : "");
  const endStep = (id: string, p: Parameters<typeof sessions.endStep>[2]) => T && id && sessions.endStep(T, id, p);

  const check = step({ kind: "check", title: tr("校验 + 新鲜度", "Validate + freshness") });
  const library = await fetchLibraryItems(req.plan);
  const now = all(api);
  const { plan, errors } = validatePlan(req.plan, { ...sceneIndex(now), libraryItem: (id) => library.has(id) });
  if (!plan) {
    if (Array.isArray(req.plan.ops) && req.plan.ops.length === 0) {
      endStep(check, { detail: tr("没有操作", "No operations") });
      end(T, "empty", { text: note ? tr(`没有修改：${note}`, `No changes: ${note}`) : tr("没有修改", "No changes") });
      return { status: "empty", note, turnId: T };
    }
    endStep(check, { status: "error", detail: errors.join(tr("；", "; ")) });
    end(T, "invalid", { text: tr(`操作未通过校验，未执行：\n${errors.join("\n")}`, `Operations failed validation and were not applied:\n${errors.join("\n")}`), tone: "error" });
    return { status: "invalid", errors, turnId: T };
  }
  const nowMap = byId(now);
  const watched = [...new Set(referencedIds(plan))];
  const stale = staleIds({ versions: req.versions }, watched, now);
  if (stale.length) {
    const names = stale.map((id) => (nowMap.get(id) ? nameOf(nowMap.get(id)!, nowMap) : id)).join(tr("、", ", "));
    endStep(check, { status: "error", detail: tr(`${names} 在读取后被改动`, `${names} changed after being read`), elements: stale });
    end(T, "stale", { text: tr(`已拒绝执行：${names} 在 Agent 读取画布后被改动过。`, `Refused: ${names} changed after the agent read the canvas.`), tone: "warn" });
    return { status: "stale", stale, errors: [`changed since your read: ${stale.join(", ")} — run \`agora canvas read\` again`], turnId: T };
  }
  endStep(check, { detail: tr(`schema ✓ · 引用 ✓ · ${watched.length} 个元素版本未变 ✓${library.size ? ` · 素材 ${library.size} 个 ✓` : ""}`, `schema ✓ · refs ✓ · ${watched.length} element versions unchanged ✓${library.size ? ` · ${library.size} library items ✓` : ""}`) });

  const apply = step({ kind: "apply", title: tr("应用到画布（1 次可撤销修改）", "Apply to canvas (1 undoable change)") });
  const result = applyPlan(now, plan, library);
  // the 工位视图 is told before the picture changes: the figure goes to the nodes this drew (./workstation/runs/touch.ts), and what the batch adds
  // appears on the page as it gets to each of them (../workstation/RevealLayer.tsx; the scene, undo and the saved file have it all at once)
  const afterMap = byId(result.scene as Scene);
  const at = announce(rec?.sid, req.canvasId, result.batch.after.keys(), afterMap, note?.slice(0, 24) || tr("改图", "Editing"));
  if (at != null) holdReveal(req.canvasId, at, [...result.batch.after.keys()].filter((id) => live(afterMap.get(id)) && !live(nowMap.get(id))), afterMap as unknown as Map<string, RevealEl>);
  api.updateScene({ elements: result.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  await settle();
  const settled = byId(all(api));
  for (const id of result.batch.after.keys()) result.batch.after.set(id, settled.get(id)!.version);
  const batchId = sessions.saveBatch(result.batch);
  const libGroups = new Set([...settled.values()].map((e) => libraryMeta(e)?.group).filter(Boolean));
  const touched = [...result.batch.after.keys()].filter((id) => {
    const e = settled.get(id);
    return live(e) && e.type !== "text" && (libraryMeta(e) || !e.groupIds.some((g) => libGroups.has(g)));
  });
  endStep(apply, { detail: tr(`${result.summary.length} 处修改 · ${touched.length} 个元素`, `${result.summary.length} change${result.summary.length === 1 ? "" : "s"} · ${touched.length} element${touched.length === 1 ? "" : "s"}`), elements: touched });
  end(T, "applied", { text: tr(`已修改 ${result.summary.length} 处${note ? `：${note}` : ""}`, `Made ${result.summary.length} change${result.summary.length === 1 ? "" : "s"}${note ? `: ${note}` : ""}`), changes: result.summary, batchId });
  return { status: "applied", summary: result.summary, turnId: T, batchId, note };
}

export async function animFromAgent(req: { canvasId: string; sessionId?: string; script: unknown }) {
  const c = await ui.ensureCanvas(req.canvasId);
  if (!c) return { status: "error", errors: [`canvas ${req.canvasId} is not in this workspace`] };
  const v = validateScript(req.script);
  const title = (req.script as { title?: string })?.title ?? tr("动画", "Animation");
  const rec = recordFor(req.sessionId, req.canvasId, tr(`动画「${title}」`, `Animation “${title}”`));
  const T = rec?.turnId;
  const check = T ? sessions.step(T, { kind: "check", title: tr("校验动画脚本", "Validate animation script") }) : "";
  if (!v.script) {
    if (T) sessions.endStep(T, check, { status: "error", detail: v.errors.slice(0, 3).join(tr("；", "; ")) });
    end(T, "invalid", { text: tr(`动画脚本没通过校验，未上画布：\n${v.errors.slice(0, 6).join("\n")}`, `The animation script failed validation and wasn't added to the canvas:\n${v.errors.slice(0, 6).join("\n")}`), tone: "error" });
    return { status: "invalid", errors: v.errors, turnId: T };
  }
  const script = v.script;
  if (T) sessions.endStep(T, check, { detail: tr(`${script.nodes.length} 个节点 · ${script.edges?.length ?? 0} 条边 · ${script.steps.length} 步 · 结构与引用 ✓`, `${script.nodes.length} nodes · ${script.edges?.length ?? 0} edges · ${script.steps.length} steps · structure and refs ✓`) });
  const host = animHosts.get(c.api);
  if (!host) {
    end(T, "error", { text: tr("画布的动画播放器还没准备好", "The canvas's animation player isn't ready yet"), tone: "error" });
    return { status: "error", errors: ["animation host not ready"], turnId: T };
  }
  const mount = T ? sessions.step(T, { kind: "apply", title: tr("挂载播放器", "Mount player") }) : "";
  const before = new Set(c.api.getSceneElementsIncludingDeleted().map((e) => e.id));
  host(script);
  const added = c.api.getSceneElements().filter((e) => !before.has(e.id));
  const region = added.filter((e) => e.type !== "text").map((e) => e.id);
  announce(rec?.sid, req.canvasId, region, byId(c.api.getSceneElements() as Scene), tr(`动画「${title}」`, `Animation “${title}”`).slice(0, 24));
  if (added.length) c.api.scrollToContent(added, { fitToContent: true, animate: true });
  if (T) sessions.endStep(T, mount, { detail: tr(`区域「${script.title}」· ${script.nodes.length} 个元素 · ${script.steps.length} 步 · 播放器在区域下方`, `Region “${script.title}” · ${script.nodes.length} elements · ${script.steps.length} steps · player below the region`), elements: region });
  end(T, "applied", { text: tr(`已生成动画「${script.title}」：${script.nodes.length} 个元素、${script.steps.length} 步，用区域下方的播放器播放。`, `Created animation “${script.title}”: ${script.nodes.length} elements, ${script.steps.length} steps; play it with the player below the region.`), changes: [tr(`新建动画区域「${script.title}」`, `New animation region “${script.title}”`)] });
  return { status: "mounted", title: script.title, nodes: script.nodes.length, steps: script.steps.length, turnId: T };
}

/** `agora canvas link`: associate elements with code paths (progress pointer), one undoable change. */
export async function linkFromAgent(req: { canvasId: string; sessionId?: string; links: Record<string, string[]>; clear?: boolean }) {
  const c = await ui.ensureCanvas(req.canvasId);
  if (!c) return { status: "error", errors: [`canvas ${req.canvasId} is not in this workspace`] };
  const scene = all(c.api);
  const map = byId(scene);
  const errors: string[] = [];
  const updates = new Map<string, string[]>();
  for (const [ref, globs] of Object.entries(req.links ?? {})) {
    const r = resolveElement(ref, scene);
    if (!r.id) {
      errors.push(r.error!);
      continue;
    }
    const prev = updates.get(r.id) ?? (req.clear ? [] : codePathsOf(map.get(r.id)));
    updates.set(r.id, cleanGlobs([...prev, ...globs]));
  }
  if (errors.length) return { status: "invalid", errors };
  const linked = [...updates].map(([id, codePaths]) => ({ id, label: nameOf(map.get(id)!, map), codePaths }));
  const batch = writeCodePaths(c.api, updates);
  if (!batch) return { status: "linked", linked, unchanged: true };
  const title = tr(`关联代码路径：${linked.map((l) => `${l.label} → ${l.codePaths.join(" ") || "（清除）"}`).join("；")}`, `Link code paths: ${linked.map((l) => `${l.label} → ${l.codePaths.join(" ") || "(cleared)"}`).join("; ")}`);
  const rec = recordFor(req.sessionId, req.canvasId, title.length > 120 ? tr(`关联代码路径 · ${linked.length} 个元素`, `Link code paths · ${linked.length} elements`) : title);
  const batchId = sessions.saveBatch(batch);
  end(rec?.turnId, "applied", { text: tr(`已关联 ${linked.length} 个元素的代码路径`, `Linked code paths for ${linked.length} element${linked.length === 1 ? "" : "s"}`), changes: linked.map((l) => tr(`${l.label}：${l.codePaths.join("、") || "已清除"}`, `${l.label}: ${l.codePaths.join(", ") || "cleared"}`)), batchId });
  if (rec) sessions.step(rec.turnId, { kind: "apply", title: tr("写进元素的 customData.codePaths", "Written to the elements' customData.codePaths"), elements: linked.map((l) => l.id), status: "done" });
  return { status: "linked", linked, turnId: rec?.turnId };
}

/**
 * `agora canvas child create | link | unlink`: the canvas a node opens into (nested canvases,
 * docs/nested-canvas.md). `create` makes a blank canvas (no tab) named after the node, or hands
 * back the child the node already has; the link is one undoable change recorded in the session.
 */
export async function childFromAgent(req: { op: "create" | "link" | "unlink"; canvasId: string; sessionId?: string; node: string; child?: string; title?: string }) {
  const c = await ui.ensureCanvas(req.canvasId);
  if (!c) return { status: "error", errors: [`canvas ${req.canvasId} is not in this workspace`] };
  const scene = all(c.api);
  const map = byId(scene);
  const r = resolveElement(req.node, scene);
  if (!r.id) return { status: "invalid", errors: [r.error!] };
  const el = map.get(r.id)!;
  const label = nameOf(el, map);
  const st = nested.get();
  const current = childOf(el);
  const name = (id: string) => nested.get().titles[id] ?? id;
  if (req.op === "create" && current && st.scenes.has(current))
    return { status: "exists", canvas: { id: current, name: name(current) }, node: { id: el.id, label }, hint: "this node already opens that canvas: draw into it with --canvas" };
  let child: string | null = null;
  if (req.op === "create") {
    // Named after the node's first label line ("订单服务 · OrderService"), not its whole description.
    const first = (labelOf(el, map).split("\n").map((l) => l.trim()).find(Boolean) ?? label).slice(0, 60);
    child = (await nav.createChild(req.title || first)) ?? null;
    if (!child) return { status: "error", errors: ["could not create the canvas"] };
  } else if (req.op === "link") {
    child = req.child ?? null;
    if (!child || !st.scenes.has(child)) return { status: "invalid", errors: [`no canvas ${req.child}`] };
    if (wouldCycle(req.canvasId, child, st.scenes)) return { status: "invalid", errors: [`linking ${child} under ${req.canvasId} would make a loop`] };
  }
  const batch = writeChildLink(c.api, el.id, child);
  const title =
    req.op === "create" ? tr(`展开「${label}」为子图「${name(child!)}」`, `Expand “${label}” into sub-diagram “${name(child!)}”`) : req.op === "link" ? tr(`「${label}」打开子图「${name(child!)}」`, `“${label}” opens sub-diagram “${name(child!)}”`) : tr(`断开「${label}」的子图（子图保留）`, `Unlink “${label}”'s sub-diagram (the sub-diagram is kept)`);
  const rec = batch ? recordFor(req.sessionId, req.canvasId, title) : null;
  if (rec && batch) announce(rec.sid, req.canvasId, [el.id], byId(all(c.api)), req.op === "unlink" ? tr("改图", "Editing") : tr("展开成子图", "Expanding into sub-diagram"));
  if (rec && batch) {
    const batchId = sessions.saveBatch(batch);
    end(rec.turnId, "applied", { text: title, changes: [title], batchId });
    sessions.step(rec.turnId, { kind: "apply", title: tr("写进节点的 customData.childCanvas", "Written to the node's customData.childCanvas"), elements: [el.id], status: "done" });
  }
  const status = req.op === "create" ? "created" : req.op === "link" ? "linked" : "unlinked";
  return { status, node: { id: el.id, label }, ...(child ? { canvas: { id: child, name: name(child) } } : { previous: current }), turnId: rec?.turnId };
}

/** Route bridge requests from the server to the executors above. */
export function installBridge() {
  // sessions imported from outside (a binding with no session of the page's own) get one: session/adoptBound.ts
  installAdopt(() => [...canvases.keys()][0] ?? [...nested.get().scenes.keys()].find((id) => !nested.get().index.has(id)) ?? null, (l) => nested.subscribe(l));
  setBridgeHandler(async (req) => {
    // the canvas is the call's for as long as it takes (an edit may wait a minute for an asset): the page does not close it meanwhile
    const release = typeof req.canvasId === "string" ? ui.holdCanvas(req.canvasId) : () => {};
    try {
      return await handle(req);
    } finally {
      release();
    }
  });
}

async function handle(req: Parameters<Parameters<typeof setBridgeHandler>[0]>[0]) {
  if (req.kind === "read") return readCanvas(req.canvasId as string);
  if (req.kind === "apply") return applyFromAgent(req as unknown as Parameters<typeof applyFromAgent>[0]);
  if (req.kind === "anim") return animFromAgent(req as unknown as Parameters<typeof animFromAgent>[0]);
  if (req.kind === "link") return linkFromAgent(req as unknown as Parameters<typeof linkFromAgent>[0]);
  if (req.kind === "child") return childFromAgent(req as unknown as Parameters<typeof childFromAgent>[0]);
  return { status: "error", errors: [`unknown bridge request ${req.kind}`] };
}

