import { describe, expect, it } from "vitest";
import { createClient } from "./client";

/** A fake /api/project: one file per path, versions = write counter; stale base → 409. */
function fakeServer() {
  const files = new Map<string, { v: string; body: unknown }>();
  const calls: { method: string; path: string; body: any }[] = [];
  let n = 0;
  let down = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (down > 0) {
      down--;
      throw new TypeError("fetch failed");
    }
    const path = url.replace("/api/project", "").replace(/\/append$/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, body });
    await new Promise((r) => setTimeout(r, 1));
    const cur = files.get(path);
    if (init.method === "DELETE") return files.delete(path), new Response(JSON.stringify({ ok: true }));
    if (!body.force && (cur?.v ?? null) !== body.base) return new Response(JSON.stringify({ conflict: true, current: cur?.v }), { status: 409 });
    const v = `v${++n}`;
    files.set(path, { v, body: body.data ?? body.records });
    return new Response(JSON.stringify({ version: v }));
  };
  return { files, calls, fetchImpl, external: (path: string) => files.set(path, { v: `x${++n}`, body: "edited elsewhere" }), setDown: (k: number) => (down = k) };
}

describe("project client", () => {
  it("serialises writes per file and sends the version it last saw", async () => {
    const srv = fakeServer();
    const c = createClient({ fetchImpl: srv.fetchImpl });
    c.seen("workspace", null);
    void c.write("workspace", { op: { kind: "put", path: "/workspace", data: 1 } });
    void c.write("workspace", { op: { kind: "put", path: "/workspace", data: 2 } });
    await c.idle();
    expect(srv.calls.map((x) => x.body.base)).toEqual([null, "v1"]);
    expect(c.status().conflicts).toEqual([]);
    expect(srv.files.get("/workspace")!.body).toBe(2);
  });

  it("holds a conflicted file until the user decides; overwrite writes the latest local version", async () => {
    const srv = fakeServer();
    const c = createClient({ fetchImpl: srv.fetchImpl });
    c.seen("canvas:c1", null);
    await c.write("canvas:c1", { op: { kind: "put", path: "/canvases/c1", data: "a" } });
    srv.external("/canvases/c1");
    await c.write("canvas:c1", { op: { kind: "put", path: "/canvases/c1", data: "b" } });
    expect(c.status().conflicts).toEqual(["canvas:c1"]);
    await c.write("canvas:c1", { op: { kind: "put", path: "/canvases/c1", data: "c" } }); // held, not sent
    expect(srv.files.get("/canvases/c1")!.body).toBe("edited elsewhere");
    await c.resolve("canvas:c1", "overwrite");
    expect(c.status().conflicts).toEqual([]);
    expect(srv.files.get("/canvases/c1")!.body).toBe("c");
    expect(srv.calls.at(-1)!.body.force).toBe(true);
  });

  it("an append conflict is overwritten with the full log", async () => {
    const srv = fakeServer();
    const c = createClient({ fetchImpl: srv.fetchImpl });
    c.seen("session:s1", "stale");
    await c.write("session:s1", { op: { kind: "append", path: "/sessions/s1/append", records: [{ t: "turn" }] }, overwrite: () => ({ kind: "replace", path: "/sessions/s1", records: [{ t: "session" }, { t: "turn" }] }) });
    expect(c.status().conflicts).toEqual(["session:s1"]);
    await c.resolve("session:s1", "overwrite");
    expect(srv.files.get("/sessions/s1")!.body).toEqual([{ t: "session" }, { t: "turn" }]);
  });

  it("retries while the server is unreachable and reports offline meanwhile", async () => {
    const srv = fakeServer();
    const c = createClient({ fetchImpl: srv.fetchImpl, retryMs: 5 });
    const seen: boolean[] = [];
    c.subscribe(() => seen.push(c.status().offline));
    c.seen("workspace", null);
    srv.setDown(2);
    await c.write("workspace", { op: { kind: "put", path: "/workspace", data: 1 } });
    expect(seen).toContain(true);
    expect(c.status().offline).toBe(false);
    expect(srv.files.get("/workspace")!.body).toBe(1);
  });
});
