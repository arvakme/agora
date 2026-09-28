// Run-tree fixtures: the scripted ~46 s from the 工位视图 prototype (two sessions, a Seedmux worker
// with tool calls, a receipts-only worker, a Claude Task sub-agent), placed at `base`, and after it
// Pi working in API 服务's sub-diagram (47–57 s) and on a canvas comment (58–66 s). Used by the tests
// and by the dev mock (`?mock=runs`), so the sub-agent UI can be seen before the adapter layer serves
// real run trees. Paths match the sample diagram's code links (web/**, server/**, server/db/**,
// server/cache/**, server/payments/**; its API 服务 sub-diagram: server/app.py, server/users.py).
import type { RunState } from "../../session/agents";
import type { WorkRun, Receipt, RunSeg, SegKind, TurnComment } from "./types";

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

/** The comment Pi works on from 58 s: #3 on Redis (element `redis` in the sample diagram, web/scripts/
 * fidelity/setup.ts). The dev mock shows its pin (comments/CommentLayer.tsx; never saved). */
export const MOCK_COMMENT = { n: 3, anchor: ["redis"], text: "缓存过期时间是不是太短？" } as const;
const C3: TurnComment = { n: MOCK_COMMENT.n, anchor: [...MOCK_COMMENT.anchor] };

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
      // in API 服务's sub-diagram: 应用入口, then over the bridge to 路由 and down the ladder to 用户模块
      ["think", 47, 48, { turn: 3 }],
      ["read", 48, 51, { path: "server/app.py", turn: 3 }],
      ["write", 51, 56, { path: "server/users.py", turn: 3 }],
      ["think", 56, 57, { turn: 3 }],
      // comment #3 on Redis 「缓存过期时间是不是太短？」, handed to Pi (the canvas's most recently active session)
      ["think", 58, 60.5, { turn: 4, comment: C3 }],
      ["read", 60.5, 63.5, { path: "server/cache/session.py", turn: 4, comment: C3 }],
      ["think", 63.5, 66, { turn: 4, comment: C3 }],
    ]),
    receipts: [],
    running: now < t(66),
    lastAt: t(66),
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

/**
 * A long window (`?mock=runs&long`): `days` days of work ending at `now`, two top-level sessions with
 * `subs` sub-agents between them, in a few working sessions a day with hours of nothing between —
 * the timeline's breaks, labels and ticks at scale. Deterministic. Paths match the sample diagram.
 */
export function longWindow(now: number, days = 5, subs = 100): WorkRun[] {
  const DAY = 86_400;
  const at = now - days * DAY * 1000;
  const files = ["server/app.py", "server/users.py", "server/db/models.py", "server/cache/session.py", "web/App.tsx", "server/payments/pay.py"];
  const tops: WorkRun[] = ["pi", "claude"].map((agent, k) => ({ id: `long-${agent}`, agent, name: agent === "pi" ? "Pi" : "Claude Code", sessionId: `long-${agent}`, segs: [], receipts: [], running: false, lastAt: now, children: [] }));
  for (let i = 0; i < subs; i++) {
    const top = tops[i % 2];
    const day = Math.floor((i / subs) * days);
    const start = day * DAY + (i % 2) * 8 * 3600 + 600 + Math.floor(i / (2 * days)) * 260; // seconds after `at`: two working sessions a day, sub-agents back to back in each
    const sub: WorkRun = {
      id: `long-sub-${i}`,
      agent: i % 3 ? "codex" : "claude",
      name: `worker-${i + 1}`,
      parentId: top.id,
      via: "seedmux",
      evidence: "seedmux",
      task: `任务 ${i + 1}`,
      segs: segs(at, [["read", start + 5, start + 60, { path: files[i % files.length] }], ["write", start + 60, start + 200, { path: files[(i + 2) % files.length] }], ["exec", start + 200, start + 230, { cmd: "pytest -q" }]]),
      receipts: rc(at, [[start, "running"], [start + 240, "accepted"]]),
      spawnAt: at + start * 1000,
      doneAt: at + (start + 240) * 1000,
      running: false,
      lastAt: at + (start + 240) * 1000,
      children: [],
    };
    top.children.push(sub);
    top.segs.push(...segs(at, [["delegate", start - 2, start, { child: sub.id, label: sub.name }], ["think", start + 240, start + 250]]));
  }
  for (const t of tops) t.segs.sort((a, b) => a.start - b.start);
  return tops;
}

/**
 * A worker that reads a node's file, then writes 24 scratch files outside the project (absolute paths:
 * an agent's scratchpad) and three new files under docs/new/ that no node claims, then goes back to a
 * node's file (`?mock=runs&scratch`). It stays at its node while it writes the scratch files; the docs
 * files send it to the 图外 tray and make the tray's suggestion.
 */
export function scratchRun(at: number): WorkRun {
  const dir = "/private/tmp/claude-501/-Users-zhijie-Job-intern-yuanzhuoai-dev/41a8454c-c9cd-470c-b51d-c016c85aa068/scratchpad";
  const list: S[] = [["think", 0, 2], ["read", 2, 5, { path: "server/app.py" }]];
  for (let i = 0; i < 24; i++) list.push(["write", 5 + i, 6 + i, { path: `${dir}/probe-${i}.py` }]);
  for (let i = 0; i < 3; i++) list.push(["write", 30 + i * 2, 31 + i * 2, { path: `docs/new/note-${i}.md` }]);
  list.push(["write", 38, 41, { path: "server/users.py" }]);
  return { id: "mock-scratch", agent: "claude", name: "Claude Code", sessionId: "mock-scratch", segs: segs(at, list), receipts: [], running: false, lastAt: at + 41_000, children: [] };
}
