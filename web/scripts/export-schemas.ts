// Exports the JSON Schemas the FastAPI side validates against (server/canvas/schemas.py
// loads these files; the frontend keeps zod/manual validation for references). Run via
// `npm run schemas` — also part of `npm run build`. Output is committed to generated/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_SCHEMA } from "../src/ops/ops.ts";
import { animJsonSchema } from "../src/anim/script.ts";

const OUT = new URL("../generated/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const schemas: Record<string, unknown> = {
  "plan.schema.json": PLAN_SCHEMA,
  "anim.schema.json": animJsonSchema(),
  // canvas-engine-pick rule 6 (unsure, tldraw available): the same generation call also
  // returns `engine`, so choosing never costs an extra model call.
  "anim-ask.schema.json": {
    type: "object",
    additionalProperties: false,
    required: ["script", "engine"],
    properties: { script: animJsonSchema(), engine: { enum: ["excalidraw", "tldraw"] } },
  },
};
for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(join(OUT, name), JSON.stringify(schema, null, 1) + "\n");
  console.log(`generated/${name}`);
}
