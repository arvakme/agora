// Turn planning before generation: should the asset library be used? Excalidraw is the only
// engine (the AnimEngine adapter in player.ts stays the seam), so there is no engine to
// choose — the session only shows this step when the request raises the asset-library
// question. Pure rules, no model call. Animations are not routed here: making one is a
// capability of the agora-canvas skill that the session's agent uses when asked.
export type Engine = "excalidraw";
export type EnginePick = {
  engine: Engine;
  /** The request names an icon/asset/logo — the library question is live. */
  wantsAssets: boolean;
  /** Shown in the session step; empty when there is nothing to decide. */
  reason: string;
};

export const ENTITY_ASSETS = /图标|素材|logo|插图|icon|asset|illustration/i;

export function pickEngine(input: {
  request: string;
  /** How many asset-library items match the request (0 when not looked up). */
  libraryHits: number;
}): EnginePick {
  const wantsAssets = ENTITY_ASSETS.test(input.request);
  const reason = !wantsAssets
    ? ""
    : input.libraryHits > 0
      ? `素材库命中 ${input.libraryHits} 个，由 Agent 搜索并选用组件`
      : "素材库未命中，Agent 可换关键词再搜，找不到就画基础形状";
  return { engine: "excalidraw", wantsAssets, reason };
}
