// Renders an eval run (eval/runs/<runId>.jsonl, written by the in-app runner) as Markdown.
// Usage: npm run eval:report [-- eval/runs/<runId>.jsonl]   (defaults to the latest run)
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type Row = {
  task: string; run: number; status: string; valid: boolean; fresh: boolean; correct: boolean;
  collateral: string[]; success: boolean; undoRestores: boolean | null; durationMs: number;
  costUsd: number | null; ops: { op: string }[] | null; detail: string;
};

const dir = "eval/runs";
const file = process.argv[2] ?? join(dir, readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().at(-1)!);
const rows: Row[] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const yn = (b: boolean | null) => (b === null ? "–" : b ? "✓" : "✗");
const s = (ms: number) => (ms / 1000).toFixed(1);
const usd = (n: number) => `$${n.toFixed(4)}`;

// Relative to web/, so the committed report does not carry a local absolute path.
const shown = relative(new URL("..", import.meta.url).pathname, resolve(file));
const out = [
  `Run: \`${shown}\``,
  "",
  "基线：每次规划走 `POST /api/canvas/turns` → 一次性 `claude -p --json-schema`，在中性的空临时目录里运行（不继承仓库或项目上下文），不经过 Agent 会话。",
  "",
  "| 任务 | 次 | 通过校验 | 新鲜度 | 改对元素 | 误伤 | 撤销还原 | 耗时 s | 花费 | 操作 | 判定依据 |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| ${r.task} | ${r.run} | ${yn(r.valid)} | ${yn(r.fresh)} | ${yn(r.correct)} | ${r.collateral.length ? r.collateral.join(", ") : "无"} | ${yn(r.undoRestores)} | ${s(r.durationMs)} | ${r.costUsd === null ? "–" : usd(r.costUsd)} | ${(r.ops ?? []).map((o) => o.op).join(" ")} | ${r.detail.replace(/\|/g, "/")} |`,
  ),
  "",
  "| 任务 | 成功 | 平均耗时 s | 平均花费 |",
  "|---|---|---|---|",
];
const groups = Map.groupBy(rows, (r) => r.task);
for (const [task, rs] of groups) {
  out.push(`| ${task} | ${rs.filter((r) => r.success).length}/${rs.length} | ${s(avg(rs.map((r) => r.durationMs)))} | ${usd(avg(rs.map((r) => r.costUsd ?? 0)))} |`);
}
const ok = rows.filter((r) => r.success).length;
out.push(`| **合计** | **${ok}/${rows.length}（${Math.round((ok / rows.length) * 100)}%）** | ${s(avg(rows.map((r) => r.durationMs)))} | ${usd(avg(rows.map((r) => r.costUsd ?? 0)))}（总 ${usd(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0))}） |`);
console.log(out.join("\n"));

function avg(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
