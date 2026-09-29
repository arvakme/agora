// The plan's referential rules are one file (generated/plan.rules.json) read by this side's validatePlan and by the server's
// fallback executor (server/canvas/plan_rules.py); generated/plan.cases.json is the same list of cases both sides run,
// and tests/test_plan_rules.py checks the very same expectations in Python. If the two ever disagree, one of them fails.
import { describe, expect, it } from "vitest";
import cases from "../../generated/plan.cases.json";
import rules from "../../generated/plan.rules.json";
import { validatePlan, type Kind } from "./ops.ts";

describe("plan.cases.json through validatePlan", () => {
  for (const c of cases as { name: string; scene: Record<string, Kind>; library: string[]; plan: unknown; errors: string[] }[]) {
    it(c.name, () => {
      const got = validatePlan(c.plan, { kind: (id) => c.scene[id], libraryItem: (id) => c.library.includes(id) });
      expect(got.errors).toEqual(c.errors);
      expect(!!got.plan).toBe(c.errors.length === 0);
    });
  }
});

describe("plan.rules.json is what validatePlan reads", () => {
  it("every op the rules list is one the validator knows, and the other way round", () => {
    const seen = new Set<string>();
    for (const op of Object.keys(rules.ops)) {
      const got = validatePlan({ ops: [{ op }] }, { kind: () => undefined });
      expect(got.errors.some((e) => e.includes("未知"))).toBe(false); // known
      seen.add(op);
    }
    expect(validatePlan({ ops: [{ op: "explode" }] }, { kind: () => undefined }).errors[0]).toContain("未知");
    expect([...seen].sort()).toEqual(["add_arrow", "add_junction", "add_shape", "delete", "insert_library_item", "move", "resize", "route", "update_text"]);
  });
  it("a change in the file changes the validator (the file is the rule, not a copy of it)", () => {
    const table = rules.ops.move.targets.id as string[];
    const before = validatePlan({ ops: [{ op: "move", id: "ar", x: 1, y: 1 }] }, { kind: () => "arrow" }).errors;
    expect(before).toEqual(["ops[0].id 类型 arrow 不支持 move"]);
    table.push("arrow");
    try {
      expect(validatePlan({ ops: [{ op: "move", id: "ar", x: 1, y: 1 }] }, { kind: () => "arrow" }).errors).toEqual([]);
    } finally {
      table.pop();
    }
  });
});
