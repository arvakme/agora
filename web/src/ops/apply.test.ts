// A rebuilt shape keeps everything the canvas hangs on it beyond geometry and label:
// customData carries a node's code links (codePaths) and its child canvas (childCanvas).
import { describe, expect, it, vi } from "vitest";
// Excalidraw does not load in node: a stand-in that turns a skeleton with a label into the container plus its text.
vi.mock("@excalidraw/excalidraw", () => ({
  FONT_FAMILY: {},
  ROUNDNESS: {},
  convertToExcalidrawElements: (skeletons: any[]) =>
    skeletons.flatMap(({ label, ...sk }) => {
      const textId = `${sk.id}-t`;
      const box = { version: 1, isDeleted: false, boundElements: label ? [{ id: textId, type: "text" }] : [], ...sk };
      return label ? [box, { id: textId, type: "text", text: label.text, originalText: label.text, containerId: sk.id, x: sk.x, y: sk.y, width: 10, height: 10, version: 1, isDeleted: false }] : [box];
    }),
}));

import { buildShape, type El } from "../canvas/scene";
import { applyPlan } from "./apply";
import type { Op } from "./ops";

const CUSTOM = { codePaths: ["server/**"], childCanvas: "c-api" };

function node(): El[] {
  const [box, text] = buildShape({ id: "api", shape: "rectangle", x: 0, y: 0, width: 160, height: 60, label: "API" });
  return [{ ...box, customData: CUSTOM } as El, text];
}

describe("applyPlan keeps a node's customData", () => {
  const ops: Op[] = [
    { op: "update_text", id: "api", text: "API 服务" },
    { op: "move", id: "api", x: 40, y: 50 },
    { op: "resize", id: "api", width: 220, height: 90 },
  ];
  for (const op of ops)
    it(op.op, () => {
      const { scene } = applyPlan(node(), { ops: [op] } as never);
      expect(scene.find((e) => e.id === "api")!.customData).toEqual(CUSTOM);
    });
});
