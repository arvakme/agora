// Unit tests for validatePlan / referencedIds — the referential gate every model plan
// must pass before it touches the canvas. Pure logic; runs under vitest in node.
import { describe, expect, it } from "vitest";
import { referencedIds, validatePlan, type SceneIndex } from "./ops.ts";

const scene: SceneIndex = {
  kind: (id) => (id === "a" || id === "b" ? "shape" : id === "f1" ? "frame" : undefined),
  libraryItem: (id) => id === "lib:kafka",
};

describe("validatePlan", () => {
  it("accepts a minimal valid plan", () => {
    const { plan, errors } = validatePlan({ ops: [{ op: "update_text", id: "a", text: "Redis" }] }, scene);
    expect(errors).toEqual([]);
    expect(plan?.ops).toHaveLength(1);
  });

  it("rejects non-plan payloads and empty ops", () => {
    expect(validatePlan(null, scene).errors[0]).toContain("ops");
    expect(validatePlan({ ops: [] }, scene).errors[0]).toContain("为空");
  });

  it("rejects unknown ops and missing/extra fields", () => {
    const { errors } = validatePlan({ ops: [{ op: "explode", id: "a" }] }, scene);
    expect(errors[0]).toContain("未知");
    const bad2 = validatePlan({ ops: [{ op: "move", id: "a", x: 1, y: 2, extra: true }] }, scene);
    expect(bad2.errors[0]).toContain("多余字段");
    const bad3 = validatePlan({ ops: [{ op: "update_text", id: "a" }] }, scene);
    expect(bad3.errors[0]).toContain("缺少 text");
  });

  it("rejects references to missing elements and wrong kinds", () => {
    const { errors } = validatePlan({ ops: [{ op: "move", id: "ghost", x: 0, y: 0 }] }, scene);
    expect(errors[0]).toContain("不存在");
    const wrong = validatePlan({ ops: [{ op: "resize", id: "f1", width: 100, height: 50 }] }, scene);
    expect(wrong.errors).toEqual([]); // frames may resize
    const wrong2 = validatePlan({ ops: [{ op: "add_arrow", from: "f1", to: "a" }] }, scene);
    expect(wrong2.errors[0]).toContain("类型 frame 不支持");
  });

  it("tracks deletes: later ops cannot touch deleted ids", () => {
    const { errors } = validatePlan(
      { ops: [{ op: "delete", id: "a" }, { op: "update_text", id: "a", text: "x" }] },
      scene,
    );
    expect(errors[0]).toContain("不存在");
  });

  it("tracks refs: add_shape creates an id add_arrow can bind", () => {
    const ok = validatePlan(
      {
        ops: [
          { op: "add_shape", ref: "redis", shape: "rectangle", text: "Redis", x: 10, y: 20 },
          { op: "add_arrow", from: "a", to: "redis" },
        ],
      },
      scene,
    );
    expect(ok.errors).toEqual([]);
    const dup = validatePlan({ ops: [{ op: "add_shape", ref: "a", shape: "rectangle", text: "x", x: 0, y: 0 }] }, scene);
    expect(dup.errors[0]).toContain("重名");
    const badRef = validatePlan({ ops: [{ op: "add_shape", ref: "A Bad Ref", shape: "rectangle", text: "x", x: 0, y: 0 }] }, scene);
    expect(badRef.errors[0]).toContain("ref");
  });

  it("insert_library_item requires near xor at and a real catalog id", () => {
    const noPos = validatePlan({ ops: [{ op: "insert_library_item", ref: "k1", item: "lib:kafka" }] }, scene);
    expect(noPos.errors[0]).toContain("near 或 at");
    const both = validatePlan(
      { ops: [{ op: "insert_library_item", ref: "k1", item: "lib:kafka", near: { id: "a", side: "right" }, at: { x: 0, y: 0 } }] },
      scene,
    );
    expect(both.errors[0]).toContain("near 或 at");
    const badItem = validatePlan({ ops: [{ op: "insert_library_item", ref: "k1", item: "lib:nope", at: { x: 0, y: 0 } }] }, scene);
    expect(badItem.errors[0]).toContain("素材库");
    const ok = validatePlan({ ops: [{ op: "insert_library_item", ref: "k1", item: "lib:kafka", near: { id: "a", side: "right", gap: 60 } }] }, scene);
    expect(ok.errors).toEqual([]);
  });

  it("enforces numeric ranges", () => {
    const { errors } = validatePlan({ ops: [{ op: "move", id: "a", x: 99999, y: 0 }] }, scene);
    expect(errors[0]).toContain("画布范围");
  });
});

describe("referencedIds", () => {
  it("collects every existing id the plan reads or writes", () => {
    const plan = validatePlan(
      {
        ops: [
          { op: "update_text", id: "a", text: "x" },
          { op: "add_arrow", from: "a", to: "b" },
          { op: "add_shape", ref: "n1", shape: "rectangle", text: "x", x: 0, y: 0, frameId: "f1" },
        ],
      },
      scene,
    ).plan!;
    expect([...referencedIds(plan)].sort()).toEqual(["a", "b", "f1"]);
  });
});
