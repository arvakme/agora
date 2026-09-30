// Nested canvases: links follow the child's id, breadcrumbs come from the parents' nodes, code
// paths roll up to the node that opens a child, and a child goes stale after its code changes.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene.ts";
import { elementFor } from "../pointer/codeLinks.ts";
import { ancestry, childOf, descendants, effectiveLinks, openThreads, parentIndex, staleness, wouldCycle, type Scenes } from "./graph.ts";

const box = (id: string, extra: { child?: string; paths?: string[]; updated?: number; deleted?: boolean } = {}) =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    isDeleted: !!extra.deleted,
    groupIds: [],
    updated: extra.updated ?? 1000,
    customData: { ...(extra.child ? { childCanvas: extra.child } : {}), ...(extra.paths ? { codePaths: extra.paths } : {}) },
  }) as unknown as El;

// 总架构 (root) › 后端 (be) › 订单模块 (orders)
const scenes = (): Map<string, El[]> =>
  new Map([
    ["root", [box("web", { paths: ["web/**"] }), box("backend", { child: "be", paths: ["server/**"] })]],
    ["be", [box("orders", { child: "orders", paths: ["server/orders/**"] }), box("users", { paths: ["server/users/**"] })]],
    ["orders", [box("api", { paths: ["server/orders/api.py"], updated: 5000 }), box("repo", { paths: ["server/orders/repo.py"], updated: 5000 })]],
  ]);

describe("links follow ids", () => {
  it("reads the child id from customData, ignores deleted nodes and missing canvases", () => {
    const s = scenes();
    expect(childOf(s.get("root")![1])).toBe("be");
    expect(childOf(s.get("root")![0])).toBeNull();
    s.set("root", [...s.get("root")!, box("ghost", { child: "nowhere" }), box("gone", { child: "be2", deleted: true })]);
    s.set("be2", []);
    const idx = parentIndex(s);
    expect(idx.get("be")).toEqual({ canvasId: "root", elementId: "backend" });
    expect(idx.has("nowhere")).toBe(false);
    expect(idx.has("be2")).toBe(false);
  });

  it("builds the breadcrumb from the parents, root first", () => {
    const idx = parentIndex(scenes());
    expect(ancestry("orders", idx)).toEqual(["root", "be", "orders"]);
    expect(ancestry("root", idx)).toEqual(["root"]);
  });

  it("survives a loop someone drew by hand", () => {
    const s = scenes();
    s.set("orders", [...s.get("orders")!, box("loop", { child: "root" })]);
    const idx = parentIndex(s);
    const chain = ancestry("orders", idx);
    expect(new Set(chain).size).toBe(chain.length);
    expect(chain.at(-1)).toBe("orders");
  });

  it("refuses links that would make a loop", () => {
    const s = scenes();
    expect(wouldCycle("orders", "root", s)).toBe(true);
    expect(wouldCycle("be", "be", s)).toBe(true);
    expect(wouldCycle("root", "orders", s)).toBe(false);
    expect([...descendants("root", s)].sort()).toEqual(["be", "orders"]);
  });
});

describe("pointer roll-up", () => {
  it("lights the parent node for a file only the child claims, and the finer node inside", () => {
    const s = scenes();
    // The overview node has no paths of its own: the child's globs still count for it.
    s.set("root", [box("web", { paths: ["web/**"] }), box("backend", { child: "be" })]);
    expect(elementFor("server/orders/api.py", effectiveLinks("root", s))?.link.id).toBe("backend");
    expect(elementFor("server/orders/api.py", effectiveLinks("be", s))?.link.id).toBe("orders");
    expect(elementFor("server/orders/api.py", effectiveLinks("orders", s))?.link.id).toBe("api");
    expect(elementFor("web/app.ts", effectiveLinks("root", s))?.link.id).toBe("web");
    const backend = effectiveLinks("root", s).find((l) => l.id === "backend")!;
    expect(backend.own).toEqual([]);
    expect(backend.child).toBe("be");
  });
});

describe("staleness", () => {
  const w = (path: string, at: number) => ({ path, op: "edit" as const, at, toolId: `t${at}`, turn: 1 });
  it("flags writes to the child's code after it was drawn, and which nodes they hit", () => {
    const st = staleness("orders", scenes(), [w("server/orders/api.py", 4000), w("server/orders/api.py", 6000), w("web/x.ts", 7000)]);
    expect(st.files.map((f) => f.at)).toEqual([6000]);
    expect(st.nodes).toEqual(["api"]);
  });
  it("counts the parent node's own paths as the child's area; a review clears it", () => {
    const st = staleness("orders", scenes(), [w("server/orders/new.py", 6000)], ["server/orders/**"]);
    expect(st.files).toHaveLength(1);
    expect(staleness("orders", scenes(), [w("server/orders/new.py", 6000)], ["server/orders/**"], 6500).files).toHaveLength(0);
  });
});

describe("openThreads", () => {
  it("counts unresolved threads that still show something", () => {
    expect(
      openThreads([
        { resolved: false, messages: [{}] },
        { resolved: true, messages: [{}] },
        { resolved: false, deleted: true, messages: [] },
        { resolved: false, messages: [{ deleted: true }] },
      ]),
    ).toBe(1);
  });
});

export type { Scenes };
