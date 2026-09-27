// canvas-engine-pick (docs/engine-adapter.md §6): decide the engine and whether to use the
// asset library before generating. Rules are table lookups plus cheap heuristics — no model
// call. Only when rules 3–5 are genuinely ambiguous (and tldraw is available) does it ask
// the generation call itself to include an `engine` field (`askModel`).
export type Engine = "excalidraw" | "tldraw";
export type EnginePick = {
  engine: Engine;
  useAssets: boolean;
  reason: string;
  /** Which rule decided (1–6). */
  rule: number;
  kind: "animation" | "static";
  estimate: { elements: number; moving: number; movingEdges: boolean };
  /** Rules 3–5 undecided: let the generation call add `engine` (only possible with tldraw available). */
  askModel: boolean;
};

export const ANIMATION = /动画|动效|演示.*(过程|步骤)|animat|step[- ]by[- ]step/i;
const MOVING_EDGES = /树.*旋转|旋转|红黑树|AVL|平衡树|布局演化|力导向|指针.*(重连|反转|改)|链表.*(反转|插入|删除)|rotation|rewir|force[- ]directed|linked list/i;
const TLDRAW_ONLY = /tldraw|原生补间|多页演示|multi-page/i;
const ENTITY_ASSETS = /图标|素材|logo|插图|icon|asset|illustration/i;
const MAX_MOVING = 60;

/** Heuristic size estimate from the request text (array literals, "N 个节点", "N nodes"). */
export function estimate(request: string) {
  const arrays = [...request.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split(/[,，\s]+/).filter(Boolean).length);
  const counted = [...request.matchAll(/(\d+)\s*(个|nodes?|elements?|项|元素)/gi)].map((m) => Number(m[1]));
  const elements = Math.max(0, ...arrays, ...counted) || 8;
  const movingEdges = MOVING_EDGES.test(request);
  // Sorting moves ≤ 2 per step; traversals move pointers; layout changes move everything.
  const moving = movingEdges || /布局|layout|全部移动|shuffle|洗牌/i.test(request) ? elements : Math.min(elements, 4);
  return { elements, moving, movingEdges };
}

export function pickEngine(input: {
  request: string;
  /** Engine of the canvas the result goes onto; null for a brand-new canvas. */
  existingEngine: Engine | null;
  canvasTitle?: string;
  tldrawAvailable: boolean;
  /** How many asset-library items match the named entities (0 when not looked up). */
  libraryHits: number;
}): EnginePick {
  const kind = ANIMATION.test(input.request) ? "animation" : "static";
  const est = estimate(input.request);
  const wantsAssets = ENTITY_ASSETS.test(input.request);
  const useAssets = wantsAssets && input.libraryHits > 0;
  const assetsNote =
    kind === "static" ? "" : useAssets ? "，节点用素材库组件" : wantsAssets ? "，素材库未命中，用基础形状" : "，算法动画用基础形状（颜色和位置变化更易读）";
  const noLicense = input.tldrawAvailable ? "" : "；未配置 tldraw license，tldraw 不可选";
  const size = kind === "animation" ? `预计 ${est.elements} 个元素、每步最多移动 ${est.moving} 个` : "";
  const out = (engine: Engine, rule: number, why: string, askModel = false): EnginePick => ({
    engine,
    useAssets: kind === "static" ? wantsAssets : useAssets,
    reason: [why + (rule !== 2 ? noLicense : ""), size].filter(Boolean).join("；") + assetsNote,
    rule,
    kind,
    estimate: est,
    askModel,
  });
  const name = (e: Engine) => (e === "excalidraw" ? "Excalidraw" : "tldraw");

  // 1. Editing an existing canvas keeps its engine.
  if (input.existingEngine)
    return out(input.existingEngine, 1, `在已有画布${input.canvasTitle ? `「${input.canvasTitle}」` : ""}上${kind === "animation" ? "加动画区域" : "改图"}，沿用该画布的引擎 ${name(input.existingEngine)}`);
  // 2. No tldraw license → Excalidraw (degrade: ≤ 60 moves per step, jump beyond that).
  if (!input.tldrawAvailable)
    return out("excalidraw", 2, `未配置 tldraw license，使用 Excalidraw${est.moving > MAX_MOVING ? `（每步移动超过 ${MAX_MOVING} 个时改为跳变）` : ""}`);
  // 3. Static diagrams.
  if (kind === "static") return out("excalidraw", 3, "静态图默认 Excalidraw");
  // 4. Animations tldraw handles better.
  if (est.moving > MAX_MOVING) return out("tldraw", 4, `单步同时移动约 ${est.moving} 个元素，超过 ${MAX_MOVING}，tldraw 帧时间更稳`);
  if (est.movingEdges) return out("tldraw", 4, "有大量会移动的连线，tldraw 的绑定会自动跟随");
  if (TLDRAW_ONLY.test(input.request)) return out("tldraw", 4, "请求用到 tldraw 独有的能力");
  // 5. Ordinary algorithm animations.
  if (/排序|查找|搜索|遍历|BFS|DFS|状态机|sort|search|travers|state machine/i.test(input.request))
    return out("excalidraw", 5, "排序、查找、小图遍历类动画用 Excalidraw（颜色渐变、弧线交换、可随时暂停拖动）");
  // 6. Unsure: Excalidraw, and let the generation call weigh in.
  return out("excalidraw", 6, "拿不准，先用 Excalidraw；脚本与引擎无关，可改用 tldraw 重新生成", true);
}
