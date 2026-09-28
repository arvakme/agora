import { beforeEach, describe, expect, it } from "vitest";
import { sessions } from "../session/store";
import { prepareBoot, type Boot } from "./boot";

const canvas = (elements: unknown[] = []) => ({ elements: elements as never[], threads: { threads: [], seq: 0 } });

describe("prepareBoot", () => {
  beforeEach(() => sessions.reset());

  it("only a project the server calls empty gets the first-run sample", () => {
    const b = prepareBoot({ canvases: {}, empty: true });
    expect(b.firstRun).toBe(true);
    expect(b.workspace!.docs[0]).toMatchObject({ id: "c1", kind: "canvas" });
  });

  // Experiment B3: workspace.json deleted, c1 (edited) and c2 still on disk. Before, the page took
  // this for a first run, wrote the sample over c1 and lost c2 from the list.
  it("workspace.json missing but canvases on disk → recovery mode, never the sample over c1", () => {
    sessions.hydrate({ sessions: { "s-a": { id: "s-a", canvasId: "c2", createdAt: 1, turnIds: [] } }, turns: {}, batches: {} });
    const boot: Boot = { canvases: { c1: canvas([{ id: "MARKER" }]), c2: canvas() }, empty: false };
    const b = prepareBoot(boot);
    expect(b.firstRun).toBe(false);
    expect(b.recovered).toEqual({ canvases: 2, sessions: 1, why: "missing" });
    const docs = b.workspace!.docs;
    expect(docs.filter((d) => d.kind === "canvas").map((d) => d.id)).toEqual(["c1", "c2"]);
    expect(docs.find((d) => d.kind === "session")).toMatchObject({ sessionId: "s-a" });
    expect(sessions.get().sessions["s-a"].canvasId).toBe("c2"); // its link is kept
    expect(b.workspace!.focused).toBe("c1");
  });

  it("an unreadable workspace.json (merge conflict) is recovered the same way and says why", () => {
    const b = prepareBoot({ canvases: { c9: canvas() }, empty: false, errors: [{ file: "workspace.json", error: "merge-conflict", line: 1 }] });
    expect(b.firstRun).toBe(false);
    expect(b.recovered?.why).toBe("unreadable");
  });

  // Experiment B2: a clone without .agora/sessions/. The page used to create the missing record on
  // the first canvas and save it, overwriting the session's real canvas.
  it("a listed session without its record is left unlinked and not saved", () => {
    const ws = {
      v: 2 as const,
      docs: [
        { id: "c1", kind: "canvas" as const, title: "A" },
        { id: "c2", kind: "canvas" as const, title: "B" },
        { id: "p-s-lost", kind: "session" as const, sessionId: "s-lost", title: "" },
      ],
      root: { kind: "group" as const, id: "g", tabs: ["c1"], active: "c1" },
      focused: "c1",
    };
    prepareBoot({ workspace: ws, canvases: { c1: canvas(), c2: canvas() }, empty: false });
    expect(sessions.get().sessions["s-lost"].canvasId).toBe("");
    expect(sessions.isPlaceholder("s-lost")).toBe(true);
    expect(sessions.persisted().sessions["s-lost"]).toBeUndefined(); // nothing written for it
    sessions.relink("s-lost", "c2"); // the person links it: now it is saved
    expect(sessions.persisted().sessions["s-lost"].canvasId).toBe("c2");
  });

  // Phase 1: workspace.json carries each session's canvas (and agent), so a fresh clone keeps the
  // link instead of showing the session unlinked (experiment B2).
  it("a listed session without its record keeps the canvas its entry records", () => {
    const ws = {
      v: 2 as const,
      docs: [
        { id: "c1", kind: "canvas" as const, title: "A" },
        { id: "c2", kind: "canvas" as const, title: "B" },
        { id: "p-s-b", kind: "session" as const, sessionId: "s-b", title: "", canvasId: "c2", agent: "claude" as const, nativeId: "n-1", createdAt: 42 },
      ],
      root: { kind: "group" as const, id: "g", tabs: ["c1"], active: "c1" },
      focused: "c1",
    };
    prepareBoot({ workspace: ws, canvases: { c1: canvas(), c2: canvas() }, empty: false });
    expect(sessions.get().sessions["s-b"]).toMatchObject({ canvasId: "c2", createdAt: 42 });
    expect(sessions.isPlaceholder("s-b")).toBe(true); // still nothing written until something happens
  });

  // Review P2-5: workspace.json missing and the only canvas on disk unreadable: that is not a first
  // run (the sample would be written as the only listed canvas and the real one orphaned).
  it("an unreadable canvas on disk counts: recovery mode lists it flagged, no sample", () => {
    const b = prepareBoot({ canvases: {}, empty: false, errors: [{ file: "canvases/c7.excalidraw", error: "merge-conflict", line: 3, kind: "canvas", id: "c7" }] });
    expect(b.firstRun).toBe(false);
    expect(b.workspace!.docs).toEqual([{ id: "c7", kind: "canvas", title: "已恢复画布 c7（文件读不了）" }]);
  });
});
