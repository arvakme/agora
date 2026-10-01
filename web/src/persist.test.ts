import { beforeEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), seen: vi.fn(), remember: vi.fn(), block: vi.fn() }));
const legacy = vi.hoisted(() => ({ readLegacy: vi.fn(), markImported: vi.fn() }));
vi.mock("./project/client", () => ({ createClient: () => client }));
vi.mock("./project/legacy", () => legacy);

const BUILD = { sha: "13ae9ccc2b29301454000acd34508096e30b61b4", dirty: false };
const snapshot = (over: object) => ({ id: "p1", name: "proj", root: "/p", me: { id: "u", name: "me" }, empty: false, errors: [], workspace: null, canvases: {}, sessions: {}, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("addEventListener", vi.fn());
  legacy.readLegacy.mockResolvedValue(null);
});

it("keeps the build the server reported when the first open also imports the browser's old workspace", async () => {
  // /snapshot says which code the server runs; the /import response is a plain snapshot without it.
  client.get.mockResolvedValue(snapshot({ empty: true, build: BUILD }));
  legacy.readLegacy.mockResolvedValue({ workspace: { v: 2, docs: [{ id: "c1", kind: "canvas" }] }, canvases: {}, sessions: { sessions: {}, turns: {}, batches: {} } });
  client.post.mockResolvedValue(snapshot({ empty: false }));
  const { connect } = await import("./persist");

  const loaded = await connect();

  expect(loaded.imported).toBe(true);
  expect(loaded.project.build).toEqual(BUILD);
});

it("opens against an older server that sends no build", async () => {
  client.get.mockResolvedValue(snapshot({}));
  const { connect } = await import("./persist");

  expect((await connect()).project.build).toBeUndefined();
});
