// Executes a validated plan against the scene as one batch. Returns the next scene,
// a human summary for the thread, and what is needed to undo exactly this batch.
import { caption, instantiate, libraryMembers, type LibraryItem } from "../library/libraryInsert";
import type { Op, Plan } from "./ops";
import { clearSpot, obstaclesFor } from "../canvas/spacing";
import {
  arrowsOf,
  boundText,
  buildArrow,
  buildJunction,
  buildShape,
  byId,
  isArrow,
  isShape,
  labelOf,
  libraryMeta,
  nameOf,
  NODE_SIZE,
  styleOf,
  type El,
  type Scene,
  type ShapeKind,
} from "../canvas/scene";

export type Batch = {
  /** Pre-batch copy of every element this batch changed; null = created by the batch. */
  before: Map<string, El | null>;
  /** Version each touched element had right after the batch (undo freshness). */
  after: Map<string, number>;
};
export type ApplyResult = { scene: El[]; summary: string[]; batch: Batch };

const FRAME_PAD = 24;
const nonce = () => Math.floor(Math.random() * 2 ** 31);

export function applyPlan(scene: Scene, plan: Plan, library: Map<string, LibraryItem> = new Map()): ApplyResult {
  const orig = byId(scene);
  const work = new Map(orig);
  const order = scene.map((e) => e.id);
  const changed = new Set<string>();
  const geometryChanged = new Set<string>();
  /** Arrows given their own path in this batch: moving an end afterwards puts them back on the plain straight line. */
  const routed = new Set<string>();
  const summary: string[] = [];
  const name = (id: string) => nameOf(work.get(id)!, work);

  const put = (el: El) => {
    if (!work.has(el.id)) order.push(el.id);
    work.set(el.id, el);
    changed.add(el.id);
  };

  /** Rebuild a shape with new geometry/label, keeping its id, style and label id. */
  const rebuildShape = (el: El, patch: { x?: number; y?: number; width?: number; height?: number; label?: string }) => {
    const oldText = boundText(el, work);
    const [container, text] = buildShape({
      id: el.id,
      shape: el.type as ShapeKind,
      x: patch.x ?? el.x,
      y: patch.y ?? el.y,
      width: patch.width ?? el.width,
      height: patch.height ?? el.height,
      label: patch.label ?? labelOf(el, work),
      base: styleOf(el),
    });
    const textId = oldText?.id ?? text?.id;
    const others = (el.boundElements ?? []).filter((b) => b.type !== "text");
    // customData (a node's codePaths and childCanvas) is not geometry or style: it must survive the rebuild.
    put({ ...container, ...(el.customData ? { customData: el.customData } : {}), boundElements: [...(textId ? [{ id: textId, type: "text" as const }] : []), ...others] } as El);
    if (text) put({ ...text, id: textId!, containerId: el.id, frameId: el.frameId } as El);
    if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) geometryChanged.add(el.id);
  };

  const rebuildArrow = (a: El, label = labelOf(a, work), path?: readonly (readonly [number, number])[]) => {
    if (!isArrow(a)) return;
    const from = a.startBinding && work.get(a.startBinding.elementId);
    const to = a.endBinding && work.get(a.endBinding.elementId);
    if (!from || !to || from.isDeleted || to.isDeleted) return;
    const oldText = boundText(a, work);
    const built = buildArrow({ id: a.id, from, to, label, bothEnds: !!a.startArrowhead, plain: !a.startArrowhead && !a.endArrowhead, path, base: styleOf(a) });
    const arrow = built.find((e) => e.id === a.id)!;
    const text = built.find((e) => e.type === "text");
    const textId = oldText?.id ?? text?.id;
    if (oldText && !text) put({ ...oldText, isDeleted: true });
    put({ ...arrow, ...(a.customData ? { customData: a.customData } : {}), boundElements: text ? [{ id: textId!, type: "text" }] : [] } as El);
    if (text) put({ ...text, id: textId!, containerId: a.id } as El);
  };

  const remove = (id: string) => {
    const el = work.get(id)!;
    put({ ...el, isDeleted: true });
    const t = boundText(el, work);
    if (t) put({ ...t, isDeleted: true });
  };

  const describeArrow = (a: El) =>
    isArrow(a) ? `箭头 ${a.startBinding ? name(a.startBinding.elementId) : "?"} → ${a.endBinding ? name(a.endBinding.elementId) : "?"}` : a.id;

  /** Library components move / disappear as a whole (root + members). */
  const shiftLibrary = (root: El, dx: number, dy: number) => {
    for (const m of libraryMembers(root, work.values())) put({ ...m, x: m.x + dx, y: m.y + dy });
    put({ ...root, x: root.x + dx, y: root.y + dy });
    geometryChanged.add(root.id);
  };

  const exec = (o: Op) => {
    switch (o.op) {
      case "update_text": {
        const el = work.get(o.id)!;
        const prev = labelOf(el, work);
        const lib = libraryMeta(el);
        if (lib) {
          const old = lib.label ? work.get(lib.label) : undefined;
          const text = caption(o.text, el, lib.group);
          if (old && !old.isDeleted) put({ ...old, text: o.text, originalText: o.text, width: text.width, height: text.height, x: text.x } as El);
          else {
            put(text);
            put({ ...el, customData: { agora: { ...lib, label: text.id } } } as El);
          }
        } else if (el.type === "frame") put({ ...el, name: o.text });
        else if (isArrow(el)) rebuildArrow(el, o.text);
        else rebuildShape(el, { label: o.text });
        summary.push(`改文字 ${prev ? `「${prev}」` : describeArrow(el)} → 「${o.text}」`);
        break;
      }
      case "move": {
        const el = work.get(o.id)!;
        for (const a of arrowsOf(el.id, [...work.values()])) routed.delete(a.id);
        const dx = o.x - el.x, dy = o.y - el.y;
        if (libraryMeta(el)) shiftLibrary(el, dx, dy);
        else if (el.type === "frame") {
          put({ ...el, x: o.x, y: o.y });
          for (const c of [...work.values()]) if (c.frameId === el.id && isShape(c) && !c.isDeleted) rebuildShape(c, { x: c.x + dx, y: c.y + dy });
        } else rebuildShape(el, { x: o.x, y: o.y });
        summary.push(`移动 ${name(o.id)} → (${Math.round(o.x)}, ${Math.round(o.y)})`);
        break;
      }
      case "resize": {
        const el = work.get(o.id)!;
        for (const a of arrowsOf(el.id, [...work.values()])) routed.delete(a.id);
        if (el.type === "frame") put({ ...el, width: o.width, height: o.height });
        else rebuildShape(el, { width: o.width, height: o.height });
        summary.push(`调整尺寸 ${name(o.id)} → ${Math.round(o.width)}×${Math.round(o.height)}`);
        break;
      }
      case "add_shape": {
        const width = o.width ?? NODE_SIZE.width, height = o.height ?? NODE_SIZE.height;
        // Same spacing rule as library components: never on top of, or within MIN_GAP of,
        // another node / component / frame border — nudged to the nearest clear spot.
        const at = clearSpot({ x: o.x, y: o.y, w: width, h: height }, obstaclesFor(work.values(), { frameId: o.frameId ?? null }), ["below", "right", "left", "above"]);
        const els = buildShape({
          id: o.ref,
          shape: o.shape,
          x: at.x,
          y: at.y,
          width,
          height,
          label: o.text,
          base: { frameId: o.frameId ?? null },
        });
        for (const e of els) put({ ...e, frameId: o.frameId ?? null } as El);
        geometryChanged.add(o.ref);
        const moved = at.x !== o.x || at.y !== o.y ? `（为留出间距移到 (${Math.round(at.x)}, ${Math.round(at.y)})）` : "";
        summary.push(`新增 ${o.text}${o.frameId ? `（在 ${name(o.frameId)} 内）` : ""}${moved}`);
        break;
      }
      case "add_arrow": {
        let id = o.ref ?? `e-${o.from}-${o.to}`;
        while (work.has(id)) id += "-2";
        const built = buildArrow({ id, from: work.get(o.from)!, to: work.get(o.to)!, label: o.text, bothEnds: o.bothEnds, plain: o.plain, path: o.path });
        for (const e of built) put(e);
        if (o.path) routed.add(id);
        summary.push(`新增箭头 ${name(o.from)} ${o.plain ? "—" : o.bothEnds ? "↔" : "→"} ${name(o.to)}${o.text ? `「${o.text}」` : ""}`);
        break;
      }
      case "add_junction": {
        for (const e of buildJunction({ id: o.ref, x: o.x, y: o.y })) put(e);
        summary.push("新增汇合点");
        break;
      }
      case "route": {
        const a = work.get(o.id)!;
        rebuildArrow(a, labelOf(a, work), o.path ?? undefined);
        if (o.path) routed.add(a.id);
        else routed.delete(a.id);
        summary.push(`${describeArrow(a)} ${o.path ? "改走折线" : "改回直线"}`);
        break;
      }
      case "insert_library_item": {
        const item = library.get(o.item)!;
        const els = instantiate(item, { ref: o.ref, target: o.near && work.get(o.near.id), side: o.near?.side, gap: o.near?.gap, at: o.at, width: o.width, label: o.label, frameId: o.frameId, obstacles: [...work.values()] });
        for (const e of els) put(e);
        geometryChanged.add(o.ref);
        const meta = libraryMeta(els[0])!;
        const where = o.near ? `（${name(o.near.id)} ${{ right: "右侧", left: "左侧", above: "上方", below: "下方" }[o.near.side]}）` : "";
        const caption = meta.label ? `标注「${o.label}」` : meta.droppedLabel ? `（组件自带文字，未加标注「${meta.droppedLabel}」）` : "";
        summary.push(`插入素材「${item.name || item.library}」${caption}${where} · ${item.library}`);
        break;
      }
      case "delete": {
        const el = work.get(o.id)!;
        const label = name(o.id);
        if (libraryMeta(el)) for (const m of libraryMembers(el, work.values())) put({ ...m, isDeleted: true });
        remove(o.id);
        if (isArrow(el)) summary.push(`删除${describeArrow(el)}${label === el.id ? "" : `「${label}」`}`);
        else {
          if (el.type === "frame") for (const c of [...work.values()]) if (c.frameId === el.id) put({ ...c, frameId: null });
          // Arrows stay (like deleting in the editor) but lose the binding to the deleted end.
          for (const a of arrowsOf(el.id, [...work.values()]))
            put({
              ...a,
              startBinding: a.startBinding?.elementId === el.id ? null : a.startBinding,
              endBinding: a.endBinding?.elementId === el.id ? null : a.endBinding,
            } as El);
          summary.push(`删除 ${label}`);
        }
        break;
      }
    }
  };
  for (const o of plan.ops) exec(o);

  // Invariants the editor would normally maintain on user edits:
  // 1. arrows bound to moved/resized shapes are re-routed;
  for (const id of geometryChanged) for (const a of arrowsOf(id, [...work.values()])) if (!routed.has(a.id)) rebuildArrow(work.get(a.id)!);
  // 2. frames grow to contain their children (Excalidraw clips children to the frame);
  for (const f of [...work.values()].filter((e) => e.type === "frame" && !e.isDeleted)) {
    const kids = [...work.values()].filter((c) => c.frameId === f.id && isShape(c) && !c.isDeleted);
    if (!kids.length) continue;
    const x0 = Math.min(f.x, ...kids.map((k) => k.x - FRAME_PAD)), y0 = Math.min(f.y, ...kids.map((k) => k.y - FRAME_PAD));
    const x1 = Math.max(f.x + f.width, ...kids.map((k) => k.x + k.width + FRAME_PAD));
    const y1 = Math.max(f.y + f.height, ...kids.map((k) => k.y + k.height + FRAME_PAD));
    if (x0 !== f.x || y0 !== f.y || x1 !== f.x + f.width || y1 !== f.y + f.height) put({ ...f, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  // 3. each shape's boundElements lists exactly its label and the live arrows bound to it.
  for (const s of [...work.values()]) {
    if (!isShape(s) || s.isDeleted) continue;
    const text = (s.boundElements ?? []).filter((b) => b.type === "text");
    const want = [...text, ...arrowsOf(s.id, [...work.values()]).map((a) => ({ id: a.id, type: "arrow" as const }))];
    const have = s.boundElements ?? [];
    if (want.length !== have.length || want.some((w, i) => w.id !== have[i].id)) put({ ...s, boundElements: want });
  }

  const before = new Map<string, El | null>();
  const after = new Map<string, number>();
  for (const id of changed) {
    const o = orig.get(id);
    const el = { ...work.get(id)!, version: (o?.version ?? 0) + 1, versionNonce: nonce(), updated: Date.now() } as El;
    work.set(id, el);
    before.set(id, o ?? null);
    after.set(id, el.version);
  }
  return { scene: order.map((id) => work.get(id)!), summary, batch: { before, after } };
}

/** Inverse of a batch. Refuses when anything the batch touched has changed since. */
export function undoBatch(scene: Scene, batch: Batch): { scene?: El[]; stale: string[] } {
  const map = byId(scene);
  const stale = [...batch.after].filter(([id, v]) => map.get(id)?.version !== v).map(([id]) => id);
  if (stale.length) return { stale };
  const next = scene.map((el) => {
    if (!batch.before.has(el.id)) return el;
    const prev = batch.before.get(el.id);
    const base = prev ?? { ...el, isDeleted: true };
    return { ...base, version: el.version + 1, versionNonce: nonce(), updated: Date.now() } as El;
  });
  return { scene: next, stale };
}
