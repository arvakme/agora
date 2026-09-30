// The walking map one canvas gives the 工位视图 (./geometry.ts buildGeometry; web/docs/workstation.md
// §2): an arrow bound at both ends to linked nodes is a way between their floors — bound through a
// node's label, or through a member of a library icon's group, it still counts — and anything else
// (one end loose, or bound to something that is no linked node) is not; without a way, and to the
// 图外 tray, a trip goes over a scaffold.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import { buildGeometry, type Geometry } from "./geometry.ts";
import { OUTSIDE } from "./place.ts";
import type { Route } from "./route.ts";

const el = (x: Record<string, unknown>): El => ({ angle: 0, isDeleted: false, groupIds: [], boundElements: [], x: 0, y: 0, width: 0, height: 0, ...x }) as unknown as El;
const node = (id: string, x: number, y: number, w: number, h: number, glob: string, more: Record<string, unknown> = {}) =>
  el({ id, type: "rectangle", x, y, width: w, height: h, customData: { codePaths: [glob] }, boundElements: [{ id: `${id}-t`, type: "text" }], ...more });
const label = (id: string, on: string, x: number, y: number) => el({ id, type: "text", x, y, width: 60, height: 20, text: id, containerId: on });
const arrow = (id: string, from: string | null, to: string | null, ...p: [number, number][]) =>
  el({ id, type: "arrow", x: p[0][0], y: p[0][1], points: p.map(([x, y]) => [x - p[0][0], y - p[0][1]]), startBinding: from ? { elementId: from, focus: 0, gap: 1 } : null, endBinding: to ? { elementId: to, focus: 0, gap: 1 } : null });

// The prototype's layout (scripts/fidelity/setup.ts); MySQL is a library icon: a transparent root that
// carries the link, and a drawn body in the same group.
const SCENE: El[] = [
  node("web", 40, 230, 170, 72, "web/**"),
  label("web-t", "web", 95, 256),
  node("api", 330, 230, 200, 72, "server/**"),
  label("api-t", "api", 400, 256),
  node("db", 680, 120, 160, 64, "server/db/**", { groupIds: ["g-db"], boundElements: [], customData: { codePaths: ["server/db/**"], agora: { library: "db", name: "MySQL", group: "g-db" } } }),
  el({ id: "db-body", type: "ellipse", x: 680, y: 120, width: 160, height: 64, groupIds: ["g-db"] }),
  node("pay", 350, 450, 160, 64, "server/payments/**"),
  label("pay-t", "pay", 400, 472),
  el({ id: "note", type: "text", x: 560, y: 420, width: 60, height: 20, text: "备注" }),
  // web's label → api: the label's container is the node
  arrow("a-web-api", "web-t", "api", [210, 266], [330, 266]),
  // api → the icon's drawn body: the group's linked node
  arrow("a-api-db", "api", "db-body", [530, 252], [610, 252], [610, 152], [680, 152]),
  // not ways: one end bound to a loose text, one end loose
  arrow("a-api-note", "api", "note", [510, 302], [560, 420]),
  arrow("a-pay-none", "pay", null, [430, 450], [430, 330]),
];
const geometry = (els: El[]): Geometry => buildGeometry("c1", els, new Map(els.map((e) => [e.id, e])), new Map(), () => undefined);
const trip = (g: Geometry, a: string, b: string): Route => g.route({ place: a, at: g.dock(a) }, { place: b, at: g.dock(b) });
const scaffold = (rt: Route) => rt.legs.some((l) => l.temp) && rt.legs.filter((l) => l.kind !== "walk").every((l) => l.temp);

describe("buildGeometry: the walking map (剖面)", () => {
  const g = geometry(SCENE);

  it("an arrow from a node's label to another node is a way between them: a bridge across the gap", () => {
    const rt = trip(g, "web", "api");
    expect(rt.legs.some((l) => l.kind === "bridge" && !l.temp && l.a.y === 230)).toBe(true);
    expect(scaffold(rt)).toBe(false);
  });

  it("an arrow to a member of a library icon's group is a way to the icon's linked node: the ladder where it runs upright", () => {
    const rt = trip(g, "api", "db");
    expect(rt.legs.some((l) => l.kind === "climb" && !l.temp && l.a.x === 610)).toBe(true);
    expect(scaffold(rt)).toBe(false);
  });

  it("arrows with a loose end, or bound to something that is no linked node, are no way: a scaffold goes up instead", () => {
    expect(scaffold(trip(g, "api", "pay"))).toBe(true);
    // the same picture without the arrows: web → api is a scaffold too
    expect(scaffold(trip(geometry(SCENE.filter((e) => e.type !== "arrow")), "web", "api"))).toBe(true);
  });

  it("the 图外 tray is on the map, reached over a scaffold", () => {
    expect(g.boxOf(OUTSIDE)).toEqual(g.tray);
    const rt = trip(g, "pay", OUTSIDE);
    expect(rt.legs.length).toBeGreaterThan(0);
    expect(rt.legs[rt.legs.length - 1].b).toEqual(g.dock(OUTSIDE));
    expect(scaffold(rt)).toBe(true);
  });
});
