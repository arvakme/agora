// Algorithm-animation script: initial nodes + steps of parallel primitives. Engine-agnostic
// (no canvas-engine imports).
// The model returns one of these; nothing runs before validateScript accepts it.
import { z } from "zod";

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "id: lowercase, [a-z0-9_-], ≤32");
const Coord = z.number().finite().min(-4000).max(4000);
const Text = z.string().max(80);

/** Semantic highlight colours; each engine maps them onto its own palette. */
export const TONES = ["compare", "swap", "done", "focus", "visited", "muted"] as const;
export type Tone = (typeof TONES)[number];

export const NodeSchema = z
  .object({
    id: Id,
    text: Text,
    x: Coord,
    y: Coord,
    w: z.number().min(16).max(600).optional(),
    h: z.number().min(16).max(400).optional(),
    shape: z.enum(["rectangle", "ellipse"]).optional(),
  })
  .strict();

export const EdgeSchema = z.object({ from: Id, to: Id }).strict();

export const ActionSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("swap"), a: Id, b: Id }).strict(),
  z.object({ do: z.literal("move"), id: Id, x: Coord, y: Coord }).strict(),
  z.object({ do: z.literal("highlight"), ids: z.array(Id).min(1).max(100), color: z.enum(TONES) }).strict(),
  z.object({ do: z.literal("unhighlight"), ids: z.array(Id).max(100).optional() }).strict(),
  z.object({ do: z.literal("set_label"), id: Id, text: Text }).strict(),
  z.object({ do: z.literal("caption"), text: z.string().min(1).max(160) }).strict(),
]);

export const StepSchema = z.object({ actions: z.array(ActionSchema).min(1).max(40) }).strict();

export const AnimScriptSchema = z
  .object({
    title: z.string().min(1).max(60),
    nodes: z.array(NodeSchema).min(1).max(200),
    edges: z.array(EdgeSchema).max(200).optional(),
    steps: z.array(StepSchema).min(1).max(300),
  })
  .strict();

export type AnimNode = z.infer<typeof NodeSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Step = z.infer<typeof StepSchema>;
export type AnimScript = z.infer<typeof AnimScriptSchema>;

/** JSON Schema for `claude --json-schema` (constrained decoding). */
export function animJsonSchema() {
  const { $schema: _, ...schema } = z.toJSONSchema(AnimScriptSchema); // the CLI rejects the 2020-12 meta ref
  return schema;
}

export const NODE_W = 64;
export const NODE_H = 64;

/** Schema + referential checks. Returns the script or a list of problems. */
export function validateScript(raw: unknown): { script?: AnimScript; errors: string[] } {
  const parsed = AnimScriptSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const s = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of s.nodes) {
    if (ids.has(n.id)) errors.push(`nodes: 重复 id ${n.id}`);
    ids.add(n.id);
  }
  const known = (at: string, id: string) => ids.has(id) || void errors.push(`${at}: 未知节点 ${id}`);
  s.edges?.forEach((e, i) => {
    known(`edges[${i}].from`, e.from);
    known(`edges[${i}].to`, e.to);
    if (e.from === e.to) errors.push(`edges[${i}]: 起止相同`);
  });
  s.steps.forEach((step, i) => {
    // Primitives in one step run in parallel, so each node may be moved and styled at most once.
    const moved = new Set<string>();
    const styled = new Set<string>();
    const cleared = new Set<string>();
    const labelled = new Set<string>();
    let captions = 0;
    const once = (set: Set<string>, id: string, what: string, at: string) => {
      if (set.has(id)) errors.push(`${at}: 同一步里 ${id} 被${what}两次`);
      set.add(id);
    };
    step.actions.forEach((a, j) => {
      const at = `steps[${i}].actions[${j}]`;
      switch (a.do) {
        case "swap":
          known(at, a.a);
          known(at, a.b);
          if (a.a === a.b) errors.push(`${at}: swap 两端相同`);
          once(moved, a.a, "移动", at);
          once(moved, a.b, "移动", at);
          break;
        case "move":
          known(at, a.id);
          once(moved, a.id, "移动", at);
          break;
        case "highlight":
          a.ids.forEach((id) => (known(at, id), once(styled, id, "着色", at)));
          break;
        case "unhighlight":
          a.ids?.forEach((id) => (known(at, id), once(cleared, id, "清除颜色", at)));
          break;
        case "set_label":
          known(at, a.id);
          once(labelled, a.id, "改标签", at);
          break;
        case "caption":
          if (++captions > 1) errors.push(`${at}: 一步只能有一条 caption`);
          break;
      }
    });
  });
  return errors.length ? { errors } : { script: s, errors };
}
