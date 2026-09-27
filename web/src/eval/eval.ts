// 7 fixed tasks × N runs through the real UI path (thread → handToAgent → apply → undo).
// Rows are returned to the caller; the eval CLI (scripts/eval.ts) persists them to
// eval/runs/<runId>.jsonl. replayEval() re-executes recorded rows offline (no model).
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { handToAgent, sceneIndex, undoAgent } from "../ops/agent";
import { applyPlan, undoBatch } from "../ops/apply";
import { validatePlan, type Op } from "../ops/ops";
import { buildFixture } from "./fixture";
import type { LibraryItem } from "../library/libraryInsert";
import { byId, bbox, isArrow, isShape, labelOf, libraryMeta, type El, type Scene } from "../canvas/scene";
import type { ThreadStore } from "../comments/threads";

type Sem = Record<string, Record<string, unknown>>;

/** Semantic projection: what a reviewer would call "the diagram". Arrow geometry is derived, so ignored. */
export function semantic(scene: Scene): Sem {
  const map = byId(scene);
  const out: Sem = {};
  // A library component counts once (its root); its internal parts are not "the diagram".
  const libGroups = new Set(scene.filter((e) => !e.isDeleted).map((e) => libraryMeta(e)?.group).filter(Boolean));
  for (const e of scene) {
    if (e.isDeleted) continue;
    const lib = libraryMeta(e);
    if (!lib && e.groupIds.some((g) => libGroups.has(g))) continue;
    if (lib) out[e.id] = { kind: "library", item: lib.library, name: lib.name, label: labelOf(e, map), x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) };
    else if (isShape(e)) out[e.id] = { kind: "shape", label: labelOf(e, map), x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height), frame: e.frameId ?? null };
    else if (isArrow(e)) out[e.id] = { kind: "arrow", from: e.startBinding?.elementId ?? null, to: e.endBinding?.elementId ?? null, label: labelOf(e, map), both: !!e.startArrowhead };
    else if (e.type === "frame") out[e.id] = { kind: "frame", name: e.name, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) };
  }
  return out;
}

export function diff(a: Sem, b: Sem) {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const id of ids) {
    if (!a[id]) added.push(id);
    else if (!b[id]) removed.push(id);
    else if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) changed.push(id);
  }
  return { added, removed, changed };
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
const shapes = (s: Sem) => Object.entries(s).filter(([, v]) => v.kind === "shape") as [string, Box & { label: string; frame: string | null }][];
const arrowsBetween = (s: Sem, a: string, b: string) =>
  Object.values(s).filter((v) => v.kind === "arrow" && ((v.from === a && v.to === b) || (v.from === b && v.to === a)));
const overlapping = (s: Sem, ids: string[]) =>
  ids.flatMap((id) => shapes(s).filter(([o, box]) => o !== id && overlaps(box, s[id] as unknown as Box)).map(([o]) => `${id}×${o}`));

/** Smallest distance from one box to every other shape / frame / library component (arrows excluded). */
function minGap(s: Sem, id: string) {
  const a = s[id] as unknown as Box;
  let best = Infinity;
  for (const [o, v] of Object.entries(s)) {
    if (o === id || !["shape", "frame", "library"].includes(String(v.kind))) continue;
    const b = v as unknown as Box;
    // A frame only counts by its border when the component sits outside it.
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

type Check = { correct: boolean; detail: string; allowed: (id: string, after: Sem) => boolean };
export type Task = { id: string; anchors: string[]; text: string; check: (before: Sem, after: Sem) => Check };

export const TASKS: Task[] = [
  {
    id: "T1-rename",
    anchors: ["redis"],
    text: "改名成 Redis（通知）",
    check: (_b, s) => {
      const label = String(s.redis?.label ?? "");
      return { correct: /^Redis\s*[（(]通知[)）]$/.test(label), detail: `label=${JSON.stringify(label)}`, allowed: (id) => id === "redis" };
    },
  },
  {
    id: "T2-add-kimi",
    anchors: ["codex"],
    text: "再加一个 Kimi worker，和 Codex 并排，也由 Pi Master 派发",
    check: (before, s) => {
      const kimis = shapes(s).filter(([id, v]) => !before[id] && /kimi/i.test(v.label));
      const k = kimis[0];
      if (kimis.length !== 1) return { correct: false, detail: `kimi shapes=${kimis.length}`, allowed: () => false };
      const [kid, kv] = k;
      const codex = s.codex as unknown as Box;
      const sideBySide = Math.abs(kv.y - codex.y) <= 16 || Math.abs(kv.x - codex.x) <= 16;
      const fromPi = Object.values(s).some((v) => v.kind === "arrow" && v.from === "pi" && v.to === kid);
      const inTmux = kv.frame === "tmux";
      const overlap = overlapping(s, [kid]);
      const ok = sideBySide && fromPi && inTmux && !overlap.length;
      return {
        correct: ok,
        detail: `kimi=${kid} (${kv.x},${kv.y}) sideBySide=${sideBySide} pi→kimi=${fromPi} inTmux=${inTmux} overlap=${overlap.join(",") || "none"}`,
        allowed: (id, after) => id === kid || id === "tmux" || (after[id]?.kind === "arrow" && !before[id]),
      };
    },
  },
  {
    id: "T3-label-arrow",
    anchors: ["e-browser-backend"],
    text: "这里其实是 WebSocket，把箭头标注成 WS",
    check: (_b, s) => {
      const a = s["e-browser-backend"];
      const label = String(a?.label ?? "");
      const ok = !!a && a.from === "browser" && a.to === "backend" && /\bWS\b/.test(label);
      return { correct: ok, detail: `label=${JSON.stringify(label)}`, allowed: (id) => id === "e-browser-backend" };
    },
  },
  {
    id: "T4-align",
    anchors: ["postgres", "redis"],
    text: "把这两个框上下对齐并放到后端右侧",
    check: (_b, s) => {
      const pg = s.postgres as unknown as Box, rd = s.redis as unknown as Box, be = s.backend as unknown as Box;
      if (!pg || !rd || !be) return { correct: false, detail: "missing node", allowed: () => false };
      const aligned = Math.abs(pg.x + pg.w / 2 - (rd.x + rd.w / 2)) <= 2;
      const stacked = pg.y + pg.h <= rd.y || rd.y + rd.h <= pg.y;
      const right = Math.min(pg.x, rd.x) >= be.x + be.w;
      const overlap = overlapping(s, ["postgres", "redis"]);
      return {
        correct: aligned && stacked && right && !overlap.length,
        detail: `pg=(${pg.x},${pg.y}) redis=(${rd.x},${rd.y}) aligned=${aligned} stacked=${stacked} rightOfBackend=${right} overlap=${overlap.join(",") || "none"}`,
        allowed: (id) => id === "postgres" || id === "redis",
      };
    },
  },
  {
    id: "T5-delete-host",
    anchors: ["host"],
    text: "删掉这个框，Agora 后端直接连 Pi Master",
    check: (before, s) => {
      const gone = !s.host;
      const dangling = Object.entries(s).filter(([, v]) => v.kind === "arrow" && (v.from === null || v.to === null)).map(([id]) => id);
      const direct = arrowsBetween(s, "backend", "pi").length > 0;
      return {
        correct: gone && direct && !dangling.length,
        detail: `hostDeleted=${gone} backend↔pi=${direct} dangling=${dangling.join(",") || "none"}`,
        allowed: (id, after) => id === "host" || id === "e-backend-host" || id === "e-host-pi" || (after[id]?.kind === "arrow" && !before[id]),
      };
    },
  },
  {
    // Should use the built-in asset library: a named technology with a ready-made icon.
    id: "T6-library-kafka",
    anchors: ["backend"],
    text: "在 Agora 后端右边加一个 Kafka 图标，并从后端连一条线过去",
    check: (before, s) => {
      const added = Object.entries(s).filter(([id]) => !before[id]);
      const libs = added.filter(([, v]) => v.kind === "library");
      const k = libs.find(([, v]) => /kafka/i.test(`${v.name} ${v.item}`));
      const be = s.backend as unknown as Box;
      const right = !!k && (k[1] as unknown as Box).x >= be.x + be.w;
      const linked = !!k && arrowsBetween(s, "backend", k[0]).length > 0;
      const overlap = k ? overlapping(s, [k[0]]) : [];
      // Spacing: the component must keep ≥ 16px from every shape, frame and other component.
      const gap = k ? minGap(s, k[0]) : 0;
      const label = k ? String(k[1].label) : "";
      const dupLabel = !!k && label !== String(k[1].name) && /kafka/i.test(label) && /kafka/i.test(String(k[1].name));
      return {
        correct: libs.length === 1 && !!k && right && linked && !overlap.length && gap >= 16,
        detail: `libraryInserts=${libs.length} kafka=${k ? `${k[1].name} (${k[1].item})` : "none"} rightOfBackend=${right} linked=${linked} overlap=${overlap.join(",") || "none"} minGap=${Math.round(gap)} caption=${dupLabel ? "dup" : "none"} plainShapes=${added.filter(([, v]) => v.kind === "shape").length}`,
        allowed: (id, after) => !before[id] && (after[id]?.kind === "library" || after[id]?.kind === "arrow"),
      };
    },
  },
  {
    // Should NOT use the library: a plain placeholder box is drawn, not a component.
    id: "T7-plain-todo-box",
    anchors: ["browser"],
    text: "在浏览器下面加一个写着 TODO 的方框",
    check: (before, s) => {
      const added = Object.entries(s).filter(([id]) => !before[id]);
      const libs = added.filter(([, v]) => v.kind === "library");
      const box = added.find(([, v]) => v.kind === "shape" && /todo/i.test(String(v.label)));
      const br = s.browser as unknown as Box;
      const below = !!box && (box[1] as unknown as Box).y >= br.y + br.h;
      const overlap = box ? overlapping(s, [box[0]]) : [];
      return {
        correct: !libs.length && !!box && below && !overlap.length,
        detail: `libraryInserts=${libs.length} todoBox=${box ? box[0] : "none"} below=${below} overlap=${overlap.join(",") || "none"}`,
        allowed: (id, after) => !before[id] && (after[id]?.kind === "shape" || after[id]?.kind === "arrow"),
      };
    },
  },
];

export type EvalRow = {
  runId: string;
  task: string;
  run: number;
  status: string;
  valid: boolean;
  fresh: boolean;
  correct: boolean;
  collateral: string[];
  success: boolean;
  undoRestores: boolean | null;
  durationMs: number;
  costUsd: number | null;
  ops: unknown;
  errors: string[];
  detail: string;
  summary: string[];
  promptChars: number;
  at: string;
};
export type EvalProgress = { index: number; total: number; done: boolean; log: string[] };

export async function runEval(
  api: ExcalidrawImperativeAPI,
  threads: ThreadStore,
  { runs, onProgress, reset, only }: { runs: number; onProgress: (p: EvalProgress) => void; reset: () => void; only?: string[] },
) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const tasks = TASKS.filter((t) => !only || only.some((o) => t.id === o || t.id.startsWith(`${o}-`)));
  const total = tasks.length * runs;
  const log: string[] = [`run ${runId}`];
  const rows: EvalRow[] = [];
  let index = 0;
  const report = (done = false) => onProgress({ index, total, done, log: [...log] });
  report();
  for (const task of tasks) {
    for (let run = 1; run <= runs; run++) {
      index++;
      reset();
      await frame();
      const all = api.getSceneElementsIncludingDeleted() as El[];
      const map = byId(all);
      const primary = map.get(task.anchors[0])!;
      const b = bbox(primary);
      api.updateScene({ appState: { selectedElementIds: Object.fromEntries(task.anchors.map((id) => [id, true])) } });
      const t = threads.create({ ids: task.anchors, rel: isArrow(primary) ? { x: 0.5, y: 0.5 } : { x: 1, y: 0 }, last: { x: b.x + b.width, y: b.y } }, task.text);
      const before = semantic(api.getSceneElementsIncludingDeleted() as El[]);
      log.push(`${task.id} #${run} → planning…`);
      report();
      const o = await handToAgent(api, threads, t.id);
      const after = semantic(api.getSceneElementsIncludingDeleted() as El[]);
      const d = diff(before, after);
      const applied = o.status === "applied";
      const chk = applied ? task.check(before, after) : { correct: false, detail: o.errors.join("; ") || o.note || o.status, allowed: () => false };
      const collateral = applied ? [...d.added, ...d.removed, ...d.changed].filter((id) => !chk.allowed(id, after)) : [];
      let undoRestores: boolean | null = null;
      if (applied && o.msgId) {
        undoAgent(api, threads, t.id, o.msgId);
        undoRestores = JSON.stringify(semantic(api.getSceneElementsIncludingDeleted() as El[])) === JSON.stringify(semantic(buildFixture()));
      }
      const row: EvalRow = {
        runId,
        task: task.id,
        run,
        status: o.status,
        valid: o.status !== "invalid" && o.status !== "error",
        fresh: o.status !== "stale",
        correct: chk.correct,
        collateral,
        success: applied && chk.correct && collateral.length === 0,
        undoRestores,
        durationMs: o.durationMs,
        costUsd: o.costUsd,
        ops: o.ops,
        errors: o.errors,
        detail: chk.detail,
        summary: o.summary,
        promptChars: JSON.stringify(o.ctx.scene).length,
        at: new Date().toISOString(),
      };
      rows.push(row);
      log[log.length - 1] = `${task.id} #${run} ${row.success ? "✓" : "✗"} ${o.status} ${(o.durationMs / 1000).toFixed(1)}s $${o.costUsd?.toFixed(4)} ${chk.detail}${collateral.length ? ` collateral=${collateral}` : ""}`;
      report();
    }
  }
  const ok = rows.filter((r) => r.success).length;
  log.push(`done: ${ok}/${rows.length} success → eval/runs/${runId}.jsonl`);
  report(true);
  return rows;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const settle = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export type ReplayResult = {
  task: string;
  run: number;
  /** false for rows the replay cannot reproduce (model-side statuses: stale/error/empty). */
  replayed: boolean;
  match: boolean;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
};

/**
 * Offline replay of recorded eval rows: validatePlan → applyPlan → task check → undo,
 * all against the real canvas. No model calls; `insert_library_item` components are
 * read straight from the vendored catalog files, so only the dev server is needed.
 * Rows whose recorded status came from the model side (stale/error/empty) are skipped —
 * they are not reproducible without the model.
 */
export async function replayEval(
  api: ExcalidrawImperativeAPI,
  rows: EvalRow[],
  { reset }: { reset: () => void },
): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  const fixtureSem = JSON.stringify(semantic(buildFixture()));
  const scene = () => api.getSceneElementsIncludingDeleted() as El[];

  const catalog = (await (await fetch("/libraries/catalog.json")).json()) as {
    libraries: { key: string; name: string; file: string }[];
    items: { id: string; lib: string }[];
  };
  const fileOf = new Map(catalog.libraries.map((l) => [l.key, l.file] as const));
  const itemFile = new Map(catalog.items.map((i) => [i.id, fileOf.get(i.lib)] as const));
  const files = new Map<string, Promise<Map<string, LibraryItem>>>();
  const itemsIn = (file: string) => {
    if (!files.has(file))
      files.set(
        file,
        fetch(`/libraries/${file}`)
          .then((r) => r.json())
          .then((d: { library: { name: string }; items: { id: string; name: string; elements: unknown[] }[] }) =>
            new Map(d.items.map((i) => [i.id, { id: i.id, name: i.name, library: d.library.name, elements: i.elements } satisfies LibraryItem])),
          ),
      );
    return files.get(file)!;
  };

  for (const row of rows) {
    const task = TASKS.find((t) => t.id === row.task);
    const push = (r: Omit<ReplayResult, "task" | "run">) => out.push({ task: row.task, run: row.run, ...r });
    if (!task) {
      push({ replayed: false, match: false, reason: `未知任务 ${row.task}` });
      continue;
    }
    if (row.status !== "applied" && row.status !== "invalid") {
      push({ replayed: false, match: true, reason: `status=${row.status} 由模型侧决定，不可回放` });
      continue;
    }
    reset();
    await settle();
    const { plan, errors } = validatePlan({ ops: (row.ops ?? []) as Op[] }, { ...sceneIndex(scene()), libraryItem: (id) => itemFile.has(id) && !!itemFile.get(id) });
    if (row.status === "invalid") {
      const stillInvalid = !plan;
      push({ replayed: true, match: stillInvalid, expected: { valid: false }, actual: { valid: !stillInvalid, errors } });
      continue;
    }
    if (!plan) {
      push({ replayed: true, match: false, expected: { valid: true, success: row.success }, actual: { valid: false, errors } });
      continue;
    }
    const before = semantic(scene());
    const itemIds = [...new Set(plan.ops.filter((o) => o.op === "insert_library_item").map((o) => o.item))];
    const library = new Map<string, LibraryItem>();
    for (const id of itemIds) {
      const file = itemFile.get(id);
      const it = file ? (await itemsIn(file)).get(id) : undefined;
      if (it) library.set(id, it);
    }
    const result = applyPlan(scene(), plan, library);
    api.updateScene({ elements: result.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    // Same settle as runTurn: Excalidraw re-measures bound text and bumps versions.
    await settle();
    const settled = byId(scene());
    for (const id of result.batch.after.keys()) if (settled.has(id)) result.batch.after.set(id, settled.get(id)!.version);
    const after = semantic(scene());
    const chk = task.check(before, after);
    const d = diff(before, after);
    const collateral = [...d.added, ...d.removed, ...d.changed].filter((id) => !chk.allowed(id, after)).sort();
    let undoRestores: boolean | null = null;
    const u = undoBatch(scene(), result.batch);
    if (u.scene) {
      api.updateScene({ elements: u.scene, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      await settle();
      undoRestores = JSON.stringify(semantic(scene())) === fixtureSem;
    }
    const actual = { correct: chk.correct, collateral, success: chk.correct && collateral.length === 0, undoRestores };
    const expected = { correct: row.correct, collateral: [...row.collateral].sort(), success: row.success, undoRestores: row.undoRestores };
    const match = actual.correct === expected.correct && actual.success === expected.success && actual.undoRestores === expected.undoRestores && JSON.stringify(actual.collateral) === JSON.stringify(expected.collateral);
    push({ replayed: true, match, expected, actual });
  }
  return out;
}
