// One-off offline labelling for library items that have neither a name nor any text.
// Input: a directory of PNG renders + meta.json ({ "<file>.png": { id, lib } }),
// produced by rendering the unnamed catalog items with Excalidraw's exportToBlob
// (see libraries/README.md). Output: libraries/labels.json, committed; the app never
// calls a model for labels at runtime. Re-run `npm run libraries:fetch` afterwards.
//
//   node scripts/libraries/label.ts <render-dir>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "");
const meta: Record<string, { id: string; lib: string }> = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const OUT = new URL("../../libraries/labels.json", import.meta.url).pathname;
const labels: Record<string, { name: string; keywords: string[] }> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const todo = Object.entries(meta).filter(([, m]) => !labels[m.id]);
const BATCH = 30;
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["labels"],
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "name", "keywords"],
        properties: { file: { type: "string" }, name: { type: "string" }, keywords: { type: "array", items: { type: "string" }, maxItems: 8 } },
      },
    },
  },
};
let cost = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const prompt = [
    "Each PNG below is one reusable component from an Excalidraw library (the library name is given).",
    "Read every image and give it a short English name (1-4 words, what a diagram author would search for, e.g. \"database cylinder\", \"robot character\", \"kanban column\") and up to 8 lowercase search keywords.",
    "If an image is abstract, name its shape (e.g. \"curved connector\", \"dashed frame\").",
    ...batch.map(([f, m]) => `- ${join(dir, f)}  (library: ${m.lib})`),
  ].join("\n");
  const r = spawnSync(
    "claude",
    ["-p", "--model", "claude-sonnet-5", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "Read", "--allowedTools", "Read", "--add-dir", dir, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"],
    { input: prompt, encoding: "utf8", maxBuffer: 1 << 26 },
  );
  const res = JSON.parse(r.stdout || "{}");
  cost += res.total_cost_usd ?? 0;
  for (const l of res.structured_output?.labels ?? []) {
    const m = meta[l.file.split("/").pop()!];
    if (m && l.name.trim()) labels[m.id] = { name: l.name.trim(), keywords: l.keywords.map((k: string) => k.toLowerCase()) };
  }
  writeFileSync(OUT, JSON.stringify(labels, null, 1));
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length} labelled · $${cost.toFixed(3)}`);
}
