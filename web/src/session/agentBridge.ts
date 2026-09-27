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
import { byId, libraryMeta, live, nameOf, versionOf, type Scene } from "../canvas/scene";
import { applyPlan } from "../ops/apply";
import { referencedIds, validatePlan, type Op } from "../ops/ops";
import { agents, setBridgeHandler } from "./agents";
import { fetchLibraryItems, sceneIndex, settle } from "./runTurn";
import { sessions, type Origin, type Turn } from "./store";
import { ui } from "./ui";

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

/** Route bridge requests from the server to the executors above. */
export function installBridge() {
  setBridgeHandler(async (req) => {
    if (req.kind === "read") return readCanvas(req.canvasId as string);
    if (req.kind === "apply") return applyFromAgent(req as unknown as Parameters<typeof applyFromAgent>[0]);
    if (req.kind === "anim") return animFromAgent(req as unknown as Parameters<typeof animFromAgent>[0]);
    return { status: "error", errors: [`unknown bridge request ${req.kind}`] };
  });
}

