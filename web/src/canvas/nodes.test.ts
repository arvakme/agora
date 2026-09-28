// A grouped node (an inserted library icon, or shapes the person grouped) is one node: selecting
// any of it, double-clicking anywhere on it, and naming it with --node all reach the element that
// carries its code paths and its child link — the id the model view lists.
import { describe, expect, it } from "vitest";
import { ancestry, childOf, effectiveLinks, withChildLink } from "../nested/graph.ts";
import { blankChild, nested } from "../nested/store.ts";
import type { El } from "./scene.ts";
import { childNodeAt, nodeBox, nodeOf, resolveNode, selectedNode } from "./nodes.ts";

let n = 0;
const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({ id, type, x, y, width: w, height: h, isDeleted: false, groupIds: [], version: 1, updated: 1, seed: n++, ...extra }) as unknown as El;

// The demo's 「API 服务」: a transparent root carrying the icon's data, the icon's parts in nested
// groups, and a free label in the icon's group. Plus Redis (same shape) and a plain box with a label.
const API = "lib-api-c7kyx76q";
const scene = (): El[] => [
  el("api", "rectangle", 360, 210, 80, 101, { groupIds: [API], customData: { agora: { group: API, label: "api-label", library: "net#5", name: "Server" }, codePaths: ["server/**"] } }),
  el("api-h1f9llad", "rectangle", 360, 210, 80, 101, { groupIds: ["g-ve71qy8l", API] }),
  el("api-0ckl4bra", "line", 364, 273, 74, 61, { groupIds: ["g-7q0ezcue", "g-umhrcw2c", "g-ve71qy8l", API], points: [[0, 0], [74, 61]] }),
  el("api-rnifsm7u", "line", 363, 233, 74, 61, { groupIds: ["g-oz17ic9o", "g-umhrcw2c", "g-ve71qy8l", API], points: [[0, 0], [74, 61]] }),
  el("api-label", "text", 373, 317, 54, 16, { groupIds: [API], text: "API 服务" }),
  el("cache", "rectangle", 506, 446, 100, 79, { groupIds: ["lib-cache"], customData: { agora: { group: "lib-cache", label: "cache-label", library: "d#5", name: "redis" } } }),
  el("cache-d1", "diamond", 508, 477, 98, 40, { groupIds: ["g-t", "lib-cache"] }),
  el("cache-label", "text", 523, 531, 68, 16, { groupIds: ["lib-cache"], text: "Redis 缓存" }),
  el("box", "rectangle", 0, 0, 120, 60, { boundElements: [{ type: "text", id: "box-t" }] }),
  el("box-t", "text", 10, 20, 100, 20, { containerId: "box", text: "网关" }),
  // A group the person made: a big card, a small badge and a caption.
  el("card", "rectangle", 0, 400, 200, 120, { groupIds: ["g-user"] }),
  el("badge", "ellipse", 170, 390, 30, 30, { groupIds: ["g-user"] }),
  el("caption", "text", 20, 530, 100, 16, { groupIds: ["g-user"], text: "订单卡片" }),
  el("arrow", "arrow", 120, 30, 240, 200, { points: [[0, 0], [240, 200]] }),
];
const setup = () => {
  const s = scene();
  return { s, map: new Map(s.map((e) => [e.id, e])) };
};
const ids = (s: El[], group: string) => s.filter((e) => e.groupIds.includes(group)).map((e) => e.id);

describe("menu target: a selection stands for one node", () => {
  it("the whole library icon selected (what a click does) is its root", () => {
    const { s, map } = setup();
    expect(ids(s, API)).toHaveLength(5);
    expect(selectedNode(ids(s, API), map, s)?.id).toBe("api");
    expect(selectedNode(ids(s, "lib-cache"), map, s)?.id).toBe("cache");
  });
  it("a part or the label alone also stands for the icon; a box's label for its box", () => {
    const { s, map } = setup();
    expect(selectedNode(["api-label"], map, s)?.id).toBe("api");
    expect(selectedNode(["api-0ckl4bra"], map, s)?.id).toBe("api");
    expect(selectedNode(["box", "box-t"], map, s)?.id).toBe("box");
    expect(selectedNode(["box-t"], map, s)?.id).toBe("box");
  });
  it("two nodes, or nothing that is a node, get no menu; a loose arrow alongside doesn't count", () => {
    const { s, map } = setup();
    expect(selectedNode([...ids(s, API), "box"], map, s)).toBeUndefined();
    expect(selectedNode(["arrow"], map, s)).toBeUndefined();
    expect(selectedNode(["box", "arrow"], map, s)?.id).toBe("box");
  });
  it("a group the person made is one node: its largest shape, unless another already has the data", () => {
    const { s, map } = setup();
    expect(selectedNode(ids(s, "g-user"), map, s)?.id).toBe("card");
    const withChild = s.map((e) => (e.id === "badge" ? ({ ...e, customData: { childCanvas: "c9" } } as El) : e));
    expect(selectedNode(ids(withChild, "g-user"), new Map(withChild.map((e) => [e.id, e])), withChild)?.id).toBe("badge");
  });
  it("inside a group being edited, its shapes are separate nodes (library icons stay whole)", () => {
    const { s, map } = setup();
    expect(selectedNode(["badge"], map, s, "icons")?.id).toBe("badge");
    expect(selectedNode(["api-0ckl4bra"], map, s, "icons")?.id).toBe("api");
    expect(nodeOf(map.get("caption"), map, s, "icons")?.id).toBe("card"); // a grouped caption: its group's node
  });
});

describe("the child link lives where the code paths are", () => {
  it("writes childCanvas on the icon's root, next to its codePaths, and reads it back", () => {
    const { s, map } = setup();
    const node = selectedNode(ids(s, API), map, s)!;
    const next = withChildLink(s, node.id, "c-api", 42)!;
    const root = next.find((e) => e.id === "api")!;
    expect(root.customData).toMatchObject({ childCanvas: "c-api", codePaths: ["server/**"], agora: { group: API } });
    expect(root.version).toBe(2);
    expect(root.updated).toBe(42);
    expect(childOf(root)).toBe("c-api");
    expect(next.filter((e) => childOf(e))).toHaveLength(1); // no part carries it
    expect(withChildLink(next, "api", "c-api")).toBeNull(); // unchanged
    const unlinked = withChildLink(next, "api", null)!.find((e) => e.id === "api")!;
    expect(childOf(unlinked)).toBeNull();
    expect(unlinked.customData).toMatchObject({ codePaths: ["server/**"] });
  });
  it("the pointer rolls a child's paths up to the icon on the overview", () => {
    const s = withChildLink(scene(), "api", "c-api")!;
    const all = new Map<string, El[]>([["c1", s], ["c-api", [el("orders", "rectangle", 0, 0, 10, 10, { customData: { codePaths: ["server/orders/**"] } })]]]);
    const link = effectiveLinks("c1", all).find((l) => l.id === "api")!;
    expect(link).toMatchObject({ label: "API 服务", own: ["server/**"], child: "c-api" });
    expect(link.globs).toContain("server/orders/**");
  });
});

describe("entry marker and double-click cover the whole icon", () => {
  it("the node box spans the icon and its label (marker goes to its bottom-right)", () => {
    const { s, map } = setup();
    const b = nodeBox(map.get("api")!, map, s);
    expect(b.x).toBe(360);
    expect(b.y + b.h).toBe(334); // the lowest part (a stroke at 273+61), below the label (333) and the root rectangle (311)
  });
  it("double-click on the icon's label or a gap inside it enters; outside does not", () => {
    const s = withChildLink(scene(), "api", "c-api")!;
    const map = new Map(s.map((e) => [e.id, e]));
    expect(childNodeAt(s, map, 400, 325, childOf)?.child).toBe("c-api"); // on the label
    expect(childNodeAt(s, map, 362, 212, childOf)?.child).toBe("c-api"); // transparent corner
    expect(childNodeAt(s, map, 470, 325, childOf)).toBeNull();
    expect(childNodeAt(scene(), map, 400, 325, childOf)).toBeNull(); // no child: nothing to enter
  });
});

describe("--node resolves to the node the model view lists", () => {
  it("root id, a part, the label element, the group id, or the label text", () => {
    const s = scene();
    for (const ref of ["api", "api-h1f9llad", "api-0ckl4bra", "api-label", API, "API 服务", "api 服务"]) expect(resolveNode(ref, s)).toEqual({ id: "api" });
    expect(resolveNode("网关", s)).toEqual({ id: "box" });
    expect(resolveNode("box-t", s)).toEqual({ id: "box" });
  });
  it("a shape in a plain group stays itself (each is its own node in the model view)", () => {
    const s = scene();
    expect(resolveNode("badge", s)).toEqual({ id: "badge" });
    expect(resolveNode("g-user", s)).toEqual({ id: "card" });
    expect(resolveNode("nope", s).error).toMatch(/no box or frame/);
  });
});

describe("新建空白子图 keeps the link", () => {
  it("links before it navigates, and leaving the parent carries the link into the nesting index", async () => {
    // A fake shell standing in for App.tsx: `go` takes the leaving canvas's live scene (what the
    // real shell reads from Excalidraw) into the store, as App.go does before closing the tab.
    let live: El[] = scene();
    nested.reset([["c1", live]], { c1: "总架构" });
    const calls: string[] = [];
    const shell = {
      createChild: async (title: string) => {
        calls.push(`create ${title}`);
        nested.setScene("c-new", []);
        nested.setMeta({ ...nested.get().titles, "c-new": title }, {});
        return "c-new";
      },
      go: (from: string, to: string) => {
        calls.push(`go ${from}→${to}`);
        nested.setScene(from, live);
      },
    };
    const id = await blankChild("c1", "API 服务", (child) => {
      calls.push(`link ${child}`);
      live = withChildLink(live, "api", child)!;
    }, shell);
    expect(id).toBe("c-new");
    expect(calls).toEqual(["create API 服务", "link c-new", "go c1→c-new"]);
    const st = nested.get();
    expect(st.index.get("c-new")).toEqual({ canvasId: "c1", elementId: "api" });
    expect(ancestry("c-new", st.index)).toEqual(["c1", "c-new"]); // the breadcrumb: 总架构 › API 服务
  });
});
