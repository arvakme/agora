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

  it("asset requests raise the library question; no tldraw / license wording anywhere", () => {
    const hit = pickEngine({ request: "在后端右边加一个 Kafka 图标", libraryHits: 3 });
    expect(hit).toMatchObject({ wantsAssets: true });
    expect(hit.reason).toContain("命中 3 个");
    const miss = pickEngine({ request: "加一个图标", libraryHits: 0 });
    expect(miss.reason).toContain("换关键词"); // the planner may still search with better keywords
    for (const p of [hit, miss]) expect(p.reason).not.toMatch(/tldraw|license/i);
  });

  it("an animation request is not routed anywhere special (the agent decides via the skill)", () => {
    const p = pickEngine({ request: "用动画演示 BFS，节点用图标", libraryHits: 5 });
    expect(p).not.toHaveProperty("kind");
    expect(p.wantsAssets).toBe(true);
  });
});
