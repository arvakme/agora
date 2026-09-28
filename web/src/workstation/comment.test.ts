// 评论联动 (web/docs/workstation.md §评论联动与进出子图): a canvas comment handed to an agent is read off
// its transcript — the turn's user message starts 「画布评论 #n（锚点：名字（id）、…）：」 (comments/handoff.ts)
// — so the lane knows which comment a turn works on and which elements it is pinned to, and a replay
// shows the same. In that turn the worker goes to the node the comment is on and thinks there; its reads
// and writes still take it to their files' nodes (a short read is still a glance), and thinking between
// them brings it back. When the turn ends the answer is posted: `answered`, for the pin's check and a nod.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import type { El } from "../canvas/scene";
import { commentMessage } from "../comments/handoff.ts";
import type { Item } from "../session/agents.ts";
import { buildLane, commentOf } from "./lanes.ts";
import { ANSWER_MS, commentSpans, OUTSIDE, stateAt, type Ctx } from "./place.ts";
import { runFromTranscript } from "./runs/derive.ts";
import { scenario } from "./runs/fixtures.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { anchorPlace } from "./scenePlaces.ts";

const S = 1000;
const said = (text: string) => [{ id: "m1", author: "you" as const, text, at: 0, by: { id: "u1", name: "小马" } }];

describe("commentOf: the comment a turn works on, from its first message", () => {
  it("reads the number and the anchored element ids that handoff.ts wrote", () => {
    const msg = commentMessage({ n: 3, messages: said("缓存过期时间是不是太短？") }, [{ id: "redis", name: "Redis" }]);
    expect(msg.split("\n")[0]).toBe("画布评论 #3（锚点：Redis（redis））：");
    expect(commentOf(msg)).toEqual({ n: 3, anchor: ["redis"] });
  });
  it("several anchors in order (the first carries the pin), names with brackets of their own; the whole canvas has none", () => {
    const two = commentMessage({ n: 12, messages: said("这两个要合并吗") }, [{ id: "a-1", name: "API 服务（主）" }, { id: "k3J_x9", name: "MySQL" }]);
    expect(commentOf(two)).toEqual({ n: 12, anchor: ["a-1", "k3J_x9"] });
    expect(commentOf(commentMessage({ n: 4, messages: said("整体看看") }, []))).toEqual({ n: 4, anchor: [] });
  });
  it("any other message is not a comment", () => {
    expect(commentOf("帮我看看缓存")).toBeUndefined();
    expect(commentOf("先说一句\n画布评论 #3（锚点：Redis（redis））：")).toBeUndefined();
    expect(commentOf(undefined)).toBeUndefined();
  });
});

// The prototype's diagram: API 服务, Redis (its label bound inside, a note written on it), MySQL, 支付服务
// (an icon: a line in its group); a note off to the right, nearest MySQL; a deleted box.
const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({ id, type, x, y, width: w, height: h, angle: 0, isDeleted: false, groupIds: [], boundElements: null, ...extra }) as unknown as El;
const ELS: El[] = [
  el("api", "rectangle", 330, 230, 200, 72),
  el("redis", "rectangle", 680, 330, 160, 64, { boundElements: [{ type: "text", id: "redis-label" }] }),
  el("redis-label", "text", 740, 350, 40, 25, { containerId: "redis" }),
  el("db", "rectangle", 680, 120, 160, 64),
  el("pay", "rectangle", 350, 450, 160, 64),
  el("cache-note", "text", 690, 336, 50, 20),
  el("pay-stroke", "line", 360, 460, 30, 30, { groupIds: ["g-pay"], points: [[0, 0], [30, 30]] }),
  el("far-note", "text", 900, 140, 80, 40),
  el("gone", "rectangle", 100, 100, 50, 50, { isDeleted: true }),
];
const MAP = new Map(ELS.map((e) => [e.id, e]));
const BOXES = new Map<string, Box>([
  ["api", { x: 330, y: 230, w: 200, h: 72 }],
  ["redis", { x: 680, y: 330, w: 160, h: 64 }],
  ["db", { x: 680, y: 120, w: 160, h: 64 }],
  ["pay", { x: 350, y: 450, w: 160, h: 64 }],
]);

describe("anchorPlace: where a comment's work happens on this canvas", () => {
  const at = anchorPlace(BOXES, MAP);
  it("the linked node the element is, or lies in (a bound label, a note written on it, a stroke of its icon)", () => {
    expect(at(["redis"])).toEqual({ place: "redis" });
    expect(at(["redis-label"])).toEqual({ place: "redis" });
    expect(at(["cache-note"])).toEqual({ place: "redis" });
    expect(at(["pay-stroke"])).toEqual({ place: "pay" });
  });
  it("else the node nearest it; with no nodes at all, the 图外 tray", () => {
    expect(at(["far-note"])).toEqual({ place: "db" });
    expect(anchorPlace(new Map(), MAP)(["far-note"])).toEqual({ place: OUTSIDE });
  });
  it("the first anchor still on the canvas decides; none on this canvas: no place here", () => {
    expect(at(["gone", "cache-note"])).toEqual({ place: "redis" });
    expect(at(["on-another-canvas"])).toBeNull();
  });
});

// A Claude Code session: a first turn reads server/app.py; then comment #3 on Redis — it reads
// server/app.py (API 服务) and server/cache/session.py (Redis) and answers; later an ordinary turn reads
// the database.
const ROOT = "/tmp/proj";
const user = (id: string, at: number, text: string): Item => ({ id, kind: "user", text, at });
const read = (id: string, at: number, endAt: number, path: string): Item => ({ id, kind: "tool", at, endAt, msg: `m-${id}`, tool: { name: "Read", input: `${ROOT}/${path}`, output: "ok" } });
const end = (id: string, at: number): Item => ({ id, kind: "end", at });
const COMMENT = commentMessage({ n: 3, messages: said("缓存过期时间是不是太短？") }, [{ id: "redis", name: "Redis" }]);
const ITEMS: Item[] = [
  user("u1", 0, "给 users 接口加个字段"),
  read("r1", 1 * S, 3 * S, "server/app.py"),
  end("x1", 4 * S),
  user("u2", 10 * S, COMMENT),
  read("r2", 13 * S, 16 * S, "server/app.py"),
  read("r3", 18 * S, 21 * S, "server/cache/session.py"),
  end("x2", 22 * S),
  user("u3", 30 * S, "再看看数据库"),
  read("r4", 31 * S, 34 * S, "server/db/models.py"),
  end("x3", 35 * S),
];
const DOCK: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, redis: { x: 400, y: 150 }, db: { x: 400, y: -150 }, pay: { x: 100, y: 300 }, [OUTSIDE]: { x: 600, y: 400 } };
const ctx = (runs: WorkRun[], x: Partial<Ctx> = {}): Ctx => ({
  locate: (p) => (p.startsWith("server/cache/") ? { place: "redis" } : p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : null),
  dock: (p) => DOCK[p] ?? DOCK[OUTSIDE],
  anchor: anchorPlace(BOXES, MAP),
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
  ...x,
});

describe("a comment's turn, from the transcript", () => {
  const lane = buildLane("s1", ITEMS, { root: ROOT });
  const run = runFromTranscript({ sessionId: "s1", agent: "claude", name: "Claude Code", items: ITEMS, running: false, now: 40 * S, root: ROOT });
  it("every segment of that turn carries the comment; the other turns none", () => {
    for (const s of [...lane.segs, ...run.segs]) {
      if (s.turn === 2) expect(s.comment).toEqual({ n: 3, anchor: ["redis"] });
      else expect(s.comment).toBeUndefined();
    }
    expect(run.segs.filter((s) => s.turn === 2).map((s) => [s.kind, s.start / S, s.end / S])).toEqual([
      ["think", 10, 13],
      ["read", 13, 16],
      ["think", 16, 18],
      ["read", 18, 21],
      ["think", 21, 22],
    ]);
    expect(commentSpans(run)).toEqual([{ n: 3, anchor: ["redis"], turn: 2, start: 10 * S, end: 22 * S, open: false }]);
  });

  it("the worker walks to the commented node as the turn starts and thinks there", () => {
    const c = ctx([run]);
    expect(stateAt(run, 5 * S, c)).toMatchObject({ at: "api", pose: "idle" });
    const s = stateAt(run, 10.1 * S, c);
    expect(s).toMatchObject({ present: true, at: "redis", from: "api", pose: "walk", comment: { n: 3, anchor: ["redis"], start: 10 * S, end: 22 * S } });
    expect(stateAt(run, s.trip!.t1 + 1, c)).toMatchObject({ at: "redis", pose: "think", w: 1 });
  });

  it("its reads go to their files' nodes; thinking between them brings it back to the comment", () => {
    const c = ctx([run]);
    expect(stateAt(run, 13.1 * S, c)).toMatchObject({ at: "api", from: "redis", pose: "walk" });
    expect(stateAt(run, 15.5 * S, c)).toMatchObject({ at: "api", pose: "read", w: 1 });
    expect(stateAt(run, 16.1 * S, c)).toMatchObject({ at: "redis", from: "api", pose: "walk" });
    expect(stateAt(run, 20 * S, c)).toMatchObject({ at: "redis", pose: "read", w: 1 });
  });

  it("when the turn ends the answer goes to the thread: answered for ANSWER_MS; an ordinary turn after it thinks where it stands", () => {
    const c = ctx([run]);
    const done = stateAt(run, 22.2 * S, c);
    expect(done).toMatchObject({ at: "redis", pose: "idle", answered: { n: 3, anchor: ["redis"], end: 22 * S } });
    expect(done.comment).toBeUndefined();
    expect(stateAt(run, 22 * S + ANSWER_MS + 1, c).answered).toBeUndefined();
    const later = stateAt(run, 30.5 * S, c);
    expect(later).toMatchObject({ at: "redis", pose: "think" });
    expect(later.comment).toBeUndefined();
    expect(stateAt(run, 31.1 * S, c)).toMatchObject({ at: "db", from: "redis", pose: "walk" });
  });

  it("a turn still going is not answered yet", () => {
    const live = runFromTranscript({ sessionId: "s1", agent: "claude", name: "Claude Code", items: ITEMS.slice(0, 6), running: true, now: 23 * S, root: ROOT });
    const spans = commentSpans(live);
    expect(spans).toHaveLength(1);
    expect(spans[0].open).toBe(true);
    expect(stateAt(live, 22.5 * S, ctx([live])).answered).toBeUndefined();
  });

  it("a short read from the comment is a glance; without the canvas's anchors the turn has no place of its own", () => {
    const c3 = { n: 3, anchor: ["redis"] };
    const seg = (kind: RunSeg["kind"], s: number, e: number, path?: string): RunSeg => ({ kind, start: s * S, end: e * S, label: kind, comment: c3, ...(path ? { path } : {}) });
    const r: WorkRun = { id: "r", agent: "pi", name: "Pi", segs: [seg("think", 0, 3), seg("read", 3, 4.5, "server/app.py"), seg("think", 4.5, 7)], receipts: [], running: false, lastAt: 0, children: [] };
    expect(stateAt(r, 3.5 * S, ctx([r]))).toMatchObject({ at: "redis", pose: "read", glance: { place: "api" }, moves: [] });
    expect(stateAt(run, 11 * S, ctx([run], { anchor: undefined }))).toMatchObject({ at: "api", pose: "think" });
  });

  it("is a pure function of the log and t: jumping to a time and stepping there agree", () => {
    const c = ctx([run]);
    for (const t of [9.5, 10.4, 12, 13.6, 16.3, 19, 22.5, 31.2].map((x) => x * S)) {
      let stepped = stateAt(run, 0, c);
      for (let u = 0; u <= t; u += 100) stepped = stateAt(run, u, c);
      expect(stateAt(run, t, ctx([run]))).toEqual(stateAt(run, t, c));
      if (t % 100 === 0) expect(stepped).toEqual(stateAt(run, t, c));
    }
  });
});

describe("the dev mock's script (?mock=runs) after 46 s", () => {
  const base = 1_000_000;
  const [pi, cc] = scenario(base, base + 70 * S);
  const secs = (r: WorkRun, before = Infinity) => r.segs.filter((g) => g.start < base + before * S).map((g) => [g.kind, (g.start - base) / S, (g.end - base) / S, g.path ?? null]);
  it("keeps everything before 46 s as it was", () => {
    expect(secs(pi, 46)).toEqual([
      ["think", 0, 3, null],
      ["read", 3, 6.5, "server/app.py"],
      ["read", 6.5, 9.5, "server/db/models.py"],
      ["think", 9.5, 12, null],
      ["write", 12, 19, "server/users.py"],
      ["delegate", 19, 20, null],
      ["delegate", 20, 20.8, null],
      ["think", 20.8, 27, null],
      ["wait", 27, 33, null],
      ["write", 33, 38, "server/users.py"],
      ["read", 38, 40.5, "tests/test_users.py"],
      ["exec", 40.5, 44, null],
      ["think", 44, 45.5, null],
    ]);
    expect(secs(cc).at(-1)).toEqual(["think", 38.5, 40, null]);
    expect(pi.segs.filter((g) => g.start < base + 46 * S).every((g) => !g.comment)).toBe(true);
  });

  it("Pi works in API 服务 (its sub-diagram: 应用入口, then 用户模块) from 48 s, then takes comment #3 on Redis at 58 s: walks there, reads server/cache/session.py, answers at 66 s", () => {
    expect(secs(pi).slice(13)).toEqual([
      ["think", 47, 48, null],
      ["read", 48, 51, "server/app.py"],
      ["write", 51, 56, "server/users.py"],
      ["think", 56, 57, null],
      ["think", 58, 60.5, null],
      ["read", 60.5, 63.5, "server/cache/session.py"],
      ["think", 63.5, 66, null],
    ]);
    expect(commentSpans(pi)).toEqual([{ n: 3, anchor: ["redis"], turn: 4, start: base + 58 * S, end: base + 66 * S, open: false }]);
    const c: Ctx = {
      locate: (p) => (p.startsWith("server/cache/") ? { place: "redis" } : p.startsWith("server/db/") ? { place: "mysql" } : p.startsWith("server/") ? { place: "api" } : null),
      dock: (p) => ({ api: { x: 0, y: 0 }, redis: { x: 350, y: 100 }, mysql: { x: 350, y: -110 } })[p] ?? { x: 300, y: 250 },
      anchor: (ids) => (ids[0] === "redis" ? { place: "redis" } : null),
      reduced: false,
      run: () => undefined,
    };
    expect(stateAt(pi, base + 48.1 * S, c)).toMatchObject({ at: "api", from: OUTSIDE, pose: "walk" });
    expect(stateAt(pi, base + 58.1 * S, c)).toMatchObject({ at: "redis", from: "api", pose: "walk", comment: { n: 3, anchor: ["redis"] } });
    expect(stateAt(pi, base + 62 * S, c)).toMatchObject({ at: "redis", pose: "read", w: 1 });
    expect(stateAt(pi, base + 66.2 * S, c)).toMatchObject({ at: "redis", answered: { n: 3 } });
  });
});
