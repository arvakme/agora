// The eval fixture: a small architecture diagram laid out for Excalidraw.
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { buildArrow, buildShape, byId, NODE_SIZE, type El, type ShapeKind } from "../canvas/scene";

type Node = { id: string; label: string; x: number; y: number; shape?: ShapeKind; fill: string; frame?: string };

const NODES: Node[] = [
  { id: "user", label: "用户", x: 60, y: 60, shape: "ellipse", fill: "#eef4ff" },
  { id: "browser", label: "浏览器", x: 60, y: 220, fill: "#eef4ff" },
  { id: "backend", label: "Agora 后端", x: 320, y: 220, fill: "#f3efff" },
  { id: "postgres", label: "Postgres", x: 200, y: 400, fill: "#eaf7ef" },
  { id: "redis", label: "Redis", x: 440, y: 400, fill: "#eaf7ef" },
  { id: "host", label: "本机宿主", x: 600, y: 220, fill: "#fff4e6" },
  { id: "pi", label: "Pi Master", x: 880, y: 220, fill: "#fff0f3" },
  { id: "claude", label: "Claude Code", x: 790, y: 410, fill: "#f6f8fa", frame: "tmux" },
  { id: "codex", label: "Codex", x: 1010, y: 410, fill: "#f6f8fa", frame: "tmux" },
];

const EDGES: [id: string, from: string, to: string, both?: boolean][] = [
  ["e-user-browser", "user", "browser"],
  ["e-browser-backend", "browser", "backend"],
  ["e-backend-postgres", "backend", "postgres"],
  ["e-backend-redis", "backend", "redis"],
  ["e-backend-host", "backend", "host", true],
  ["e-host-pi", "host", "pi"],
  ["e-pi-claude", "pi", "claude"],
  ["e-pi-codex", "pi", "codex"],
];

export function buildFixture(): El[] {
  const frame = convertToExcalidrawElements(
    [{ type: "frame", id: "tmux", name: "tmux", x: 760, y: 370, width: 460, height: 150, children: [] }],
    { regenerateIds: false },
  );
  const shapes = NODES.flatMap((n) =>
    buildShape({
      id: n.id,
      shape: n.shape ?? "rectangle",
      ...NODE_SIZE,
      x: n.x,
      y: n.y,
      label: n.label,
      base: { backgroundColor: n.fill, frameId: n.frame ?? null },
    }).map((e) => (n.frame ? { ...e, frameId: n.frame } : e)),
  );
  const map = byId(shapes);
  const arrows = EDGES.flatMap(([id, from, to, both]) => buildArrow({ id, from: map.get(from)!, to: map.get(to)!, bothEnds: both }));
  // Arrows' conversion returns fresh copies of endpoints' boundElements only on the skeleton copies; wire the real ones.
  const bound = new Map<string, { id: string; type: "arrow" }[]>();
  for (const a of arrows) {
    if (a.type !== "arrow") continue;
    for (const b of [a.startBinding, a.endBinding]) if (b) bound.set(b.elementId, [...(bound.get(b.elementId) ?? []), { id: a.id, type: "arrow" }]);
  }
  const wired = shapes.map((s) => (bound.has(s.id) ? { ...s, boundElements: [...(s.boundElements ?? []), ...bound.get(s.id)!] } : s));
  // Frame first so it renders beneath its children.
  return [...frame, ...wired, ...arrows] as El[];
}
