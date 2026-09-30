// A command's result on screen (web/docs/workstation.md「新想法」): the CLI's own verdict — `tool.isError`
// from server/canvas/adapters/ (Claude is_error, Codex exit code ≠ 0, Pi isError) — and, for a test
// run whose output the page has in full, the runner's pass / fail counts.
import { describe, expect, it } from "vitest";
import type { Item } from "../session/agents.ts";
import { execResult, execResults } from "./outcome.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const tool = (id: string, t: NonNullable<Item["tool"]>, endAt?: number): Item => ({ id, kind: "tool", at: 1000, ...(endAt ? { endAt } : {}), tool: t });
const PYTEST_FAIL = [
  "Exit code 1",
  "============================= test session starts ==============================",
  "collected 4 items",
  "",
  "tests/test_users.py .F..                                                 [100%]",
  "",
  "=================================== FAILURES ===================================",
  "E   assert 401 == 200",
  "=========================== short test summary info ============================",
  "FAILED tests/test_users.py::test_login - assert 401 == 200",
  "========================= 1 failed, 3 passed in 0.21s ==========================",
].join("\n");
// vitest with colours on: the last summary line is Tests, after Test Files
const VITEST_PASS = "\u001b[32m ✓\u001b[39m src/a.test.ts (3 tests) 4ms\n\n\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m12 passed\u001b[39m\u001b[22m\u001b[90m (12)\u001b[39m\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m232 passed\u001b[39m\u001b[22m\u001b[90m (232)\u001b[39m\n\u001b[2m   Start at \u001b[22m 01:05:12\n\u001b[2m   Duration \u001b[22m 2.31s";

describe("execResult", () => {
  it.each<[string, Item, ReturnType<typeof execResult>]>([
    ["a failing pytest (Claude Bash, is_error)", tool("a", { name: "Bash", input: "pytest tests/test_users.py", output: PYTEST_FAIL, isError: true }, 1500), { ok: false, passed: 3, failed: 1 }],
    ["a passing vitest run (Codex shell, exit code 0), colours and all", tool("b", { name: "shell", input: "npx vitest run", output: VITEST_PASS, isError: false }, 1500), { ok: true, passed: 232 }],
    ["a plain command: its exit status only", tool("c", { name: "Bash", input: "ls server", output: "app.py\nusers.py", isError: false }, 1500), { ok: true }],
    // `pytest a && pytest b`: the page has only the first 4000 characters, which hold the first run's summary
    ["output cut to a preview: no counts from its head", tool("d", { name: "Bash", input: "pytest a && pytest b", output: `==== 3 passed in 0.10s ====\n${"x".repeat(3970)}`, outputLen: 12_000, isError: true }, 1500), { ok: false }],
    ["still running: no verdict yet", tool("e", { name: "Bash", input: "pytest" }), null],
    ["a log that does not say (an older snapshot, no isError)", tool("f", { name: "Bash", input: "pytest", output: "ok" }, 1500), null],
  ])("%s", (_name, item, want) => {
    expect(execResult(item)).toEqual(want);
  });
});

describe("execResults", () => {
  it("maps a run's finished commands to their results; reads, running calls and calls without an item have none", () => {
    const segs: RunSeg[] = [
      { kind: "read", start: 0, end: 1, label: "读 app.py", itemId: "r1", path: "server/app.py" },
      { kind: "exec", start: 1, end: 2, label: "跑 pytest", itemId: "c1", cmd: "pytest" },
      { kind: "exec", start: 2, end: 3, label: "跑 pytest", itemId: "c2", cmd: "pytest" },
      { kind: "exec", start: 3, end: 4, label: "跑 ls", itemId: "gone", cmd: "ls" },
    ];
    const run: WorkRun = { id: "s", agent: "claude", name: "Claude Code", sessionId: "s", segs, receipts: [], running: true, lastAt: 4, children: [] };
    const items = [
      tool("r1", { name: "Read", input: "server/app.py", output: "…", isError: false }, 1),
      tool("c1", { name: "Bash", input: "pytest", output: "2 failed, 1 passed in 0.1s", isError: true }, 2),
      tool("c2", { name: "Bash", input: "pytest" }),
    ];
    expect([...execResults(run, items)].map(([g, r]) => [g.itemId, r])).toEqual([["c1", { ok: false, failed: 2, passed: 1 }]]);
  });
});
