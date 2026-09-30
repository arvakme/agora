// Code paths on the diagram → where each changed file lands (docs/progress-pointer.md).
import { describe, expect, it } from "vitest";
import { elementFor, globToRegExp, place, type Link } from "./codeLinks.ts";

const m = (glob: string, path: string) => globToRegExp(glob).test(path);

describe("globToRegExp", () => {
  it("** crosses directories, * stays in one", () => {
    expect(m("server/**", "server/canvas/runner.py")).toBe(true);
    expect(m("server/**", "server")).toBe(true);
    expect(m("server/**", "serverless/x.py")).toBe(false);
    expect(m("server/*.py", "server/app.py")).toBe(true);
    expect(m("server/*.py", "server/canvas/app.py")).toBe(false);
    expect(m("**/*.test.ts", "web/src/a.test.ts")).toBe(true);
    expect(m("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(m("web/src/{api,lib}/**", "web/src/lib/x.ts")).toBe(true);
    expect(m("web/src/{api,lib}/**", "web/src/app/x.ts")).toBe(false);
  });
  it("a bare directory means everything under it; a file name means that file", () => {
    expect(m("server", "server/app.py")).toBe(true);
    expect(m("server/", "server/app.py")).toBe(true);
    expect(m("./web", "web/index.html")).toBe(true);
    expect(m("README.md", "README.md")).toBe(true);
    expect(m("README.md", "docs/README.md")).toBe(false);
  });
});

describe("elementFor / place", () => {
  const links: Link[] = [
    { id: "api", label: "API", globs: ["server/**"] },
    { id: "runner", label: "Runner", globs: ["server/canvas/runner.py", "server/canvas/agents.py"] },
    { id: "web", label: "Web", globs: ["web/src/**"] },
  ];
  it("the most specific glob wins", () => {
    expect(elementFor("server/canvas/runner.py", links)?.link.id).toBe("runner");
    expect(elementFor("server/canvas/sessions.py", links)?.link.id).toBe("api");
    expect(elementFor("docs/x.md", links)).toBeNull();
    expect(elementFor("/tmp/elsewhere.py", links)).toBeNull(); // outside the project
  });
  it("the pointer sits on the newest change that lands on an element; the rest is listed", () => {
    const files = [
      { path: "web/src/App.tsx", op: "edit" as const, at: 1, toolId: "a", turn: 1 },
      { path: "server/app.py", op: "edit" as const, at: 2, toolId: "b", turn: 2 },
      { path: "docs/notes.md", op: "write" as const, at: 3, toolId: "c", turn: 2 },
      { path: "docs/notes.md", op: "edit" as const, at: 4, toolId: "d", turn: 3 },
    ];
    const s = place(files, links);
    expect(s.current?.element).toBe("api");
    expect(s.current?.path).toBe("server/app.py");
    expect(s.outside).toEqual([{ path: "docs/notes.md", at: 4, turns: [2, 3], op: "edit" }]);
    expect(s.byElement.get("web")?.map((p) => p.path)).toEqual(["web/src/App.tsx"]);
  });
});

// Review P2-5: a bare dir (`server`) or a trailing "/" is scored as `dir/**`, so a deeper glob wins.
describe("specificity of bare directories", () => {
  const links = (a: string): Link[] => [
    { id: "top", label: "top", globs: [a] },
    { id: "deep", label: "deep", globs: ["server/canvas/**"] },
  ];
  it("server, server/ and server/** all lose to server/canvas/**", () => {
    for (const g of ["server", "server/", "server/**"]) expect(elementFor("server/canvas/runner.py", links(g))?.link.id).toBe("deep");
  });
  it("a real file literal still beats its directory", () => {
    expect(elementFor("server/canvas/runner.py", [{ id: "dir", label: "", globs: ["server/canvas"] }, { id: "file", label: "", globs: ["server/canvas/runner.py"] }])?.link.id).toBe("file");
  });
});
