// Typed edit operations: the only thing the model may return. Pure schema + validation
// (no DOM), shared by the browser executor and the dev-server planner; its rules are generated/plan.rules.json.

import RULES from "../../generated/plan.rules.json" with { type: "json" };

export type ShapeKind = "rectangle" | "ellipse" | "diamond";
export type Op =
  | { op: "update_text"; id: string; text: string }
  | { op: "move"; id: string; x: number; y: number }
  | { op: "resize"; id: string; width: number; height: number }
  | { op: "add_shape"; ref: string; shape: ShapeKind; text: string; x: number; y: number; width?: number; height?: number; frameId?: string }
  | {
      op: "add_arrow";
      ref?: string;
      from: string;
      to: string;
      text?: string;
      bothEnds?: boolean;
      /** The line's absolute points, first on the start node's edge, last on the end node's (a bent line; default: straight). */
      path?: Point[];
      /** No arrowhead at either end: a line that only joins a junction dot. */
      plain?: boolean;
    }
  | { op: "add_junction"; ref: string; x: number; y: number }
  | { op: "route"; id: string; path: Point[] | null }
  | { op: "delete"; id: string }
  | {
      op: "insert_library_item";
      ref: string;
      /** Catalog id from search_library, e.g. "official/aws/serverless#3". */
      item: string;
      /** Place next to an existing element (preferred) … */
      near?: { id: string; side: Side; gap?: number };
      /** … or at an absolute top-left. */
      at?: { x: number; y: number };
      /** Optional caption shown under the component. */
      label?: string;
      /** Scale the component to this width (keeps aspect ratio). */
      width?: number;
      frameId?: string;
    };
export type Side = "right" | "left" | "above" | "below";
export type Point = [number, number];
export type Plan = { ops: Op[]; note?: string };

const str = { type: "string", minLength: 1, maxLength: 200 };
const num = { type: "number" };
const point = { type: "array", minItems: 2, maxItems: 2, items: num };
const path = { type: "array", minItems: RULES.path.min, maxItems: RULES.path.max, items: point };
const obj = (op: string, props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties: { op: { const: op }, ...props },
  required: ["op", ...required],
});

/** JSON Schema handed to `claude --json-schema` for constrained output. */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ops"],
  properties: {
    note: { type: "string", maxLength: 300 },
    ops: {
      type: "array",
      maxItems: 20,
      items: {
        anyOf: [
          obj("update_text", { id: str, text: str }, ["id", "text"]),
          obj("move", { id: str, x: num, y: num }, ["id", "x", "y"]),
          obj("resize", { id: str, width: num, height: num }, ["id", "width", "height"]),
          obj(
            "add_shape",
            { ref: str, shape: { enum: ["rectangle", "ellipse", "diamond"] }, text: str, x: num, y: num, width: num, height: num, frameId: str },
            ["ref", "shape", "text", "x", "y"],
          ),
          obj("add_arrow", { ref: str, from: str, to: str, text: str, bothEnds: { type: "boolean" }, path, plain: { type: "boolean" } }, ["from", "to"]),
          obj("add_junction", { ref: str, x: num, y: num }, ["ref", "x", "y"]),
          obj("route", { id: str, path: { anyOf: [path, { type: "null" }] } }, ["id", "path"]),
          obj("delete", { id: str }, ["id"]),
          obj(
            "insert_library_item",
            {
              ref: str,
              item: str,
              near: { type: "object", additionalProperties: false, properties: { id: str, side: { enum: ["right", "left", "above", "below"] }, gap: num }, required: ["id", "side"] },
              at: { type: "object", additionalProperties: false, properties: { x: num, y: num }, required: ["x", "y"] },
              label: str,
              width: num,
              frameId: str,
            },
            ["ref", "item"],
          ),
        ],
      },
    },
  },
} as const;

// The referential rules are data, in one file the server's fallback executor reads too (server/canvas/plan_rules.py):
// which fields each op takes, which kinds of element each field may name, the limits.
type OpRules = { req: string[]; opt: string[]; targets?: Record<string, Kind[]>; creates?: Kind };
const OPS = RULES.ops as Record<string, OpRules>;
const NUMERIC = new Set<string>(RULES.numeric);
const BOOLEANS = new Set<string>(RULES.booleans);
const REF = new RegExp(RULES.ref);
/** How a pattern prints in a message (the same on the server side). */
const REF_TEXT = `/${RULES.ref}/`;
const targets = (op: string, field: string): Kind[] => OPS[op].targets?.[field] ?? [];

/** What validation needs to know about the current scene. */
export type Kind = "shape" | "arrow" | "frame" | "library";
/** What validation needs to know about the current scene and the library items fetched for this plan. */
export type SceneIndex = { kind(id: string): Kind | undefined; libraryItem?(id: string): boolean };

/** Schema + referential validation. Returns a list of problems (empty = valid). */
export function validatePlan(raw: unknown, scene: SceneIndex): { plan?: Plan; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Plan).ops)) return { errors: ["缺少 ops 数组"] };
  const ops = (raw as Plan).ops as unknown[];
  if (ops.length === 0) errors.push("ops 为空");
  const created = new Map<string, Kind>();
  const deleted = new Set<string>();
  const kind = (id: string) => (deleted.has(id) ? undefined : created.get(id) ?? scene.kind(id));

  ops.forEach((o, i) => {
    const at = `ops[${i}]`;
    if (!o || typeof o !== "object") return void errors.push(`${at} 不是对象`);
    const op = o as Record<string, unknown>;
    const spec = OPS[op.op as string];
    if (!spec) return void errors.push(`${at}.op 未知：${String(op.op)}`);
    for (const k of Object.keys(op)) if (k !== "op" && !spec.req.includes(k) && !spec.opt.includes(k)) errors.push(`${at} 多余字段 ${k}`);
    for (const k of spec.req) if (op[k] === undefined) errors.push(`${at} 缺少 ${k}`);
    for (const [k, v] of Object.entries(op)) {
      if (k === "op" || v === undefined || k === "near" || k === "at") continue;
      if (NUMERIC.has(k)) {
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${at}.${k} 不是有限数字`);
        else if ((k === "width" || k === "height") && (v < RULES.size.min || v > RULES.size.max)) errors.push(`${at}.${k} 超出 ${RULES.size.min}–${RULES.size.max}`);
        else if (Math.abs(v) > RULES.coordinateMax) errors.push(`${at}.${k} 超出画布范围`);
      } else if (BOOLEANS.has(k)) {
        if (typeof v !== "boolean") errors.push(`${at}.${k} 不是布尔值`);
      } else if (k === "path") {
        if (v === null && op.op === "route") continue; // back to the plain straight arrow
        if (!Array.isArray(v) || v.length < RULES.path.min || v.length > RULES.path.max || !v.every((p) => Array.isArray(p) && p.length === 2)) errors.push(`${at}.path 需要 ${RULES.path.min}–${RULES.path.max} 个 [x, y] 点`);
        else if (!v.every((p) => p.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= RULES.coordinateMax))) errors.push(`${at}.path 的坐标要是有限数字，绝对值不超过 ${RULES.coordinateMax}`);
      } else if (typeof v !== "string" || !v.trim() || v.length > RULES.stringMax) errors.push(`${at}.${k} 不是非空字符串`);
    }
    const need = (id: unknown, allowed: string[], field = "id") => {
      const k = typeof id === "string" ? kind(id) : undefined;
      if (!k) errors.push(`${at}.${field} 指向不存在的元素 ${String(id)}`);
      else if (!allowed.includes(k)) errors.push(`${at}.${field} 类型 ${k} 不支持 ${String(op.op)}`);
    };
    switch (op.op) {
      case "update_text":
        need(op.id, targets("update_text", "id"));
        break;
      case "move":
        need(op.id, targets("move", "id"));
        break;
      case "resize":
        need(op.id, targets("resize", "id"));
        break;
      case "delete":
        need(op.id, targets("delete", "id"));
        if (typeof op.id === "string") deleted.add(op.id);
        break;
      case "add_shape":
        if (!RULES.shapes.includes(op.shape as string)) errors.push(`${at}.shape 非法`);
        if (op.frameId !== undefined) need(op.frameId, targets("add_shape", "frameId"), "frameId");
        addRef(op.ref, OPS.add_shape.creates!);
        break;
      case "add_arrow":
        need(op.from, targets("add_arrow", "from"), "from");
        need(op.to, targets("add_arrow", "to"), "to");
        if (op.from === op.to) errors.push(`${at} 起止相同`);
        if (op.ref !== undefined) addRef(op.ref, OPS.add_arrow.creates!);
        break;
      case "add_junction":
        addRef(op.ref, OPS.add_junction.creates!);
        break;
      case "route":
        need(op.id, targets("route", "id"));
        break;
      case "insert_library_item": {
        if (typeof op.item !== "string" || !scene.libraryItem?.(op.item)) errors.push(`${at}.item 不是素材库里的组件 id：${String(op.item)}（先用 search_library 查）`);
        const near = op.near as { id?: unknown; side?: unknown; gap?: unknown } | undefined;
        const pos = op.at as { x?: unknown; y?: unknown } | undefined;
        if (!near === !pos) errors.push(`${at} 需要 near 或 at 其中之一`);
        if (near) {
          need(near.id, targets("insert_library_item", "near.id"), "near.id");
          if (!RULES.sides.includes(near.side as string)) errors.push(`${at}.near.side 非法`);
          if (near.gap !== undefined && (typeof near.gap !== "number" || near.gap < 0 || near.gap > RULES.gapMax)) errors.push(`${at}.near.gap 超出 0–${RULES.gapMax}`);
        }
        if (pos && (typeof pos.x !== "number" || typeof pos.y !== "number" || !Number.isFinite(pos.x) || !Number.isFinite(pos.y))) errors.push(`${at}.at 需要有限的 x/y`);
        if (op.frameId !== undefined) need(op.frameId, targets("insert_library_item", "frameId"), "frameId");
        addRef(op.ref, OPS.insert_library_item.creates!);
        break;
      }
    }
    function addRef(ref: unknown, k: Kind) {
      if (typeof ref !== "string" || !REF.test(ref)) return void errors.push(`${at}.ref 需匹配 ${REF_TEXT}`);
      if (kind(ref) || created.has(ref)) return void errors.push(`${at}.ref ${ref} 与已有元素重名`);
      created.set(ref, k);
    }
  });
  return errors.length ? { errors } : { plan: raw as Plan, errors };
}

/** Every existing element id the plan reads or writes (for freshness checks). */
export function referencedIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const o of plan.ops) {
    if ("id" in o) ids.add(o.id);
    if (o.op === "add_arrow") ids.add(o.from).add(o.to);
    if ((o.op === "add_shape" || o.op === "insert_library_item") && o.frameId) ids.add(o.frameId);
    if (o.op === "insert_library_item" && o.near) ids.add(o.near.id);
  }
  return [...ids];
}
