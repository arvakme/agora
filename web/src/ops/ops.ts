// Typed edit operations: the only thing the model may return. Pure schema + validation
// (no DOM), shared by the browser executor and the dev-server planner.

export type ShapeKind = "rectangle" | "ellipse" | "diamond";
export type Op =
  | { op: "update_text"; id: string; text: string }
  | { op: "move"; id: string; x: number; y: number }
  | { op: "resize"; id: string; width: number; height: number }
  | { op: "add_shape"; ref: string; shape: ShapeKind; text: string; x: number; y: number; width?: number; height?: number; frameId?: string }
  | { op: "add_arrow"; ref?: string; from: string; to: string; text?: string; bothEnds?: boolean }
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
export type Plan = { ops: Op[]; note?: string };

const str = { type: "string", minLength: 1, maxLength: 200 };
const num = { type: "number" };
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
          obj("add_arrow", { ref: str, from: str, to: str, text: str, bothEnds: { type: "boolean" } }, ["from", "to"]),
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

const KEYS: Record<Op["op"], { req: string[]; opt: string[] }> = {
  update_text: { req: ["id", "text"], opt: [] },
  move: { req: ["id", "x", "y"], opt: [] },
  resize: { req: ["id", "width", "height"], opt: [] },
  add_shape: { req: ["ref", "shape", "text", "x", "y"], opt: ["width", "height", "frameId"] },
  add_arrow: { req: ["from", "to"], opt: ["ref", "text", "bothEnds"] },
  delete: { req: ["id"], opt: [] },
  insert_library_item: { req: ["ref", "item"], opt: ["near", "at", "label", "width", "frameId"] },
};
const NUMERIC = new Set(["x", "y", "width", "height"]);
const REF = /^[a-z][a-z0-9_-]{0,31}$/;

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
    const spec = KEYS[op.op as Op["op"]];
    if (!spec) return void errors.push(`${at}.op 未知：${String(op.op)}`);
    for (const k of Object.keys(op)) if (k !== "op" && !spec.req.includes(k) && !spec.opt.includes(k)) errors.push(`${at} 多余字段 ${k}`);
    for (const k of spec.req) if (op[k] === undefined) errors.push(`${at} 缺少 ${k}`);
    for (const [k, v] of Object.entries(op)) {
      if (k === "op" || v === undefined || k === "near" || k === "at") continue;
      if (NUMERIC.has(k)) {
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${at}.${k} 不是有限数字`);
        else if ((k === "width" || k === "height") && (v < 8 || v > 2000)) errors.push(`${at}.${k} 超出 8–2000`);
        else if (Math.abs(v) > 20000) errors.push(`${at}.${k} 超出画布范围`);
      } else if (k === "bothEnds") {
        if (typeof v !== "boolean") errors.push(`${at}.bothEnds 不是布尔值`);
      } else if (typeof v !== "string" || !v.trim() || v.length > 200) errors.push(`${at}.${k} 不是非空字符串`);
    }
    const need = (id: unknown, allowed: string[], field = "id") => {
      const k = typeof id === "string" ? kind(id) : undefined;
      if (!k) errors.push(`${at}.${field} 指向不存在的元素 ${String(id)}`);
      else if (!allowed.includes(k)) errors.push(`${at}.${field} 类型 ${k} 不支持 ${String(op.op)}`);
    };
    switch (op.op) {
      case "update_text":
        need(op.id, ["shape", "arrow", "frame", "library"]);
        break;
      case "move":
        need(op.id, ["shape", "frame", "library"]);
        break;
      case "resize":
        need(op.id, ["shape", "frame"]);
        break;
      case "delete":
        need(op.id, ["shape", "arrow", "frame", "library"]);
        if (typeof op.id === "string") deleted.add(op.id);
        break;
      case "add_shape":
        if (!["rectangle", "ellipse", "diamond"].includes(op.shape as string)) errors.push(`${at}.shape 非法`);
        if (op.frameId !== undefined) need(op.frameId, ["frame"], "frameId");
        addRef(op.ref, "shape");
        break;
      case "add_arrow":
        need(op.from, ["shape", "library"], "from");
        need(op.to, ["shape", "library"], "to");
        if (op.from === op.to) errors.push(`${at} 起止相同`);
        if (op.ref !== undefined) addRef(op.ref, "arrow");
        break;
      case "insert_library_item": {
        if (typeof op.item !== "string" || !scene.libraryItem?.(op.item)) errors.push(`${at}.item 不是素材库里的组件 id：${String(op.item)}（先用 search_library 查）`);
        const near = op.near as { id?: unknown; side?: unknown; gap?: unknown } | undefined;
        const pos = op.at as { x?: unknown; y?: unknown } | undefined;
        if (!near === !pos) errors.push(`${at} 需要 near 或 at 其中之一`);
        if (near) {
          need(near.id, ["shape", "frame", "library"], "near.id");
          if (!["right", "left", "above", "below"].includes(near.side as string)) errors.push(`${at}.near.side 非法`);
          if (near.gap !== undefined && (typeof near.gap !== "number" || near.gap < 0 || near.gap > 800)) errors.push(`${at}.near.gap 超出 0–800`);
        }
        if (pos && (typeof pos.x !== "number" || typeof pos.y !== "number" || !Number.isFinite(pos.x) || !Number.isFinite(pos.y))) errors.push(`${at}.at 需要有限的 x/y`);
        if (op.frameId !== undefined) need(op.frameId, ["frame"], "frameId");
        addRef(op.ref, "library");
        break;
      }
    }
    function addRef(ref: unknown, k: Kind) {
      if (typeof ref !== "string" || !REF.test(ref)) return void errors.push(`${at}.ref 需匹配 ${REF}`);
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
