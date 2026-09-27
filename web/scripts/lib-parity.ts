// Parity check: server/canvas/library.py (Python) must return the same top-8 results as
// the spike's server/library.ts (TypeScript) for a fixed query set. Run once per library
// or scoring change:
//
//   node scripts/lib-parity.ts
//   SPIKE_DIR=~/Job/agora-spikes/excalidraw node scripts/lib-parity.ts
//
// The TS implementation is imported straight from the spike checkout (read-only); the
// Python side is invoked once over all queries and compared by item id + order.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SPIKE = resolve(process.env.SPIKE_DIR ?? join(homedir(), "Job/agora-spikes/excalidraw"));
const AGORA = new URL("../..", import.meta.url).pathname;

const QUERIES = [
  // English product/tech names
  "redis", "kafka", "postgres", "mysql", "mongodb", "nginx", "docker", "kubernetes",
  "aws lambda", "s3", "ec2", "gcp", "azure", "graphql", "grpc", "rabbitmq", "elasticsearch",
  "prometheus", "grafana", "terraform",
  // generic diagram nouns
  "server", "database", "cache", "queue", "user", "person", "browser", "phone", "laptop",
  "cloud", "gateway", "load balancer", "container", "lock", "shield", "file", "chart",
  "robot", "arrow", "storage", "network", "firewall", "router", "api",
  // Chinese (ZH expansion)
  "数据库", "缓存", "服务器", "用户", "云", "消息队列",
];

const PY_SNIPPET = `
import json, sys
from server.canvas.library import Library
queries = json.loads(sys.argv[1])
lib = Library()
out = {q: [{"id": h["id"], "score": h["score"]} for h in lib.search(q, 8)] for q in queries}
print(json.dumps(out))
`;

const { searchLibrary } = (await import(pathToFileURL(join(SPIKE, "server/library.ts")).href)) as {
  searchLibrary: (q: string, limit?: number) => { id: string; score: number }[];
};

const py = execFileSync("uv", ["run", "python", "-c", PY_SNIPPET, JSON.stringify(QUERIES)], {
  cwd: AGORA,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const pyResults: Record<string, { id: string; score: number }[]> = JSON.parse(py);

let bad = 0;
for (const q of QUERIES) {
  const ts = searchLibrary(q, 8);
  const pyHits = pyResults[q] ?? [];
  const tsIds = ts.map((h) => h.id);
  const pyIds = pyHits.map((h) => h.id);
  if (tsIds.join() !== pyIds.join()) {
    bad++;
    console.log(`✗ ${q}\n  ts: ${tsIds.join(", ")}\n  py: ${pyIds.join(", ")}`);
  }
}
if (bad) {
  console.error(`lib parity: ${bad}/${QUERIES.length} queries differ`);
  process.exit(1);
}
console.log(`lib parity: all ${QUERIES.length} queries return identical top-8`);
