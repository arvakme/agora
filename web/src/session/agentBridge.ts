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
import { byId, codePathsOf, libraryMeta, live, nameOf, versionOf, type Scene } from "../canvas/scene";
import { applyPlan } from "../ops/apply";
import { referencedIds, validatePlan, type Op } from "../ops/ops";
import { cleanGlobs, resolveElement, writeCodePaths } from "../pointer/writeLinks";
import { agents, setBridgeHandler } from "./agents";
import { fetchLibraryItems, sceneIndex, settle } from "./runTurn";
import { sessions, type Origin, type Turn } from "./store";
import { ui } from "./ui";
import { childOf, wouldCycle } from "../nested/graph";
import { nav, nested } from "../nested/store";
import { writeChildLink } from "../nested/writeChild";

const all = (api: ExcalidrawImperativeAPI) => api.getSceneElementsIncludingDeleted() as Scene;

export type ApplyResult = { status: "applied" | "invalid" | "stale" | "empty" | "error"; summary?: string[]; errors?: string[]; stale?: string[]; turnId?: string; batchId?: string; note?: string };

/** Which session records this change, and how it is labelled (a comment hand-off in flight or the agent itself). */
function recordFor(sessionId: string | undefined, canvasId: string, title: string): { turnId: string } | null {
  const st = sessions.get();
  const sid = sessionId && st.sessions[sessionId] ? sessionId : agents.forCanvas(sessions.onCanvas(canvasId).map((s) => s.id));
  if (!sid || !st.sessions[sid]) return null;
  const f = agents.get().inflight[sid];
  const origin: Origin = f?.threadId ? { kind: "comment", threadId: f.threadId, threadN: f.threadN ?? 0, anchor: f.anchor ?? "" } : { kind: "agent" };
  const turn = sessions.startTurn(sid, { canvasId, origin, request: title, refs: [] });
  agents.noteTurn(sid, turn.id);
  return { turnId: turn.id };
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
  const rec = recordFor(req.sessionId, req.canvasId, note || `改图 · ${req.plan.ops?.length ?? 0} 个操作`);
  const T = rec?.turnId;
  const step = (s: Parameters<typeof sessions.step>[1]) => (T ? sessions.step(T, s) : "");
  const endStep = (id: string, p: Parameters<typeof sessions.endStep>[2]) => T && id && sessions.endStep(T, id, p);

  const check = step({ kind: "check", title: "校验 + 新鲜度" });
  const library = await fetchLibraryItems(req.plan);
  const now = all(api);
  const { plan, errors } = validatePlan(req.plan, { ...sceneIndex(now), libraryItem: (id) => library.has(id) });
  if (!plan) {
    if (Array.isArray(req.plan.ops) && req.plan.ops.length === 0) {
      endStep(check, { detail: "没有操作" });
      end(T, "empty", { text: note ? `没有修改：${note}` : "没有修改" });
      return { status: "empty", note, turnId: T };
    }
    endStep(check, { status: "error", detail: errors.join("；") });
    end(T, "invalid", { text: `操作未通过校验，未执行：\n${errors.join("\n")}`, tone: "error" });
    return { status: "invalid", errors, turnId: T };
  }
  const nowMap = byId(now);
  const watched = [...new Set(referencedIds(plan))];
  const stale = staleIds({ versions: req.versions }, watched, now);
  if (stale.length) {
    const names = stale.map((id) => (nowMap.get(id) ? nameOf(nowMap.get(id)!, nowMap) : id)).join("、");
    endStep(check, { status: "error", detail: `${names} 在读取后被改动`, elements: stale });
    end(T, "stale", { text: `已拒绝执行：${names} 在 Agent 读取画布后被改动过。`, tone: "warn" });
    return { status: "stale", stale, errors: [`changed since your read: ${stale.join(", ")} — run \`agora canvas read\` again`], turnId: T };
  }
  endStep(check, { detail: `schema ✓ · 引用 ✓ · ${watched.length} 个元素版本未变 ✓${library.size ? ` · 素材 ${library.size} 个 ✓` : ""}` });

  const apply = step({ kind: "apply", title: "应用到画布（1 次可撤销修改）" });
  const result = applyPlan(now, plan, library);
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
  endStep(apply, { detail: `${result.summary.length} 处修改 · ${touched.length} 个元素`, elements: touched });
  end(T, "applied", { text: `已修改 ${result.summary.length} 处${note ? `：${note}` : ""}`, changes: result.summary, batchId });
  return { status: "applied", summary: result.summary, turnId: T, batchId, note };
}

export async function animFromAgent(req: { canvasId: string; sessionId?: string; script: unknown }) {
  const c = await ui.ensureCanvas(req.canvasId);
  if (!c) return { status: "error", errors: [`canvas ${req.canvasId} is not in this workspace`] };
  const v = validateScript(req.script);
  const title = (req.script as { title?: string })?.title ?? "动画";
  const rec = recordFor(req.sessionId, req.canvasId, `动画「${title}」`);
  const T = rec?.turnId;
  const check = T ? sessions.step(T, { kind: "check", title: "校验动画脚本" }) : "";
  if (!v.script) {
    if (T) sessions.endStep(T, check, { status: "error", detail: v.errors.slice(0, 3).join("；") });
    end(T, "invalid", { text: `动画脚本没通过校验，未上画布：\n${v.errors.slice(0, 6).join("\n")}`, tone: "error" });
    return { status: "invalid", errors: v.errors, turnId: T };
  }
  const script = v.script;
  if (T) sessions.endStep(T, check, { detail: `${script.nodes.length} 个节点 · ${script.edges?.length ?? 0} 条边 · ${script.steps.length} 步 · 结构与引用 ✓` });
  const host = animHosts.get(c.api);
  if (!host) {
    end(T, "error", { text: "画布的动画播放器还没准备好", tone: "error" });
    return { status: "error", errors: ["animation host not ready"], turnId: T };
  }
  const mount = T ? sessions.step(T, { kind: "apply", title: "挂载播放器" }) : "";
  const before = new Set(c.api.getSceneElementsIncludingDeleted().map((e) => e.id));
  host(script);
  const added = c.api.getSceneElements().filter((e) => !before.has(e.id));
  const region = added.filter((e) => e.type !== "text").map((e) => e.id);
  if (added.length) c.api.scrollToContent(added, { fitToContent: true, animate: true });
  if (T) sessions.endStep(T, mount, { detail: `区域「${script.title}」· ${script.nodes.length} 个元素 · ${script.steps.length} 步 · 播放器在区域下方`, elements: region });
  end(T, "applied", { text: `已生成动画「${script.title}」：${script.nodes.length} 个元素、${script.steps.length} 步，用区域下方的播放器播放。`, changes: [`新建动画区域「${script.title}」`] });
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
  const title = `关联代码路径：${linked.map((l) => `${l.label} → ${l.codePaths.join(" ") || "（清除）"}`).join("；")}`;
  const rec = recordFor(req.sessionId, req.canvasId, title.length > 120 ? `关联代码路径 · ${linked.length} 个元素` : title);
  const batchId = sessions.saveBatch(batch);
  end(rec?.turnId, "applied", { text: `已关联 ${linked.length} 个元素的代码路径`, changes: linked.map((l) => `${l.label}：${l.codePaths.join("、") || "已清除"}`), batchId });
  if (rec) sessions.step(rec.turnId, { kind: "apply", title: "写进元素的 customData.codePaths", elements: linked.map((l) => l.id), status: "done" });
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
    child = (await nav.createChild(req.title || label)) ?? null;
    if (!child) return { status: "error", errors: ["could not create the canvas"] };
  } else if (req.op === "link") {
    child = req.child ?? null;
    if (!child || !st.scenes.has(child)) return { status: "invalid", errors: [`no canvas ${req.child}`] };
    if (wouldCycle(req.canvasId, child, st.scenes)) return { status: "invalid", errors: [`linking ${child} under ${req.canvasId} would make a loop`] };
  }
  const batch = writeChildLink(c.api, el.id, child);
  const title =
    req.op === "create" ? `展开「${label}」为子图「${name(child!)}」` : req.op === "link" ? `「${label}」打开子图「${name(child!)}」` : `断开「${label}」的子图（子图保留）`;
  const rec = batch ? recordFor(req.sessionId, req.canvasId, title) : null;
  if (rec && batch) {
    const batchId = sessions.saveBatch(batch);
    end(rec.turnId, "applied", { text: title, changes: [title], batchId });
    sessions.step(rec.turnId, { kind: "apply", title: "写进节点的 customData.childCanvas", elements: [el.id], status: "done" });
  }
  const status = req.op === "create" ? "created" : req.op === "link" ? "linked" : "unlinked";
  return { status, node: { id: el.id, label }, ...(child ? { canvas: { id: child, name: name(child) } } : { previous: current }), turnId: rec?.turnId };
}

/** Route bridge requests from the server to the executors above. */
export function installBridge() {
  setBridgeHandler(async (req) => {
    if (req.kind === "read") return readCanvas(req.canvasId as string);
    if (req.kind === "apply") return applyFromAgent(req as unknown as Parameters<typeof applyFromAgent>[0]);
    if (req.kind === "anim") return animFromAgent(req as unknown as Parameters<typeof animFromAgent>[0]);
    if (req.kind === "link") return linkFromAgent(req as unknown as Parameters<typeof linkFromAgent>[0]);
    if (req.kind === "child") return childFromAgent(req as unknown as Parameters<typeof childFromAgent>[0]);
    return { status: "error", errors: [`unknown bridge request ${req.kind}`] };
  });
}

