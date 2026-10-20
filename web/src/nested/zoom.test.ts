import { describe, expect, it } from "vitest";
import {
  camOf,
  childSim,
  clampSim,
  COOLDOWN_MS,
  easeInOut,
  ENTER_FILL,
  fillOf,
  fitCam,
  flyAt,
  innerBox,
  LEAVE_FILL,
  nestBox,
  nestOf,
  onPage,
  parentSim,
  simOf,
  thumbAlpha,
  veilAlpha,
  VEIL_TO,
  zoomStep,
  type Sim,
} from "./zoom";

const node = { x: 150, y: 340, w: 220, h: 110 };
const content = { x: -20, y: -10, w: 760, h: 420 };
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("the sub-diagram in its node", () => {
  it("is contained and centred in the node's inner box", () => {
    const m = nestOf(node, content);
    const b = nestBox(m, content);
    const n = innerBox(node);
    expect(b.w <= n.w + 1e-9 && b.h <= n.h + 1e-9).toBe(true);
    close(b.x + b.w / 2, n.x + n.w / 2);
    close(b.y + b.h / 2, n.y + n.h / 2);
    // one side fills it
    expect(Math.min(Math.abs(b.w - n.w), Math.abs(b.h - n.h))).toBeLessThan(1e-9);
  });

  it("shows on the page exactly where the child's own view puts it, both ways", () => {
    const m = nestOf(node, content);
    const parent: Sim = { k: 3.2, x: -180, y: -900 };
    const child = childSim(parent, m);
    const inParent = onPage(parent, nestBox(m, content));
    const inChild = onPage(child, content);
    for (const key of ["x", "y", "w", "h"] as const) close(inParent[key], inChild[key]);
    const back = parentSim(child, m);
    close(back.k, parent.k);
    close(back.x, parent.x);
    close(back.y, parent.y);
  });

  it("goes through the panes' cameras: a child pane lower on the page (under the breadcrumb) gets its scroll from that", () => {
    const parentPane = { x: 0, y: 90 };
    const childPane = { x: 0, y: 134 };
    const cam = { zoom: 2.5, scrollX: -40, scrollY: -300 };
    const s = simOf(cam, parentPane);
    const c = camOf(childSim(s, nestOf(node, content)), childPane);
    // a child point lands on the same page pixel through either pane
    const q = { x: 100, y: 50 };
    const m = nestOf(node, content);
    const p = { x: q.x * m.s + m.tx, y: q.y * m.s + m.ty };
    close((p.x + cam.scrollX) * cam.zoom + parentPane.x, (q.x + c.scrollX) * c.zoom + childPane.x);
    close((p.y + cam.scrollY) * cam.zoom + parentPane.y, (q.y + c.scrollY) * c.zoom + childPane.y);
    const r = camOf(s, parentPane);
    close(r.scrollX, cam.scrollX);
    close(r.scrollY, cam.scrollY);
  });
});

describe("how big a node is", () => {
  it("is its larger share of the pane", () => {
    close(fillOf({ w: 200, h: 80 }, 2, { w: 1000, h: 800 }), 0.4);
    close(fillOf({ w: 100, h: 300 }, 2, { w: 1000, h: 800 }), 0.75);
  });
  it("brings the thumbnail in before the veil, and the veil is closed where the way out is", () => {
    expect(thumbAlpha(0.1)).toBe(0);
    expect(thumbAlpha(0.5)).toBe(1);
    expect(veilAlpha(0.3)).toBe(0);
    expect(veilAlpha(LEAVE_FILL)).toBe(1);
    expect(veilAlpha(0.5)).toBeGreaterThan(0);
    expect(veilAlpha(0.5)).toBeLessThan(1);
  });
});

describe("the switches", () => {
  const base = { since: 10_000, idle: false, blocked: false } as const;
  it("enter through the threshold zooming in, not zooming out", () => {
    expect(zoomStep({ ...base, side: "parent", fill: ENTER_FILL, dir: 1 })).toBe("enter");
    expect(zoomStep({ ...base, side: "parent", fill: ENTER_FILL - 0.01, dir: 1 })).toBe(null);
    expect(zoomStep({ ...base, side: "parent", fill: 0.95, dir: -1 })).toBe(null);
  });
  it("enter when a zoom in stops where only the sub-diagram is left to see", () => {
    expect(zoomStep({ ...base, side: "parent", fill: VEIL_TO + 0.01, dir: 1, idle: true })).toBe("enter");
    expect(zoomStep({ ...base, side: "parent", fill: VEIL_TO - 0.05, dir: 1, idle: true })).toBe(null);
  });
  it("leave zooming out past the leave fill, or at the smallest zoom", () => {
    expect(zoomStep({ ...base, side: "child", fill: LEAVE_FILL, dir: -1 })).toBe("leave");
    expect(zoomStep({ ...base, side: "child", fill: LEAVE_FILL + 0.05, dir: -1 })).toBe(null);
    expect(zoomStep({ ...base, side: "child", fill: 0.9, dir: -1, atMin: true })).toBe("leave");
    expect(zoomStep({ ...base, side: "child", fill: 0.2, dir: 1 })).toBe(null);
    expect(zoomStep({ ...base, side: "child", fill: 0.2, dir: -1, idle: true })).toBe(null);
  });
  it("have hysteresis: a switch lands well inside the other side's band", () => {
    expect(ENTER_FILL - LEAVE_FILL).toBeGreaterThan(0.1);
    // entered at ENTER_FILL: zooming out a little does not leave; left at LEAVE_FILL: zooming in a little does not enter
    expect(zoomStep({ ...base, side: "child", fill: ENTER_FILL * 0.9, dir: -1 })).toBe(null);
    expect(zoomStep({ ...base, side: "parent", fill: LEAVE_FILL * 1.1, dir: 1 })).toBe(null);
  });
  it("wait out the cooldown, and never fight text editing or a drag", () => {
    expect(zoomStep({ ...base, side: "parent", fill: 0.9, dir: 1, since: COOLDOWN_MS - 1 })).toBe(null);
    expect(zoomStep({ ...base, side: "parent", fill: 0.9, dir: 1, blocked: true })).toBe(null);
    expect(zoomStep({ ...base, side: "child", fill: 0.3, dir: -1, blocked: true })).toBe(null);
  });
});

describe("the flights", () => {
  const a: Sim = { k: 1, x: 0, y: 0 };
  const b: Sim = { k: 5, x: -2000, y: -1500 };
  it("start and end exactly at the two views", () => {
    expect(flyAt(a, b, 0)).toEqual(a);
    expect(flyAt(a, b, 1)).toEqual(b);
  });
  it("zoom geometrically about the point both views keep in place", () => {
    const mid = flyAt(a, b, 0.5);
    close(mid.k, Math.sqrt(5));
    // the fixed scene point F: F*a.k + a.x = F*b.k + b.x  →  F = 500 (x), 375 (y)
    close(500 * mid.k + mid.x, 500);
    close(375 * mid.k + mid.y, 375);
  });
  it("pan straight when the zoom hardly changes", () => {
    const c = flyAt(a, { k: 1.01, x: 300, y: 100 }, 0.5);
    close(c.x, 150);
    close(c.y, 50);
  });
  it("ease in and out", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    close(easeInOut(0.5), 0.5);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });
});

describe("views", () => {
  it("fit like the canvas fits itself", () => {
    const c = fitCam({ x: 0, y: 0, w: 1000, h: 400 }, { w: 1280, h: 710 });
    close(c.zoom, 1);
    close((500 + c.scrollX) * c.zoom, 640);
  });
  it("are held to Excalidraw's zoom range about a page point", () => {
    const s = clampSim({ k: 60, x: -1000, y: -500 }, { x: 640, y: 400 });
    expect(s.k).toBe(30);
    // the scene point under (640, 400) stays there
    const px = (640 + 1000) / 60;
    close(px * s.k + s.x, 640);
  });
});
