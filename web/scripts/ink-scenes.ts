// Loaded into the dev page (vite serves it) by scripts/ink-audit.ts and scripts/reveal-capture.ts --library: the scenes 分站揭示's drawing is checked on
// (web/docs/workstation.md §17), and the check itself — the same export and the same preparation the page's reveal layer uses (src/workstation/ink.ts).
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { sceneSvg } from "../src/buildreplay/scenePicture";
import type { El } from "../src/canvas/scene";
import { instantiate, type LibraryItem } from "../src/library/libraryInsert";
import { paintInk, prepareInk, scopeIds, tagged, type InkHow } from "../src/workstation/ink";
import { inkPlan } from "../src/workstation/reveal";

const STROKES = ["solid", "dashed", "dotted"] as const;
const FILLS = ["hachure", "cross-hatch", "zigzag", "solid", "none"] as const;

/** A tiny picture for the image elements: a gradient with a ring (a PNG made here, no file read). */
function picture(): string {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 96, 64);
  grad.addColorStop(0, "#4dabf7");
  grad.addColorStop(1, "#f783ac");
  g.fillStyle = grad;
  g.fillRect(0, 0, 96, 64);
  g.strokeStyle = "#fff";
  g.lineWidth = 6;
  g.beginPath();
  g.arc(48, 32, 18, 0, Math.PI * 2);
  g.stroke();
  return c.toDataURL("image/png");
}

/**
 * Every element type an agent's batch can add, in every stroke style and fill style, and the odd ones (rotated, half opacity, roughness 0 and 2,
 * thin and thick strokes, a stroke-less filled shape, labels on boxes and on arrows, a frame with a child, a group, an image, an embed, text alone).
 * `p`: an id prefix (a scene can take it more than once); `x0`, `y0`: its top-left.
 */
export function syntheticScene(p = "syn", x0 = 0, y0 = 0): { elements: El[]; files: BinaryFiles } {
  const sk: Record<string, unknown>[] = [];
  const tweak = new Map<string, Record<string, unknown>>();
  const add = (s: Record<string, unknown>, t: Record<string, unknown> = {}) => {
    sk.push({ ...s, x: x0 + (s.x as number), y: y0 + (s.y as number) });
    tweak.set(s.id as string, t);
  };
  let n = 0;
  const id = (k: string) => `${p}-${k}-${n++}`;
  // shapes: type × stroke × fill
  const shapes: [string, Record<string, unknown>][] = [
    ["rectangle", { roundness: null }],
    ["rectangle", { roundness: { type: 3 } }],
    ["ellipse", {}],
    ["diamond", {}],
  ];
  shapes.forEach(([type, extra], r) =>
    STROKES.forEach((stroke, si) =>
      FILLS.forEach((fill, fi) => {
        const col = si * FILLS.length + fi;
        add(
          { id: id(type), type, x: col * 140, y: r * 110, width: 110, height: 76, strokeColor: "#1e1e1e", backgroundColor: fill === "none" ? "transparent" : "#a5d8ff", fillStyle: fill === "none" ? "solid" : fill, strokeStyle: stroke, strokeWidth: 2, roughness: 1 },
          extra,
        );
      }),
    ),
  );
  // lines and arrows: kind × stroke
  const Y = 4 * 110 + 20;
  const lines: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["line", { points: [[0, 0], [110, 40]] }, {}],
    ["line", { points: [[0, 0], [40, 50], [80, 0], [110, 50]] }, {}],
    ["line", { points: [[0, 0], [40, 50], [80, 0], [110, 50]] }, { roundness: { type: 2 } }],
    ["line", { points: [[0, 0], [110, 0], [80, 60], [0, 0]], backgroundColor: "#ffd8a8", fillStyle: "hachure" }, {}],
    ["arrow", { points: [[0, 0], [110, 40]] }, {}],
    ["arrow", { points: [[0, 0], [55, 0], [55, 60], [110, 60]] }, { elbowed: true, roughness: 0, roundness: null, fixedSegments: null, startIsSpecial: false, endIsSpecial: false }],
    ["arrow", { points: [[0, 0], [50, 60], [110, 10]] }, { roundness: { type: 2 } }],
    ["arrow", { points: [[0, 0], [30, 50], [70, 0], [110, 50]], startArrowhead: "dot", endArrowhead: "triangle" }, {}],
    ["arrow", { points: [[0, 0], [120, 0]], label: { text: "标签" } }, {}],
  ];
  lines.forEach(([type, s, t], r) =>
    STROKES.forEach((stroke, si) => add({ id: id(type), type, x: si * 170 + (r % 3) * 520, y: Y + Math.floor(r / 3) * 100, strokeColor: "#1971c2", strokeStyle: stroke, strokeWidth: 2, roughness: 1, ...s }, { strokeStyle: stroke, ...t })),
  );
  // the rest
  const Z = Y + 3 * 100 + 30;
  const wave = Array.from({ length: 40 }, (_, i) => [i * 4, Math.sin(i / 4) * 20] as [number, number]);
  add({ id: id("freedraw"), type: "freedraw", x: 0, y: Z + 30, strokeColor: "#e03131", strokeWidth: 2 }, { points: wave, pressures: [], simulatePressure: true, width: 160, height: 40 });
  add({ id: id("freedraw"), type: "freedraw", x: 200, y: Z + 30, strokeColor: "#2f9e44", strokeWidth: 4 }, { points: wave.map(([x, y]) => [x, -y]), pressures: [], simulatePressure: true, width: 160, height: 40 });
  const fileId = `${p}-file`;
  add({ id: id("image"), type: "image", x: 400, y: Z, width: 96, height: 64 }, { fileId, status: "saved", scale: [1, 1], crop: null });
  add({ id: id("image"), type: "image", x: 520, y: Z, width: 96, height: 64 }, { fileId, status: "saved", scale: [1, 1], crop: null, roundness: { type: 3 }, angle: 0.2 });
  add({ id: id("embeddable"), type: "embeddable", x: 650, y: Z, width: 160, height: 90, link: "https://example.com" }, { link: "https://example.com" });
  const child = id("child");
  add({ id: id("frame"), type: "frame", x: 850, y: Z, width: 220, height: 120, name: "一个框架", children: [child] });
  add({ id: child, type: "rectangle", x: 880, y: Z + 30, width: 100, height: 60, strokeColor: "#1e1e1e", backgroundColor: "#b2f2bb", fillStyle: "solid", label: { text: "框里" } });
  add({ id: id("magicframe"), type: "frame", x: 1100, y: Z, width: 180, height: 120, name: "魔法框", children: [] }, { type: "magicframe" });
  const Z2 = Z + 160;
  add({ id: id("text"), type: "text", x: 0, y: Z2, text: "一行字", fontSize: 24 });
  add({ id: id("text"), type: "text", x: 140, y: Z2, text: "多行文字\nsecond line\n第三行", fontSize: 20 });
  add({ id: id("text"), type: "text", x: 320, y: Z2, text: "居中\ncentered", fontSize: 20, textAlign: "center" });
  add({ id: id("text"), type: "text", x: 460, y: Z2, text: "שלום עולם", fontSize: 22 });
  add({ id: id("text"), type: "text", x: 620, y: Z2, text: "rotated text", fontSize: 20 }, { angle: -0.3 });
  const Z3 = Z2 + 110;
  add({ id: id("rot"), type: "rectangle", x: 0, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", backgroundColor: "#d0bfff", fillStyle: "hachure" }, { angle: 0.35 });
  add({ id: id("alpha"), type: "ellipse", x: 150, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", backgroundColor: "#ffc9c9", fillStyle: "solid", opacity: 50 });
  add({ id: id("r0"), type: "rectangle", x: 290, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", roughness: 0 });
  add({ id: id("r2"), type: "diamond", x: 430, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", roughness: 2, backgroundColor: "#ffec99", fillStyle: "cross-hatch" });
  add({ id: id("w1"), type: "rectangle", x: 570, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", strokeWidth: 1 });
  add({ id: id("w4"), type: "ellipse", x: 710, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", strokeWidth: 4 });
  add({ id: id("nostroke"), type: "rectangle", x: 850, y: Z3, width: 110, height: 70, strokeColor: "transparent", backgroundColor: "#228be6", fillStyle: "solid" });
  add({ id: id("label"), type: "rectangle", x: 990, y: Z3, width: 130, height: 70, strokeColor: "#1e1e1e", label: { text: "带字的框" } });
  add({ id: id("link"), type: "ellipse", x: 1150, y: Z3, width: 110, height: 70, strokeColor: "#1e1e1e", link: "https://example.com/x" });
  const grp = `${p}-group`;
  add({ id: id("g"), type: "rectangle", x: 0, y: Z3 + 110, width: 80, height: 50, strokeColor: "#1e1e1e" }, { groupIds: [grp] });
  add({ id: id("g"), type: "ellipse", x: 100, y: Z3 + 110, width: 50, height: 50, strokeColor: "#1e1e1e", backgroundColor: "#96f2d7", fillStyle: "solid" }, { groupIds: [grp] });
  add({ id: id("g"), type: "text", x: 170, y: Z3 + 120, text: "成组", fontSize: 20 }, { groupIds: [grp] });

  const els = convertToExcalidrawElements(sk as never, { regenerateIds: false }) as unknown as El[];
  const out = els.map((e) => ({ ...e, ...(tweak.get(e.id) ?? {}) }) as El);
  const files: BinaryFiles = { [fileId]: { id: fileId, dataURL: picture(), mimeType: "image/png", created: Date.now() } } as unknown as BinaryFiles;
  return { elements: out, files };
}

const describe = (e: El): string => {
  const x = e as El & { roundness?: unknown; elbowed?: boolean; points?: unknown[] };
  const bits: string[] = [e.type];
  if (e.type === "rectangle" || e.type === "line" || e.type === "arrow") if (x.roundness) bits.push("round");
  if (x.elbowed) bits.push("elbow");
  if ((e.type === "line" || e.type === "arrow") && x.points) bits.push(`${x.points.length}pt`);
  if (!["text", "image", "frame", "magicframe", "embeddable", "iframe"].includes(e.type)) bits.push(e.strokeStyle, e.backgroundColor === "transparent" ? "nofill" : e.fillStyle, `r${e.roughness}`, `w${e.strokeWidth}`);
  if (e.strokeColor === "transparent") bits.push("nostroke");
  if (e.angle) bits.push("rotated");
  if (e.opacity < 100) bits.push(`α${e.opacity}`);
  if (e.groupIds?.length) bits.push("grouped");
  if ((e as El & { containerId?: string | null }).containerId) bits.push("bound");
  return bits.join(" ");
};

export type PartRow = { id: string; desc: string; how: InkHow; reason?: string; len: number };
/** `partial`: every part that draws was seen part drawn at some moment (`unseen`: those that were not). */
export type Audit = { parts: PartRow[]; units: number; strays: number; partial: boolean; unseen?: string[]; error?: string };

/** One scene through the reveal layer's own path: exported tagged, prepared, and painted halfway through its first unit's strokes (is a stroke partly drawn there?). */
export async function auditEls(key: string, els: El[], files: BinaryFiles | null = null, host?: HTMLElement): Promise<Audit> {
  try {
    const svg = await sceneSvg(`audit:${key}`, tagged(els), 0, false, files);
    if (!svg) return { parts: [], units: 0, strays: 0, partial: false, error: "export failed" };
    const box = host ?? document.body.appendChild(Object.assign(document.createElement("div"), { style: "position:fixed;left:0;top:0;opacity:0.01;pointer-events:none" }));
    box.innerHTML = scopeIds(svg.html, `a${key.replace(/[^\w-]/g, "_")}-`);
    const root = box.querySelector("svg")!;
    const ink = prepareInk(root, els);
    const byId = new Map(els.map((e) => [e.id, e]));
    const steps = inkPlan(ink.units.map((u) => u.kind)).steps;
    // every unit painted at many moments through its strokes and its text: is each part that draws seen part drawn at one of them?
    const seen = new Set<string>();
    const mid = (done: number) => done > 0.01 && done < 0.99;
    ink.units.forEach((u, k) => {
      const s = steps[k];
      const ts = [...Array(24)].map((_, i) => s.start + (s.dur * (i + 0.5)) / 24).concat([...Array(12)].map((_, i) => s.text + (s.textDur * (i + 0.5)) / 12));
      for (const t of ts) {
        paintInk(ink, steps, t);
        for (const p of u.parts) {
          if (p.pieces.some((pc) => pc.passes.some((x) => mid(1 - Number(x.el.style.strokeDashoffset) / (x.len || 1))))) seen.add(p.id);
          if ([...p.wipes, ...p.texts].some((w) => mid(Number(w.rect.getAttribute("width")) / (w.w || 1)))) seen.add(p.id);
        }
      }
    });
    const drawing = ink.units.flatMap((u) => u.parts).filter((p) => p.pieces.length || p.wipes.length || p.texts.length);
    const unseen = drawing.filter((p) => !seen.has(p.id));
    const partial = drawing.length > 0 && unseen.length === 0;
    const parts = ink.parts.map((p) => ({ id: p.id, desc: describe(byId.get(p.id)!), how: p.how, reason: p.reason, len: Math.round(p.len) }));
    if (!host) box.remove();
    return { parts, units: ink.units.length, strays: ink.strays.length, partial, unseen: unseen.map((p) => describe(byId.get(p.id)!)) };
  } catch (err) {
    return { parts: [], units: 0, strays: 0, partial: false, error: String((err as Error)?.stack ?? err).slice(0, 600) };
  }
}

/** A library item as an agent's insert_library_item places it (src/library/libraryInsert.ts), audited. */
export async function auditItem(item: LibraryItem): Promise<Audit & { elements: number }> {
  const els = instantiate(item, { ref: "c", at: { x: 0, y: 0 } });
  return { ...(await auditEls(item.id, els)), elements: els.length };
}
