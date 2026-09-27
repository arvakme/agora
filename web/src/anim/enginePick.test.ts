// Turn pre-planning: Excalidraw is the only engine; the step exists only for the asset question.
import { describe, expect, it } from "vitest";
import { pickEngine } from "./enginePick.ts";

describe("pickEngine", () => {
  it("always Excalidraw, with nothing to show when no asset is mentioned", () => {
    for (const request of ["把这两个框上下对齐", "用动画演示冒泡排序 [5,3,1]", "tldraw 多页演示"]) {
      const p = pickEngine({ request, libraryHits: 0 });
      expect(p.engine).toBe("excalidraw");
      expect(p.wantsAssets).toBe(false);
      expect(p.reason).toBe("");
    }
  });

  it("asset requests decide library use; no tldraw / license wording anywhere", () => {
    const hit = pickEngine({ request: "在后端右边加一个 Kafka 图标", libraryHits: 3 });
    expect(hit).toMatchObject({ kind: "static", wantsAssets: true, useAssets: true });
    const miss = pickEngine({ request: "加一个图标", libraryHits: 0 });
    expect(miss.useAssets).toBe(true); // the planner may still search with better keywords
    const anim = pickEngine({ request: "用动画演示 BFS，节点用图标", libraryHits: 5 });
    expect(anim).toMatchObject({ kind: "animation", useAssets: false });
    for (const p of [hit, miss, anim]) expect(p.reason).not.toMatch(/tldraw|license/i);
  });
});
