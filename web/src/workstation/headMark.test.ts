// 小人的头 (./headMark.ts): the six CLIs each draw their own mark, sized to the head; any other kind falls back to its initial.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasOwnMark } from "../session/agentMarks.ts";
import { headMark, SYMBOL_AGENTS, symbolId } from "./headMark.ts";
import { WorkerDefs } from "./RunAvatar.tsx";

const R = 6.2 * 0.9; // a head's mark disc, as figureNode draws it (RIG.head × 0.9)

describe("headMark", () => {
  it("Pi, Claude, Cursor and Devin are vector symbols; Codex and Grok are their images", () => {
    expect(headMark("pi", R)).toMatchObject({ kind: "symbol", id: "ws-m-pi" });
    expect(headMark("claude", R)).toMatchObject({ kind: "symbol", id: "ws-m-claude" });
    expect(headMark("cursor", R)).toMatchObject({ kind: "symbol", id: "ws-m-cursor" });
    expect(headMark("devin", R)).toMatchObject({ kind: "symbol", id: "ws-m-devin" });
    expect(headMark("codex", R)).toMatchObject({ kind: "image", image: "codex" });
    expect(headMark("grok", R)).toMatchObject({ kind: "image", image: "grok" });
  });

  it("any other kind — a CLI added later, a worker known by its receipts — falls back to its initial", () => {
    expect(headMark("droid", R)).toMatchObject({ kind: "letter", text: "D" });
    expect(headMark("worker", R)).toMatchObject({ kind: "letter", text: "W" });
    expect(headMark("you", R)).toMatchObject({ kind: "letter", text: "你" }); // the person, in the build replay
    expect(headMark("", R)).toMatchObject({ kind: "letter", text: "?" });
  });

  it("an agent has its own mark exactly when session/agentMarks says so (one list for the avatars and the heads)", () => {
    for (const k of ["pi", "claude", "codex", "grok", "cursor", "devin", "droid", "worker", ""]) expect(headMark(k, R).kind !== "letter").toBe(hasOwnMark(k));
  });

  it("each mark sits in the head: centred, square, no wider than the disc's own box allows (1.5 r, a corner of it still inside the head)", () => {
    for (const k of ["pi", "claude", "codex", "grok", "cursor", "devin"]) {
      const m = headMark(k, R);
      if (m.kind === "letter") throw new Error(k);
      expect(m.w).toBe(m.h);
      expect(m.x).toBeCloseTo(-m.w / 2, 9);
      expect(m.y).toBeCloseTo(-m.w / 2, 9);
      expect(m.w).toBeGreaterThanOrEqual(R * 0.99);
      expect(m.w).toBeLessThanOrEqual(R * 1.5);
    }
  });

  it("scales with the disc (a sub-agent's dispatcher badge is a small disc)", () => {
    const big = headMark("grok", 5) as { w: number };
    const small = headMark("grok", 3.7) as { w: number };
    expect(small.w / big.w).toBeCloseTo(3.7 / 5, 9);
  });
});

describe("<WorkerDefs/>", () => {
  const html = renderToStaticMarkup(createElement(WorkerDefs));
  it("has a symbol, with paths, for every vector mark headMark points at", () => {
    for (const k of SYMBOL_AGENTS) {
      const sym = html.match(new RegExp(`<symbol id="${symbolId(k)}"[^>]*>([\\s\\S]*?)</symbol>`));
      expect(sym, k).not.toBeNull();
      expect(sym![1], k).toContain("<path");
    }
  });
  it("and only those", () => {
    expect([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(SYMBOL_AGENTS.map(symbolId).sort());
  });
});
