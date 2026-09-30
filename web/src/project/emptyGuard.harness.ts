// A fake /api/project for the empty-canvas tests: canvases with a version counter and the
// server's rules (stale base → 409; non-empty → empty without `clear` → 409 `empty-overwrite`).
import { createClient } from "./client";
import { createSaveGate } from "../canvas/saveGate";
import type { El } from "../canvas/scene";

const els = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, isDeleted: false }) as unknown as El);

export function createProjectHarness(initial: Record<string, number>) {
  const files = new Map<string, { v: string; n: number }>();
  let counter = 0;
  Object.entries(initial).forEach(([id, n]) => files.set(id, { v: `v${++counter}`, n }));
  const calls: { method: string; path: string; body: any }[] = [];
  const refusedFor: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const id = url.split("/canvases/")[1];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path: url, body });
    const cur = files.get(id);
    if (init.method === "GET") return cur ? new Response(JSON.stringify({ scene: { elements: els(cur.n) }, version: cur.v })) : new Response("", { status: 404 });
    if (!body.force && (cur?.v ?? null) !== body.base) return new Response(JSON.stringify({ conflict: true }), { status: 409 });
    if (cur && cur.n > 0 && body.data.elements.length === 0 && !body.clear) return new Response(JSON.stringify({ conflict: true, code: "empty-overwrite" }), { status: 409 });
    const v = `v${++counter}`;
    files.set(id, { v, n: body.data.elements.length });
    return new Response(JSON.stringify({ version: v }));
  };
  const client = createClient({ fetchImpl, onRefusedEmpty: (slot) => void refusedFor.push(slot) });
  const gate = createSaveGate();
  return {
    client,
    calls,
    refusedFor,
    count: (id: string) => files.get(id)?.n,
    idle: () => client.idle(),
    /** What a mount does before it may save: load the server's scene and version, then arm. */
    async mountAndLoad(id: string) {
      const c = files.get(id)!;
      client.seen(`canvas:${id}`, c.v);
      gate.arm(id, els(c.n));
    },
    serverChangedElsewhere: (id: string, n: number) => files.set(id, { v: `v${++counter}`, n }),
    gateSave(id: string, n: number) {
      const p = gate.payload(id, els(n));
      if (p) void client.writeIfChanged(`canvas:${id}`, JSON.stringify(p.elements), { kind: "put", path: `/canvases/${id}`, data: { elements: p.elements }, ...(p.clear ? { clear: true } : {}) });
    },
    saveRaw(id: string, p: { elements: El[]; clear: boolean }) {
      void client.writeIfChanged(`canvas:${id}`, JSON.stringify(p) + Math.random(), { kind: "put", path: `/canvases/${id}`, data: { elements: p.elements }, ...(p.clear ? { clear: true } : {}) });
    },
  };
}
