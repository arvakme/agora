// The fidelity loop's test project (web/docs/workstation.md §8): a copy of a project whose only
// canvas (`c1`, so scripts get `window.__agora`) is laid out like the 工位视图 prototype's diagram —
// Web 前端 / API 服务 / MySQL / Redis / 支付服务 at the prototype's world coordinates, with the
// same edges and labels and the same code links — so `?mock=runs` (runs/fixtures.ts, the
// prototype's script) plays on the same picture as the prototype.
//
//   node scripts/fidelity/setup.ts <source project> <new project dir>
//
// The source project is copied without its live-server records (.agora/run) or its machine-local
// records (.agora/local, so it opens as a fresh project, not as a copy), and is never modified.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type N = { id: string; label: string; x: number; y: number; w: number; h: number; link: string };
// The prototype's NODES / EDGES (proto-src/src.html), world px.
export const NODES: N[] = [
  { id: "web", label: "Web 前端", x: 40, y: 230, w: 170, h: 72, link: "web/**" },
  { id: "api", label: "API 服务", x: 330, y: 230, w: 200, h: 72, link: "server/**" },
  { id: "mysql", label: "MySQL", x: 680, y: 120, w: 160, h: 64, link: "server/db/**" },
  { id: "redis", label: "Redis", x: 680, y: 330, w: 160, h: 64, link: "server/cache/**" },
  { id: "pay", label: "支付服务", x: 350, y: 450, w: 160, h: 64, link: "server/payments/**" },
];
const EDGES: { a: string; b: string; label: string; pts: [number, number][]; dashed?: boolean }[] = [
  { a: "web", b: "api", label: "HTTP", pts: [[210, 266], [330, 266]] },
  { a: "api", b: "mysql", label: "SQL", pts: [[530, 252], [610, 252], [610, 152], [680, 152]] },
  { a: "api", b: "redis", label: "缓存", pts: [[530, 280], [610, 280], [610, 362], [680, 362]] },
  { a: "api", b: "pay", label: "子服务", pts: [[430, 302], [430, 450]], dashed: true },
];

let seed = 1000;
const common = () => ({
  angle: 0,
  backgroundColor: "transparent",
  fillStyle: "solid",
  frameId: null,
  groupIds: [] as string[],
  isDeleted: false,
  link: null,
  locked: false,
  opacity: 100,
  roughness: 1,
  seed: ++seed,
  strokeColor: "#1e1e1e",
  strokeStyle: "solid",
  strokeWidth: 2,
  updated: 1,
  version: 1,
  versionNonce: ++seed,
});
const textW = (s: string, size: number) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? size : size * 0.55), 0);
const text = (id: string, s: string, size: number, x: number, y: number, containerId: string | null) => ({
  ...common(),
  id,
  type: "text",
  text: s,
  originalText: s,
  fontSize: size,
  fontFamily: 1,
  lineHeight: 1.25,
  textAlign: "center",
  verticalAlign: "middle",
  containerId,
  autoResize: true,
  boundElements: [],
  roundness: null,
  width: textW(s, size),
  height: size * 1.25,
  x: x - textW(s, size) / 2,
  y: y - (size * 1.25) / 2,
});

// The API 服务 node opens a more detailed diagram one level down (a nested canvas, web/docs/nested-canvas.md):
// the mock script's server/app.py and server/users.py land on its nodes, so a worker walks, climbs and
// goes in and out of the sub-diagram. Laid out so that one hop is a bridge and one a ladder.
export const API_CHILD = "c-api";
const API_NODES: N[] = [
  { id: "api-app", label: "应用入口", x: 60, y: 120, w: 170, h: 64, link: "server/app.py" },
  { id: "api-routes", label: "路由", x: 330, y: 120, w: 170, h: 64, link: "server/routes/**" },
  { id: "api-users", label: "用户模块", x: 330, y: 330, w: 170, h: 64, link: "server/users.py" },
  { id: "api-auth", label: "鉴权", x: 620, y: 330, w: 170, h: 64, link: "server/auth/**" },
];
const API_EDGES: typeof EDGES = [
  { a: "api-app", b: "api-routes", label: "挂载", pts: [[230, 152], [330, 152]] },
  { a: "api-routes", b: "api-users", label: "/users", pts: [[415, 184], [415, 330]] },
  { a: "api-users", b: "api-auth", label: "校验", pts: [[500, 362], [620, 362]] },
];

export function canvas(nodes: N[] = NODES, edges: typeof EDGES = EDGES, child: Record<string, string> = { api: API_CHILD }) {
  const els: object[] = [];
  for (const n of nodes) {
    const arrows = edges.filter((e) => e.a === n.id || e.b === n.id).map((e) => ({ id: `e-${e.a}-${e.b}`, type: "arrow" }));
    els.push({ ...common(), id: n.id, type: "rectangle", x: n.x, y: n.y, width: n.w, height: n.h, roundness: { type: 3 }, boundElements: [{ id: `${n.id}-t`, type: "text" }, ...arrows], customData: { codePaths: [n.link], ...(child[n.id] ? { childCanvas: child[n.id] } : {}) } });
    els.push(text(`${n.id}-t`, n.label, 18, n.x + n.w / 2, n.y + n.h / 2, n.id));
  }
  for (const e of edges) {
    const [x0, y0] = e.pts[0];
    const pts = e.pts.map(([x, y]) => [x - x0, y - y0]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const id = `e-${e.a}-${e.b}`;
    els.push({
      ...common(),
      id,
      type: "arrow",
      x: x0,
      y: y0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points: pts,
      strokeWidth: 1,
      roughness: 0,
      strokeStyle: e.dashed ? "dashed" : "solid",
      roundness: null,
      elbowed: false,
      startArrowhead: null,
      endArrowhead: "arrow",
      startBinding: { elementId: e.a, focus: 0, gap: 1 },
      endBinding: { elementId: e.b, focus: 0, gap: 1 },
      lastCommittedPoint: null,
      boundElements: [{ id: `${id}-t`, type: "text" }],
    });
    const m = Math.floor((e.pts.length - 1) / 2);
    const [ax, ay] = e.pts[m];
    const [bx, by] = e.pts[m + 1];
    els.push(text(`${id}-t`, e.label, 14, (ax + bx) / 2, (ay + by) / 2, id));
  }
  return { type: "excalidraw", version: 2, source: "agora", elements: els, appState: { gridSize: null, viewBackgroundColor: "#ffffff" }, files: {} };
}

export function setup(src: string, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("/.agora/run") && !p.includes("/.agora/local") && !p.endsWith("/.git") && !p.includes("/.git/") });
  const store = join(dir, ".agora");
  rmSync(join(store, "canvases"), { recursive: true, force: true });
  mkdirSync(join(store, "canvases"), { recursive: true });
  writeFileSync(join(store, "canvases", "c1.excalidraw"), JSON.stringify(canvas(), null, 1));
  writeFileSync(join(store, "canvases", `${API_CHILD}.excalidraw`), JSON.stringify(canvas(API_NODES, API_EDGES, {}), null, 1));
  writeFileSync(
    join(store, "workspace.json"),
    JSON.stringify(
      { v: 2, docs: [{ id: "c1", kind: "canvas", title: "总架构" }, { id: API_CHILD, kind: "canvas", title: "API 服务" }], focused: "c1", root: { id: "g-fid", kind: "group", tabs: ["c1"], active: "c1" } },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dir] = process.argv.slice(2);
  if (!src || !dir) {
    console.error("usage: node scripts/fidelity/setup.ts <source project> <new project dir>");
    process.exit(2);
  }
  setup(src, dir);
  console.log(dir);
}
