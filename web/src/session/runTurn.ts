// One schema-constrained planning turn, recorded step by step from real events:
//   read (freeze context) → think / search_library / plan (streamed from the model)
//   → check (schema, references, freshness) → apply (one undoable batch) → reply.
// This is the eval baseline (claude -p in a neutral directory, scripts/eval.ts). Sessions in
// the UI talk to the user's own coding agent instead (agents.ts); its canvas edits come
// back through agentBridge.ts, which reuses the check/apply helpers exported here.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { applyPlan, undoBatch } from "../ops/apply";
import { freeze, staleIds, type FrozenContext, type Request } from "../canvas/context";
import type { LibraryItem } from "../library/libraryInsert";
import { referencedIds, validatePlan, type Op } from "../ops/ops";
import { byId, isArrow, isShape, libraryMeta, live, nameOf, type Scene } from "../canvas/scene";
import { redoBatch, redoOf, versionsAfterRedo, type Redo } from "./redo";
import { sessions, type Origin, type Turn, type Usage } from "./store";
import { ENTITY_ASSETS, pickEngine, type EnginePick } from "../anim/enginePick";
import { tr } from "../i18n";

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
export const settle = (capMs = 1000) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, capMs);
    requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), r())));
  });

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
  o.op === "add_shape" ? o.text : o.op === "add_arrow" ? `${o.from} → ${o.to}` : o.op === "insert_library_item" ? o.label ?? o.ref : o.op === "add_junction" ? o.ref : o.id;

export async function runTurn(input: {
  api: ExcalidrawImperativeAPI;
  sessionId: string;
  canvasId: string;
  request: Request;
  origin: Origin;
  text: string;
  refs?: Turn["refs"];
}): Promise<AgentOutcome> {
  const { api } = input;
  const turn = sessions.startTurn(input.sessionId, { canvasId: input.canvasId, origin: input.origin, request: input.text, refs: input.refs ?? [] });
  const T = turn.id;
  const end = (status: Turn["status"], reply: Turn["reply"]) => sessions.patchTurn(T, (t) => ({ ...t, status, reply, endedAt: Date.now() }));

  // 1. Read: freeze the canvas the agent will see.
  const read = sessions.step(T, { kind: "read", title: tr("读取画布", "Read canvas") });
  const ctx = freeze(all(api), input.request, Object.keys(api.getAppState().selectedElementIds));
  const chars = JSON.stringify(ctx.scene).length;
  sessions.endStep(T, read, {
    detail: tr(`冻结上下文 · ${ctx.scene.nodes.length} 个节点 / ${ctx.scene.arrows.length} 根箭头 · ${chars.toLocaleString()} 字符${ctx.selection.length ? ` · 选区 ${ctx.selection.length}` : ""}`, `Context frozen · ${ctx.scene.nodes.length} nodes / ${ctx.scene.arrows.length} arrows · ${chars.toLocaleString()} chars${ctx.selection.length ? ` · selection ${ctx.selection.length}` : ""}`),
    elements: [...ctx.anchors.map((a) => a.id), ...ctx.selection],
  });
  const base = { ctx, ops: null, errors: [], stale: [], summary: [], costUsd: null, durationMs: 0, turnId: T };

  await engineStep(T, input.text);

  // 2. Plan: stream the model's steps.
  type Res = { raw: unknown; costUsd: number | null; durationMs: number; error?: string; prompt?: string; usage?: Usage };
  let res: Res | null = null;
  let open: string | null = null;
  const tools = new Map<string, string>();
  const close = (at: number, p = {}) => open && (sessions.endStep(T, open, { endedAt: at, ...p }), (open = null));
  const think = (at: number) => (open = sessions.step(T, { kind: "think", title: tr("思考", "Thinking"), startedAt: at }));
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
          if (id) sessions.endStep(T, id, { endedAt: e.at, candidates: candidates.slice(0, 5), detail: candidates.length ? tr(`${candidates.length} 个候选`, `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`) : e.text.slice(0, 120) });
          think(e.at);
        } else if (e.t === "output") {
          close(e.at);
          open = sessions.step(T, { kind: "plan", title: tr("生成操作", "Generate operations"), startedAt: e.at });
        } else if (e.t === "result") {
          res = e;
          if (e.usage) sessions.patchTurn(T, (t) => ({ ...t, usage: [...(t.usage ?? []), e.usage as Usage] }));
          const ops = ((e.raw as { ops?: Op[] })?.ops ?? []) as Op[];
          close(e.at, e.error ? { status: "error", detail: e.error } : { title: tr(`生成 ${ops.length} 个操作`, `Generated ${ops.length} operation${ops.length === 1 ? "" : "s"}`), ops: ops.map((o) => ({ op: o.op, target: opTarget(o) })) });
        }
      }
    }
  } catch (e) {
    close(Date.now(), { status: "error" });
  }
  const done = res as Res | null;
  if (!done || done.error) {
    const msg = done?.error ?? tr("调用模型失败", "The model call failed");
    sessions.step(T, { kind: "error", title: tr("模型没有返回可用结果", "The model returned nothing usable"), detail: msg, status: "error", endedAt: Date.now() });
    sessions.patchTurn(T, (t) => ({ ...t, costUsd: done?.costUsd ?? null }));
    end("error", { text: tr(`模型没有返回可用结果：${msg}`, `The model returned nothing usable: ${msg}`), tone: "error" });
    return { ...base, status: "error", errors: [msg], costUsd: done?.costUsd ?? null, durationMs: done?.durationMs ?? 0 };
  }
  sessions.patchTurn(T, (t) => ({ ...t, costUsd: done.costUsd }));
  const withCost = { ...base, costUsd: done.costUsd, durationMs: done.durationMs, prompt: done.prompt, usage: done.usage };

  // 3. Check: library items exist, schema + references, freshness.
  const check = sessions.step(T, { kind: "check", title: tr("校验 + 新鲜度", "Validate + freshness") });
  const library = await fetchLibraryItems(done.raw);
  const now = all(api);
  const { plan, errors } = validatePlan(done.raw, { ...sceneIndex(now), libraryItem: (id) => library.has(id) });
  const ops = ((done.raw as { ops?: Op[] })?.ops ?? null) as Op[] | null;
  const note = (done.raw as { note?: string })?.note;
  if (!plan) {
    if (ops?.length === 0 && note) {
      sessions.endStep(T, check, { detail: tr("没有操作", "No operations") });
      end("empty", { text: tr(`没有修改：${note}`, `No changes: ${note}`) });
      return { ...withCost, ops, note, status: "empty" };
    }
    sessions.endStep(T, check, { status: "error", detail: errors.join(tr("；", "; ")) });
    end("invalid", { text: tr(`操作未通过校验，未执行：\n${errors.join("\n")}`, `Operations failed validation and were not applied:\n${errors.join("\n")}`), tone: "error" });
    return { ...withCost, ops, note, status: "invalid", errors };
  }
  const nowMap = byId(now);
  const watched = [...new Set([...referencedIds(plan), ...ctx.anchors.map((a) => a.id), ...ctx.selection])];
  const stale = staleIds(ctx, watched, now);
  if (stale.length) {
    const names = stale.map((id) => (nowMap.get(id) ? nameOf(nowMap.get(id)!, nowMap) : id)).join(tr("、", ", "));
    sessions.endStep(T, check, { status: "error", detail: tr(`${names} 在提交后被改动`, `${names} changed after submitting`), elements: stale });
    end("stale", { text: tr(`已拒绝执行：${names} 在提交后被改动过，计划基于旧版本。请重新交给 Agent。`, `Refused: ${names} changed after submitting, so the plan is based on an old version. Hand to agent again.`), tone: "warn" });
    return { ...withCost, ops, note, status: "stale", stale };
  }
  sessions.endStep(T, check, { detail: tr(`schema ✓ · 引用 ✓ · ${watched.length} 个元素版本未变 ✓${library.size ? ` · 素材 ${library.size} 个 ✓` : ""}`, `schema ✓ · refs ✓ · ${watched.length} element versions unchanged ✓${library.size ? ` · ${library.size} library items ✓` : ""}`) });

  // 4. Apply as one undoable batch.
  const apply = sessions.step(T, { kind: "apply", title: tr("应用到画布（1 次可撤销修改）", "Apply to canvas (1 undoable change)") });
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
  sessions.endStep(T, apply, { detail: tr(`${result.summary.length} 处修改 · ${touched.length} 个元素`, `${result.summary.length} change${result.summary.length === 1 ? "" : "s"} · ${touched.length} element${touched.length === 1 ? "" : "s"}`), elements: touched });
  end("applied", { text: tr(`已按${input.origin.kind === "comment" ? "评论" : "要求"}修改 ${result.summary.length} 处${note ? `：${note}` : ""}`, `Made ${result.summary.length} change${result.summary.length === 1 ? "" : "s"} as the ${input.origin.kind === "comment" ? "comment" : "request"} asked${note ? `: ${note}` : ""}`), changes: result.summary, batchId });
  return { ...withCost, ops, note, status: "applied", summary: result.summary, batchId };
}

/** Undo exactly the batch of a turn; refuses when anything it touched changed since. */
/** What each undone turn took off, in memory: 重做 puts it back (./redo.ts). A reload forgets it; the turn stays 已撤销. */
const redoStash = new Map<string, Redo>();
export const canRedoTurn = (turnId: string) => redoStash.has(turnId);

export function undoTurn(api: ExcalidrawImperativeAPI, turnId: string): { ok: boolean; stale: string[] } {
  const turn = sessions.get().turns[turnId];
  const batch = turn?.reply?.batchId ? sessions.batch(turn.reply.batchId) : undefined;
  if (!turn || !batch || turn.reply?.undone) return { ok: false, stale: [] };
  const now = all(api);
  const r = undoBatch(now, batch);
  if (!r.scene) {
    const map = byId(now);
    const stale = r.stale.map((id) => (map.get(id) ? nameOf(map.get(id)!, map) : id)).join(tr("、", ", "));
    const undoError = tr(`无法撤销：${stale} 在 Agent 修改后又被改动过。`, `Can't undo: ${stale} changed again after the agent's edit.`);
    sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undoError } }));
    return { ok: false, stale: r.stale };
  }
  redoStash.set(turnId, redoOf(now, r.scene, batch));
  api.updateScene({ elements: r.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undone: true, undoError: undefined } }));
  return { ok: true, stale: [] };
}

/** 重做: put an undone step back, unless its elements were changed since the undo. */
export function redoTurn(api: ExcalidrawImperativeAPI, turnId: string): { ok: boolean; stale: string[] } {
  const turn = sessions.get().turns[turnId];
  const redo = redoStash.get(turnId);
  if (!turn || !redo || !turn.reply?.undone) return { ok: false, stale: [] };
  const now = all(api);
  const r = redoBatch(now, redo);
  if (!r.scene) {
    const map = byId(now);
    const stale = r.stale.map((id) => (map.get(id) ? nameOf(map.get(id)!, map) : id)).join(tr("、", ", "));
    const undoError = tr(`无法重做：${stale} 在撤销后又被改动过。`, `Can't redo: ${stale} changed again after the undo.`);
    sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undoError } }));
    return { ok: false, stale: r.stale };
  }
  redoStash.delete(turnId);
  if (turn.reply.batchId) sessions.setBatchAfter(turn.reply.batchId, versionsAfterRedo(r.scene as Scene, redo));
  api.updateScene({ elements: r.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  sessions.patchTurn(turnId, (t) => ({ ...t, reply: { ...t.reply!, undone: false, undoError: undefined } }));
  return { ok: true, stale: [] };
}

export async function fetchLibraryItems(raw: unknown): Promise<Map<string, LibraryItem>> {
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
  const id = sessions.step(T, { kind: "engine", title: tr("素材库", "Library") });
  const r = await fetch(`/api/canvas/library/search?q=${encodeURIComponent(request)}&limit=3`).catch(() => null);
  const libraryHits = r?.ok ? (((await r.json()) as { items?: unknown[] }).items ?? []).length : 0;
  const pick = pickEngine({ request, libraryHits });
  sessions.endStep(T, id, { title: tr("素材库：可用", "Library: available"), detail: pick.reason });
  return pick;
}
