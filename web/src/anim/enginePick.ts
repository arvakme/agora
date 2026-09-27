// Turn planning before generation: is this an animation, and should the asset library be
// used? Excalidraw is the only engine (the AnimEngine adapter in player.ts stays the seam),
// so there is no engine to choose — the session only shows this step when the request
// actually raises the asset-library question. Pure rules, no model call.
export type Engine = "excalidraw";
export type EnginePick = {
  engine: Engine;
  kind: "animation" | "static";
  /** The request names an icon/asset/logo — the library question is live. */
  wantsAssets: boolean;
  /** Use library components: static edits only (animation scripts are drawn from basic shapes). */
  useAssets: boolean;
  /** Shown in the session step; empty when there is nothing to decide. */
  reason: string;
};

export const ANIMATION = /动画|动效|演示.*(过程|步骤)|animat|step[- ]by[- ]step/i;
export const ENTITY_ASSETS = /图标|素材|logo|插图|icon|asset|illustration/i;

export function pickEngine(input: {
  request: string;
  /** How many asset-library items match the request (0 when not looked up). */
  libraryHits: number;
}): EnginePick {
  const kind = ANIMATION.test(input.request) ? "animation" : "static";
  const wantsAssets = ENTITY_ASSETS.test(input.request);
  const hits = input.libraryHits > 0;
  const useAssets = wantsAssets && kind === "static";
  const reason = !wantsAssets
    ? ""
    : kind === "animation"
      ? "动画脚本只用基础形状，素材库组件不参与动画"
      : hits
        ? `素材库命中 ${input.libraryHits} 个，由 Agent 搜索并选用组件`
        : "素材库未命中，Agent 可换关键词再搜，找不到就画基础形状";
  return { engine: "excalidraw", kind, wantsAssets, useAssets, reason };
}
