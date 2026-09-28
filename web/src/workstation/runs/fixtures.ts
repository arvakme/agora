// Run-tree fixtures: the scripted ~46 s from the 工位视图 prototype (two sessions, a Seedmux worker
// with tool calls, a receipts-only worker, a Claude Task sub-agent), placed at `base`. Used by the
// tests and by the dev mock (`?mock=runs`), so the sub-agent UI can be seen before the adapter
// layer serves real run trees. Paths match the sample diagram's code links (web/**, server/**,
// server/db/**, server/cache/**, server/payments/**).
import type { RunState } from "../../session/agents";
import type { WorkRun, Receipt, RunSeg, SegKind } from "./types";

type S = [kind: SegKind, start: number, end: number, extra?: Partial<RunSeg>];
const base = (p: string) => p.split("/").pop() || p;

function segs(at: number, list: S[]): RunSeg[] {
  return list.map(([kind, s, e, x = {}]) => {
    const label =
      kind === "think"
        ? "思考"
        : kind === "wait"
          ? "等你回复"
          : kind === "delegate"
            ? `派 ${x.label ?? "子代理"}`
            : kind === "exec"
              ? `${x.verifies ? "验收 " : ""}跑 ${(x.cmd ?? "").split(" ")[0]}`
              : `${x.verifies ? "验收 " : ""}${kind === "write" ? "写" : "读"} ${base(x.path ?? "")}`;
    return { kind, start: at + s * 1000, end: at + e * 1000, turn: x.turn ?? 1, ...x, label };
  });
}
const rc = (at: number, list: [number, RunState | "accepted"][]): Receipt[] => list.map(([s, state]) => (state === "accepted" ? { at: at + s * 1000, state: "done", accepted: true } : { at: at + s * 1000, state }));

/** The prototype's scenario at `at` (ms). `now` decides which runs are still running. */
export function scenario(at: number, now = at + 46_000): WorkRun[] {
  const t = (s: number) => at + s * 1000;
  const cx: WorkRun = {
    id: "smx:T-41",
    agent: "codex",
    name: "Codex",
    parentId: "mock-pi",
    via: "seedmux",
    evidence: "seedmux",
    task: "给 users 接口补测试",
    segs: segs(at, [
      ["read", 21.6, 24, { path: "server/users.py" }],
      ["write", 24, 30, { path: "tests/test_users.py" }],
      ["exec", 30, 33.4, { cmd: "pytest tests/test_users.py" }],
    ]),
    receipts: rc(at, [
      [19.6, "dispatched"],
      [21, "acknowledged"],
      [21.6, "running"],
      [33.6, "done"],
      [44, "accepted"],
    ]),
    spawnAt: t(19.6),
    doneAt: t(33.6),
    running: now < t(33.6),
    lastAt: t(44),
    children: [],
  };
  const w3: WorkRun = {
    id: "smx:T-42",
    agent: "worker",
    name: "worker-3",
    parentId: "mock-pi",
    via: "seedmux",
    evidence: "seedmux",
    task: "查限流方案",
    coarse: true,
    segs: [],
    receipts: rc(at, [
      [20.5, "dispatched"],
      [22.5, "acknowledged"],
      [23.5, "running"],
      [29, "unknown"],
      [38, "exited"],
    ]),
    spawnAt: t(20.5),
    doneAt: t(38),
    running: now < t(38),
    lastAt: t(38),
    children: [],
  };
  const pi: WorkRun = {
    id: "mock-pi",
    agent: "pi",
    name: "Pi",
    sessionId: "mock-pi",
    segs: segs(at, [
      ["think", 0, 3],
      ["read", 3, 6.5, { path: "server/app.py" }],
      ["read", 6.5, 9.5, { path: "server/db/models.py" }],
      ["think", 9.5, 12],
      ["write", 12, 19, { path: "server/users.py" }],
      ["delegate", 19, 20, { child: "smx:T-41", label: "Codex" }],
      ["delegate", 20, 20.8, { child: "smx:T-42", label: "worker-3" }],
      ["think", 20.8, 27],
      ["wait", 27, 33, { question: "POST /users 要不要登录才能调？" }],
      ["write", 33, 38, { path: "server/users.py", turn: 2 }],
      ["read", 38, 40.5, { path: "tests/test_users.py", verifies: "smx:T-41", turn: 2 }],
      ["exec", 40.5, 44, { cmd: "pytest tests/test_users.py", verifies: "smx:T-41", turn: 2 }],
      ["think", 44, 45.5, { turn: 2 }],
    ]),
    receipts: [],
    running: now < t(45.5),
    lastAt: t(45.5),
    children: [cx, w3],
  };
  const sub: WorkRun = {
    id: "claude:agent-7f3",
    agent: "claude",
    name: "子代理",
    parentId: "mock-cc",
    via: "task",
    evidence: "native",
    task: "查回调签名约定",
    segs: segs(at, [
      ["read", 28.9, 30.8, { path: "docs/payments.md" }],
      ["read", 30.8, 32.6, { path: "server/payments/client.py" }],
    ]),
    receipts: rc(at, [
      [28.8, "dispatched"],
      [28.9, "running"],
      [32.6, "done"],
    ]),
    spawnAt: t(28.8),
    doneAt: t(32.6),
    running: now < t(32.6),
    lastAt: t(32.6),
    children: [],
  };
  const cc: WorkRun = {
    id: "mock-cc",
    agent: "claude",
    name: "Claude Code",
    sessionId: "mock-cc",
    segs: segs(at, [
      ["think", 0, 2],
      ["read", 2, 5.5, { path: "web/src/api.ts" }],
      ["read", 5.5, 9, { path: "server/payments/client.py" }],
      ["think", 9, 11.5],
      ["read", 11.5, 14.5, { path: "server/users.py" }],
      ["write", 14.5, 18.5, { path: "server/users.py" }],
      ["write", 18.5, 24, { path: "server/payments/webhook.py" }],
      ["exec", 24, 28, { cmd: "pytest tests/payments" }],
      ["delegate", 28, 28.8, { child: "claude:agent-7f3", label: "子代理" }],
      ["think", 28.8, 33],
      ["write", 33, 38.5, { path: "server/cache/session.py" }],
      ["think", 38.5, 40],
    ]),
    receipts: [],
    running: now < t(40),
    lastAt: t(40),
    children: [sub],
  };
  return [pi, cc];
}

/**
 * A crowd for the caps (state f): `n` top-level runs, each writing somewhere on `nodes` right now,
 * some with sub-agents. Deterministic.
 */
export function crowd(at: number, nodes: string[], n = 18): WorkRun[] {
  const out: WorkRun[] = [];
  for (let i = 0; i < n; i++) {
    const node = nodes[i % nodes.length];
    const kind: SegKind = i % 5 === 3 ? "wait" : i % 3 === 0 ? "write" : i % 3 === 1 ? "read" : "exec";
    out.push({
      id: `crowd-${i}`,
      agent: ["pi", "claude", "codex"][i % 3],
      name: `Agent ${i + 1}`,
      sessionId: `crowd-${i}`,
      segs: segs(at - 5000, [[kind, 0, 600, { path: `${node}/f${i}.py`, cmd: "pytest", question: "要不要继续？" }]]),
      receipts: [],
      running: true,
      lastAt: at,
      children: [],
    });
  }
  return out;
}
