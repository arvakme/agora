// Excalidraw adapter. Excalidraw has no animation API: every frame rebuilds the touched
// elements (new objects, bumped versions) and calls updateScene with CaptureUpdateAction.NEVER,
// so playback never enters undo history. Only mount/remove are undoable edits.
import { CaptureUpdateAction, convertToExcalidrawElements, getCommonBounds, newElementWith, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { buildArrow, buildShape, byId, type El } from "../canvas/scene.ts";
import type { AnimEngine, ViewRect } from "./player.ts";
import { NODE_H, NODE_W } from "./script.ts";
import { colorsOf, extent, type Frame, type Timeline } from "./timeline.ts";

const PAD = 40;
let seq = 0;

export function excalidrawEngine(api: ExcalidrawImperativeAPI): AnimEngine {
  const prefix = `anim${++seq}-${Math.random().toString(36).slice(2, 6)}`;
  const frameId = `${prefix}-region`;
  const el = (id: string) => `${prefix}-${id}`;
  let origin = { x: 0, y: 0 };
  let tl: Timeline;
  const textOf = new Map<string, string>(); // node id → bound text element id
  const drawn = new Map<string, { x: number; y: number; text: string; fill: string }>();
  let edgeIds: { id: string; from: string; to: string }[] = [];

  const scene = () => api.getSceneElementsIncludingDeleted() as readonly El[];

  return {
    name: "excalidraw",
    mount(timeline) {
      tl = timeline;
      const box = extent(tl);
      const live = scene().filter((e) => !e.isDeleted);
      const [, y0, x1] = live.length ? getCommonBounds(live) : [0, 0, 0];
      const region = { x: x1 + 160, y: y0, w: box.w + PAD * 2, h: box.h + PAD * 2 };
      origin = { x: region.x + PAD - box.x, y: region.y + PAD - box.y };
      const [frame] = convertToExcalidrawElements(
        [{ type: "frame", id: frameId, name: tl.script.title, x: region.x, y: region.y, width: region.w, height: region.h, children: [] }],
        { regenerateIds: false },
      );
      const nodes = tl.script.nodes.flatMap((n) => {
        const out = buildShape({
          id: el(n.id),
          shape: n.shape ?? "rectangle",
          x: origin.x + n.x,
          y: origin.y + n.y,
          width: n.w ?? NODE_W,
          height: n.h ?? NODE_H,
          label: n.text || " ",
          base: { frameId },
        }).map((e) => ({ ...e, frameId }) as El);
        const t = out.find((e) => e.type === "text");
        if (t) textOf.set(n.id, t.id);
        return out;
      });
      const map = byId(nodes);
      edgeIds = (tl.script.edges ?? []).map((e, i) => ({ id: el(`e${i}`), from: e.from, to: e.to }));
      const arrows = edgeIds.flatMap((e) => buildArrow({ id: e.id, from: map.get(el(e.from))!, to: map.get(el(e.to))!, base: { frameId, strokeColor: "#8c929a" } }));
      const bound = new Map<string, { id: string; type: "arrow" }[]>();
      for (const e of edgeIds) for (const end of [e.from, e.to]) bound.set(el(end), [...(bound.get(el(end)) ?? []), { id: e.id, type: "arrow" }]);
      const wired = nodes.map((s) => (bound.has(s.id) ? ({ ...s, boundElements: [...(s.boundElements ?? []), ...bound.get(s.id)!] } as El) : s));
      api.updateScene({ elements: [...scene(), frame as El, ...wired, ...arrows], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.scrollToContent(frame as El, { fitToContent: true, animate: true, duration: 400 });
    },

    render(f: Frame) {
      const all = scene();
      const map = byId(all);
      const next = new Map<string, El>();
      const moved = new Set<string>();
      for (const n of f.nodes) {
        const box = map.get(el(n.id));
        if (!box || box.isDeleted) continue;
        const x = origin.x + n.x, y = origin.y + n.y;
        const [fill, stroke] = colorsOf(n);
        const prev = drawn.get(n.id);
        if (prev && prev.x === x && prev.y === y && prev.text === n.text && prev.fill === fill) continue;
        drawn.set(n.id, { x, y, text: n.text, fill });
        if (!prev || prev.x !== x || prev.y !== y) moved.add(n.id);
        next.set(box.id, newElementWith(box as never, { x, y, backgroundColor: fill, strokeColor: stroke } as never) as El);
        const tid = textOf.get(n.id);
        const text = tid && map.get(tid);
        if (!text || text.type !== "text") continue;
        if (text.originalText !== n.text) {
          // Re-measure via the skeleton converter; keep the text element's id.
          const [, t] = buildShape({ id: box.id, shape: box.type as "rectangle", x, y, width: box.width, height: box.height, label: n.text || " ", base: { frameId } });
          if (t) next.set(tid, { ...t, id: tid, containerId: box.id, frameId, version: text.version + 1, versionNonce: text.versionNonce + 1 } as El);
        } else next.set(tid, newElementWith(text as never, { x: text.x + x - box.x, y: text.y + y - box.y } as never) as El);
      }
      // Bound arrows don't follow updateScene moves; re-route the ones touching moved nodes.
      if (moved.size) {
        const at = (id: string) => next.get(el(id)) ?? map.get(el(id))!;
        for (const e of edgeIds) {
          if (!moved.has(e.from) && !moved.has(e.to)) continue;
          const old = map.get(e.id);
          const [a] = buildArrow({ id: e.id, from: at(e.from), to: at(e.to), base: { frameId, strokeColor: "#8c929a" } });
          if (old) next.set(e.id, { ...a, version: old.version + 1 } as El);
        }
      }
      if (!next.size) return;
      api.updateScene({ elements: all.map((e) => next.get(e.id) ?? e), captureUpdate: CaptureUpdateAction.NEVER });
    },

    rect(): ViewRect | null {
      const frame = byId(scene()).get(frameId);
      if (!frame || frame.isDeleted) return null;
      const s = api.getAppState();
      const p = sceneCoordsToViewportCoords({ sceneX: frame.x, sceneY: frame.y }, s);
      return { x: p.x, y: p.y, w: frame.width * s.zoom.value, h: frame.height * s.zoom.value };
    },

    remove() {
      const mine = (e: El) => e.id === frameId || e.id.startsWith(`${prefix}-`);
      api.updateScene({ elements: scene().map((e) => (mine(e) ? (newElementWith(e as never, { isDeleted: true } as never) as El) : e)), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
  };
}
