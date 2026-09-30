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

  // Experiment B7: a write the server refuses (chmod 555, disk full) used to be logged to the
  // console and dropped; the page looked saved.
  it("a refused write is reported with the server's reason, held, and sent again on retry", async () => {
    const srv = fakeServer();
    let refuse = true;
    const fetchImpl = async (url: string, init: RequestInit) =>
      refuse && init.method === "PUT"
        ? new Response(JSON.stringify({ error: "保存失败：没有写入权限", file: "canvases/c2.excalidraw" }), { status: 500 })
        : srv.fetchImpl(url, init);
    const c = createClient({ fetchImpl });
    c.seen("canvas:c2", null);
    await c.write("canvas:c2", { op: { kind: "put", path: "/canvases/c2", data: "a" } });
    expect(c.status().failed).toEqual([{ slot: "canvas:c2", status: 500, gone: false, file: "canvases/c2.excalidraw", message: "保存失败：没有写入权限" }]);
    await c.write("canvas:c2", { op: { kind: "put", path: "/canvases/c2", data: "b" } }); // held with the latest
    expect(srv.files.has("/canvases/c2")).toBe(false);
    refuse = false;
    await c.retry();
    expect(c.status().failed).toEqual([]);
    expect(srv.files.get("/canvases/c2")!.body).toBe("b");
  });

  it("a failed append is retried as the full log, so its records are not skipped", async () => {
    const srv = fakeServer();
    let refuse = true;
    const fetchImpl = async (url: string, init: RequestInit) => (refuse ? new Response("Internal Server Error", { status: 500 }) : srv.fetchImpl(url, init));
    const c = createClient({ fetchImpl });
    c.seen("session:s1", null);
    const full = () => ({ kind: "replace" as const, path: "/sessions/s1", records: [{ t: "session" }, { t: "turn", n: 1 }, { t: "turn", n: 2 }] });
    await c.write("session:s1", { op: { kind: "append", path: "/sessions/s1/append", records: [{ t: "turn", n: 1 }] }, overwrite: full });
    expect(c.status().failed[0].message).toContain("500");
    await c.write("session:s1", { op: { kind: "append", path: "/sessions/s1/append", records: [{ t: "turn", n: 2 }] }, overwrite: full });
    refuse = false;
    await c.retry();
    expect(srv.files.get("/sessions/s1")!.body).toEqual(full().records);
    expect(srv.calls.at(-1)!.body.force).toBe(false);
  });

  it("410 (project directory moved away) is reported as gone", async () => {
    const c = createClient({ fetchImpl: async () => new Response(JSON.stringify({ gone: true, error: "项目目录 /x 不在了" }), { status: 410 }) });
    c.seen("workspace", "v1");
    await c.write("workspace", { op: { kind: "put", path: "/workspace", data: 1 } });
    expect(c.status().failed[0]).toMatchObject({ gone: true, status: 410, message: "项目目录 /x 不在了" });
  });

  it("a blocked slot (unreadable file on disk) is never written", async () => {
    const srv = fakeServer();
    const c = createClient({ fetchImpl: srv.fetchImpl });
    c.block("workspace", ".agora/workspace.json 有合并冲突（第 1 行）");
    await c.write("workspace", { op: { kind: "put", path: "/workspace", data: 1 } });
    expect(srv.calls).toEqual([]);
    expect(c.status().blocked).toEqual([{ slot: "workspace", reason: ".agora/workspace.json 有合并冲突（第 1 行）" }]);
  });

  // Review P2-2: what the file holds only moves once the server took the write. Before, a refused
  // save was remembered as written, so saving the same content again sent nothing.
  it("writeIfChanged remembers a body only after the server took it", async () => {
    const srv = fakeServer();
    let refuse = true;
    const fetchImpl = async (url: string, init: RequestInit) => (refuse ? new Response(JSON.stringify({ error: "保存失败：磁盘空间不足" }), { status: 507 }) : srv.fetchImpl(url, init));
    const c = createClient({ fetchImpl });
    c.seen("canvas:c1", null);
    const op = { kind: "put" as const, path: "/canvases/c1", data: "a" };
    await c.writeIfChanged("canvas:c1", "a", op);
    expect(c.status().failed).toHaveLength(1);
    refuse = false;
    await c.retry();
    await c.writeIfChanged("canvas:c1", "a", op); // not remembered from the refused try: goes out again
    expect(srv.calls.filter((x) => x.method === "PUT")).toHaveLength(2);
    await c.writeIfChanged("canvas:c1", "a", op); // now the server has it: nothing sent
    expect(srv.calls.filter((x) => x.method === "PUT")).toHaveLength(2);
  });
});

