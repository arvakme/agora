// One agent turn, recorded step by step from real events:
//   read (freeze context) → think / search_library / plan (streamed from the model)
//   → check (schema, references, freshness) → apply (one undoable batch) → reply.
// Both the session composer and canvas comments ("交给 Agent") run through here.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { applyPlan, undoBatch } from "../ops/apply";
import { freeze, staleIds, type FrozenContext, type Request } from "../canvas/context";
import type { LibraryItem } from "../library/libraryInsert";
import { referencedIds, validatePlan, type Op } from "../ops/ops";
import { byId, isArrow, isShape, libraryMeta, live, nameOf, type Scene } from "../canvas/scene";
import { sessions, type Origin, type Turn, type Usage } from "./store";
import { ENTITY_ASSETS, pickEngine, type EnginePick } from "../anim/enginePick";
import { animHosts } from "../anim/AnimLayer";
import { validateScript, type AnimScript } from "../anim/script";

export type AgentOutcome = {
  ctx: FrozenContext;
  ops: Op[] | null;
  note?: string;
  status: "applied" | "invalid" | "stale" | "error" | "empty";
  errors: string[];
  stale: string[];
  summary: string[];
  costUsd: number | null;
  durationMs: number;
  batchId?: string;
  turnId: string;
  /** Exact prompt the backend sent to the model (from the result event), for eval forensics. */
  prompt?: string;
  /** Token/cost/time accounting reported by the execution backend. */
  usage?: Usage;
};

const all = (api: ExcalidrawImperativeAPI) => api.getSceneElementsIncludingDeleted() as Scene;
/**
 * Two animation frames — long enough for Excalidraw to re-measure bound text after
 * updateScene. rAF is paused in a hidden tab, so a 1s timer caps the wait there instead
 * of holding the turn open until the person comes back.
 */
const settle = (capMs = 1000) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, capMs);
    requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), r())));
  });
const WORKERS: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export const sceneIndex = (scene: Scene) => {
  const map = byId(scene);
  return {
    kind(id: string) {
      const e = map.get(id);
      if (!e || e.isDeleted) return undefined;
      if (libraryMeta(e)) return "library";
      return isShape(e) ? "shape" : isArrow(e) ? "arrow" : e.type === "frame" ? "frame" : undefined;
    },
  } as const;
};

const opTarget = (o: Op): string =>
  o.op === "add_shape" ? o.text : o.op === "add_arrow" ? `${o.from} → ${o.to}` : o.op === "insert_library_item" ? o.label ?? o.ref : o.id;

export async function runTurn(input: {
  api: ExcalidrawImperativeAPI;
  sessionId: string;
  canvasId: string;
  request: Request;
  origin: Origin;
  text: string;
  refs?: Turn["refs"];
  mentions?: string[];
}): Promise<AgentOutcome> {
  const { api } = input;
  const turn = sessions.startTurn(input.sessionId, { canvasId: input.canvasId, origin: input.origin, request: input.text, refs: input.refs ?? [], mentions: input.mentions ?? [] });
  const T = turn.id;
  const end = (status: Turn["status"], reply: Turn["reply"]) => sessions.patchTurn(T, (t) => ({ ...t, status, reply, endedAt: Date.now() }));

  // 1. Read: freeze the canvas the agent will see.
  const read = sessions.step(T, { kind: "read", title: "读取画布" });
  const ctx = freeze(all(api), input.request, Object.keys(api.getAppState().selectedElementIds));
  const chars = JSON.stringify(ctx.scene).length;
  sessions.endStep(T, read, {
    detail: `冻结上下文 · ${ctx.scene.nodes.length} 个节点 / ${ctx.scene.arrows.length} 根箭头 · ${chars.toLocaleString()} 字符${ctx.selection.length ? ` · 选区 ${ctx.selection.length}` : ""}`,
    elements: [...ctx.anchors.map((a) => a.id), ...ctx.selection],
  });
  const base = { ctx, ops: null, errors: [], stale: [], summary: [], costUsd: null, durationMs: 0, turnId: T };

  const pick = await engineStep(T, input.text);
  if (pick.kind === "animation" && animHosts.has(api)) return runAnimation(api, T, input.text, base);

  // @worker mentions: data + UI only this round; real dispatch will go through the local host.
  for (const m of input.mentions ?? [])
    if (WORKERS[m]) sessions.step(T, { kind: "dispatch", title: `派发给 ${WORKERS[m]}`, detail: "未接入：真实派发将由 Pi Master 经本机宿主交给 worker；本轮由 Pi Master 直接处理", status: "skipped", endedAt: Date.now() });

  // 2. Plan: stream the model's steps.
  type Res = { raw: unknown; costUsd: number | null; durationMs: number; error?: string; prompt?: string; usage?: Usage };
  let res: Res | null = null;
  let open: string | null = null;
  const tools = new Map<string, string>();
  const close = (at: number, p = {}) => open && (sessions.endStep(T, open, { endedAt: at, ...p }), (open = null));
  const think = (at: number) => (open = sessions.step(T, { kind: "think", title: "思考", startedAt: at }));
  try {
    // Server-sent events: one `data: <json>` frame per PlanEvent from POST /api/canvas/turns.
    const r = await fetch("/api/canvas/turns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ctx) });
    if (!r.ok || !r.body) throw new Error(`${r.status} ${r.statusText}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const e = JSON.parse(data);
        if (e.t === "start") think(e.at);
        else if (e.t === "text" && open) {
          const cur = sessions.get().turns[T].steps.find((s) => s.id === open);
          sessions.patchStep(T, open, { detail: `${cur?.detail ? cur.detail + " " : ""}${e.text}`.slice(0, 280) });
        } else if (e.t === "tool_use") {
          close(e.at);
          const q = (e.input as { query?: string })?.query ?? "";
          const name = String(e.name).replace(/^mcp__\w+__/, "");
          const id = sessions.step(T, { kind: "tool", title: `${name}("${q}")`, startedAt: e.at });
          tools.set(e.id, id);
        } else if (e.t === "tool_result") {
          const id = tools.get(e.id);
          let candidates: { id: string; name: string; library: string }[] = [];
          try {
            candidates = (JSON.parse(e.text) as { id: string; name: string; library: string }[]).map(({ id, name, library }) => ({ id, name, library }));
          } catch {
            /* "no match" text */
          }
          if (id) sessions.endStep(T, id, { endedAt: e.at, candidates: candidates.slice(0, 5), detail: candidates.length ? `${candidates.length} 个候选` : e.text.slice(0, 120) });
          think(e.at);
        } else if (e.t === "output") {
          close(e.at);
          open = sessions.step(T, { kind: "plan", title: "生成操作", startedAt: e.at });
        } else if (e.t === "result") {
          res = e;
          if (e.usage) sessions.patchTurn(T, (t) => ({ ...t, usage: [...(t.usage ?? []), e.usage as Usage] }));
          const ops = ((e.raw as { ops?: Op[] })?.ops ?? []) as Op[];
          close(e.at, e.error ? { status: "error", detail: e.error } : { title: `生成 ${ops.length} 个操作`, ops: ops.map((o) => ({ op: o.op, target: opTarget(o) })) });
        }
      }
    }
  } catch (e) {
    close(Date.now(), { status: "error" });
  }
  const done = res as Res | null;
  if (!done || done.error) {
    const msg = done?.error ?? "调用模型失败";
    sessions.step(T, { kind: "error", title: "模型没有返回可用结果", detail: msg, status: "error", endedAt: Date.now() });
    sessions.patchTurn(T, (t) => ({ ...t, costUsd: done?.costUsd ?? null }));
    end("error", { text: `模型没有返回可用结果：${msg}`, tone: "error" });
    return { ...base, status: "error", errors: [msg], costUsd: done?.costUsd ?? null, durationMs: done?.durationMs ?? 0 };
  }
  sessions.patchTurn(T, (t) => ({ ...t, costUsd: done.costUsd }));
  const withCost = { ...base, costUsd: done.costUsd, durationMs: done.durationMs, prompt: done.prompt, usage: done.usage };

  // 3. Check: library items exist, schema + references, freshness.
  const check = sessions.step(T, { kind: "check", title: "校验 + 新鲜度" });
  const library = await fetchLibraryItems(done.raw);
  const now = all(api);
  const { plan, errors } = validatePlan(done.raw, { ...sceneIndex(now), libraryItem: (id) => library.has(id) });
  const ops = ((done.raw as { ops?: Op[] })?.ops ?? null) as Op[] | null;
  const note = (done.raw as { note?: string })?.note;
  if (!plan) {
    if (ops?.length === 0 && note) {
      sessions.endStep(T, check, { detail: "没有操作" });
      end("empty", { text: `没有修改：${note}` });
      return { ...withCost, ops, note, status: "empty" };
    }
    sessions.endStep(T, check, { status: "error", detail: errors.join("；") });
    end("invalid", { text: `操作未通过校验，未执行：\n${errors.join("\n")}`, tone: "error" });
    return { ...withCost, ops, note, status: "invalid", errors };
  }
  const nowMap = byId(now);
  const watched = [...new Set([...referencedIds(plan), ...ctx.anchors.map((a) => a.id), ...ctx.selection])];
  const stale = staleIds(ctx, watched, now);
  if (stale.length) {
    const names = stale.map((id) => (nowMap.get(id) ? nameOf(nowMap.get(id)!, nowMap) : id)).join("、");
    sessions.endStep(T, check, { status: "error", detail: `${names} 在提交后被改动`, elements: stale });
    end("stale", { text: `已拒绝执行：${names} 在提交后被改动过，计划基于旧版本。请重新交给 Agent。`, tone: "warn" });
    return { ...withCost, ops, note, status: "stale", stale };
  }
  sessions.endStep(T, check, { detail: `schema ✓ · 引用 ✓ · ${watched.length} 个元素版本未变 ✓${library.size ? ` · 素材 ${library.size} 个 ✓` : ""}` });

  // 4. Apply as one undoable batch.
  const apply = sessions.step(T, { kind: "apply", title: "应用到画布（1 次可撤销修改）" });
  const result = applyPlan(now, plan, library);
  api.updateScene({ elements: result.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  // Excalidraw re-measures bound text right after updateScene and bumps versions again;
  // the undo baseline is the settled scene, not what we handed in.
  await settle();
  const settled = byId(all(api));
  for (const id of result.batch.after.keys()) result.batch.after.set(id, settled.get(id)!.version);
  const batchId = sessions.saveBatch(result.batch);
  // Highlight what a person would call "the thing that changed": library components by their root.
  const libGroups = new Set([...settled.values()].map((e) => libraryMeta(e)?.group).filter(Boolean));
  const touched = [...result.batch.after.keys()].filter((id) => {
    const e = settled.get(id);
    return live(e) && e.type !== "text" && (libraryMeta(e) || !e.groupIds.some((g) => libGroups.has(g)));
  });
  sessions.endStep(T, apply, { detail: `${result.summary.length} 处修改 · ${touched.length} 个元素`, elements: touched });
  end("applied", { text: `已按${input.origin.kind === "comment" ? "评论" : "要求"}修改 ${result.summary.length} 处${note ? `：${note}` : ""}`, changes: result.summary, batchId });
  return { ...withCost, ops, note, status: "applied", summary: result.summary, batchId };
}

/** Undo exactly the batch of a turn; refuses when anything it touched changed since. */
export function undoTurn(api: ExcalidrawImperativeAPI, turnId: string): { ok: boolean; stale: string[] } {
  const turn = sessions.get().turns[turnId];
  const batch = turn?.reply?.batchId ? sessions.batch(turn.reply.batchId) : undefined;
  if (!turn || !batch || turn.reply?.undone) return { ok: false, stale: [] };
  const now = all(api);
  const r = undoBatch(now, batch);
  if (!r.scene) {
    const map = byId(now);
    const undoError = `无法撤销：${r.stale.map((id) => (map.get(id) ? nameOf(map.get(id)!, map) : id)).join("、")} 在 Agent 修改后又被改动过。`;
    sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undoError } }));
    return { ok: false, stale: r.stale };
  }
  api.updateScene({ elements: r.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undone: true, undoError: undefined } }));
  return { ok: true, stale: [] };
}

async function fetchLibraryItems(raw: unknown): Promise<Map<string, LibraryItem>> {
  const ops = ((raw as { ops?: { op?: string; item?: unknown }[] })?.ops ?? []).filter((o) => o?.op === "insert_library_item" && typeof o.item === "string");
  const ids = [...new Set(ops.map((o) => o.item as string))];
  const found = await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`/api/canvas/library/item?id=${encodeURIComponent(id)}`);
      return r.ok ? ((await r.json()) as LibraryItem) : null;
    }),
  );
  return new Map(found.filter((x): x is LibraryItem => !!x).map((x) => [x.id, x]));
}

/**
 * Rule lookup before planning (no model call). Excalidraw is the only engine, so the
 * session shows this step only when the request raises the asset-library question.
 */
async function engineStep(T: string, request: string): Promise<EnginePick> {
  if (!ENTITY_ASSETS.test(request)) return pickEngine({ request, libraryHits: 0 });
  const id = sessions.step(T, { kind: "engine", title: "素材库" });
  const r = await fetch(`/api/canvas/library/search?q=${encodeURIComponent(request)}&limit=3`).catch(() => null);
  const libraryHits = r?.ok ? (((await r.json()) as { items?: unknown[] }).items ?? []).length : 0;
  const pick = pickEngine({ request, libraryHits });
  sessions.endStep(T, id, { title: pick.useAssets ? "素材库：可用" : "素材库：不用", detail: pick.reason });
  return pick;
}

/** Animation turn: generate a script (one repair retry), validate it, mount the player. */
async function runAnimation(api: ExcalidrawImperativeAPI, T: string, request: string, base: Omit<AgentOutcome, "status">): Promise<AgentOutcome> {
  let errors: string[] = [], cost = 0, ms = 0, script: AnimScript | undefined;
  const end = (status: Turn["status"], reply: Turn["reply"]) => sessions.patchTurn(T, (t) => ({ ...t, status, reply, costUsd: cost, endedAt: Date.now() }));
  for (let attempt = 1; attempt <= 2 && !script; attempt++) {
    const gen = sessions.step(T, { kind: "think", title: attempt === 1 ? "生成动画脚本" : "按校验意见修正脚本" });
    const r = await fetch("/api/canvas/anim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, errors }) });
    const res = (await r.json()) as { raw: unknown; costUsd: number | null; durationMs: number; error?: string; usage?: Usage };
    cost += res.costUsd ?? 0;
    ms += res.durationMs ?? 0;
    sessions.patchTurn(T, (t) => ({ ...t, costUsd: cost }));
    if (!r.ok || res.error) {
      sessions.endStep(T, gen, { status: "error", detail: res.error ?? r.statusText });
      end("error", { text: `模型没有返回可用脚本：${res.error ?? r.statusText}`, tone: "error" });
      return { ...base, status: "error", errors: [res.error ?? ""], costUsd: cost, durationMs: ms };
    }
    if (res.usage) sessions.patchTurn(T, (t) => ({ ...t, usage: [...(t.usage ?? []), res.usage!] }));
    sessions.endStep(T, gen, { detail: `${((res.durationMs ?? 0) / 1000).toFixed(1)}s · $${(res.costUsd ?? 0).toFixed(4)}` });
    const check = sessions.step(T, { kind: "check", title: "校验动画脚本" });
    const v = validateScript(res.raw);
    if (v.script) {
      script = v.script;
      sessions.endStep(T, check, { detail: `${v.script.nodes.length} 个节点 · ${v.script.edges?.length ?? 0} 条边 · ${v.script.steps.length} 步 · 结构与引用 ✓` });
    } else {
      errors = v.errors;
      sessions.endStep(T, check, { status: "error", detail: v.errors.slice(0, 3).join("；") });
    }
  }
  if (!script) {
    end("invalid", { text: `动画脚本两次都没通过校验，未上画布：\n${errors.slice(0, 6).join("\n")}`, tone: "error" });
    return { ...base, status: "invalid", errors, costUsd: cost, durationMs: ms };
  }
  const mount = sessions.step(T, { kind: "apply", title: "挂载播放器" });
  const before = new Set(api.getSceneElementsIncludingDeleted().map((e) => e.id));
  // mount() is one synchronous updateScene, so the new elements are readable right away.
  // No rAF wait here: requestAnimationFrame is paused while the tab is hidden, and people
  // switch away during the minute-long script generation — the old settle() kept this
  // step open until they came back (a 1m38s "mount").
  animHosts.get(api)!(script);
  const added = api.getSceneElements().filter((e) => !before.has(e.id));
  const region = added.filter((e) => e.type !== "text").map((e) => e.id);
  if (added.length) api.scrollToContent(added, { fitToContent: true, animate: true });
  sessions.endStep(T, mount, { detail: `区域「${script.title}」· ${script.nodes.length} 个元素 · ${script.steps.length} 步 · 播放器在区域下方`, elements: region });
  end("applied", { text: `已生成动画「${script.title}」：${script.nodes.length} 个元素、${script.steps.length} 步，用区域下方的播放器播放。`, changes: [`新建动画区域「${script.title}」`] });
  return { ...base, status: "applied", summary: [`动画「${script.title}」`], costUsd: cost, durationMs: ms };
}
