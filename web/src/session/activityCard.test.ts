// A running turn's items → the activity card's model: the action in progress, the finished ones by kind, what must stay visible.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "./agents.ts";
import { activityModel, processMode, statsLine, keepOpen, wasKeptOpen } from "./activityCard.ts";
import { buildTurns } from "./trajectoryModel.ts";

const user: Item = { id: "u1", kind: "user", text: "排查压缩策略", at: 1000 };
const tool = (id: string, at: number, name: string, input: string, o: Partial<NonNullable<Item["tool"]>> & { endAt?: number } = {}): Item => {
  const { endAt, ...t } = o;
  return { id, kind: "tool", at, ...(endAt ? { endAt } : {}), tool: { name, input, ...(endAt && t.output === undefined ? { output: "ok" } : {}), ...t } };
};
const model = (items: Item[], live = true, waiting = false) => activityModel(buildTurns([user, ...items], {}, live)[0], { waiting });

describe("activityModel", () => {
  it("no action yet: thinking, nothing counted", () => {
    const m = model([]);
    expect(m.total).toBe(0);
    expect(m.current).toBeNull();
    expect(m.title).toBe("正在分析请求");
    expect(m.stats).toBe("还没有动作");
    expect(m.failed).toEqual([]);
  });

  it("one action running: it is the current one and not yet counted as finished", () => {
    const m = model([tool("t1", 2000, "Bash", "git status --short")]);
    expect(m.current).toMatchObject({ id: "t1", text: "Bash git status --short" });
    expect(m.done).toBe(0);
    expect(m.total).toBe(1);
    expect(m.title).toBe("正在运行命令");
    expect(m.stats).toBe("还没有动作");
  });

  it("finished actions counted by kind: commands, reads (search too), edits (write too), sub-agents, the rest", () => {
    const m = model([
      tool("t1", 2000, "Bash", "a", { endAt: 2100 }),
      tool("t2", 2200, "Bash", "b", { endAt: 2300 }),
      tool("t3", 2400, "Read", "x.py", { endAt: 2500 }),
      tool("t4", 2600, "Grep", "foo", { endAt: 2700 }),
      tool("t5", 2800, "Edit", "x.py", { endAt: 2900 }),
      tool("t6", 3000, "Write", "y.py", { endAt: 3100 }),
      tool("t7", 3200, "Task", "review", { endAt: 3300 }),
      tool("t8", 3400, "WebFetch", "https://x", { endAt: 3500 }),
      tool("t9", 3600, "Read", "z.py"),
    ]);
    expect(m.counts).toEqual({ command: 2, read: 2, edit: 2, subagent: 1, other: 1 });
    expect(m.done).toBe(8);
    expect(m.stats).toBe("已完成 8 个动作：命令 2 · 读 2 · 改 2 · 子代理 1 · 其他 1");
    expect(m.current?.id).toBe("t9");
    expect(m.title).toBe("正在读取文件");
  });

  it("kinds with no actions are left out of the stats line", () => {
    expect(statsLine({ command: 5, read: 3, edit: 0, subagent: 0, other: 0 })).toBe("已完成 8 个动作：命令 5 · 读 3");
  });

  it("a sub-agent running next to other calls: the newest running call is the current one", () => {
    const m = model([
      tool("t1", 2000, "Task", "审查", { spawn: { childKind: "claude", state: "running" } }),
      tool("t2", 2100, "Read", "a.py", { endAt: 2200 }),
      tool("t3", 2300, "Bash", "ls"),
    ]);
    expect(m.current?.id).toBe("t3");
    expect(m.done).toBe(1);
    expect(m.total).toBe(3);
    expect(m.counts.subagent).toBe(0);
  });

  it("a failed action in the middle is kept apart, still counted as done, and does not stop the current one", () => {
    const m = model([
      tool("t1", 2000, "Bash", "npm test", { endAt: 2100, isError: true, output: "boom" }),
      tool("t2", 2200, "Read", "a.py", { endAt: 2300 }),
      tool("t3", 2400, "Bash", "ls"),
    ]);
    expect(m.failed.map((r) => r.id)).toEqual(["t1"]);
    expect(m.done).toBe(2);
    expect(m.current?.id).toBe("t3");
  });

  it("waiting for the person: the title and the current line say so", () => {
    const m = model([tool("t1", 2000, "Bash", "rm x")], true, true);
    expect(m.title).toBe("等你回答");
    expect(m.waiting).toBe(true);
  });

  it("between calls nothing is current; once the turn ends nothing is running", () => {
    const between = model([tool("t1", 2000, "Bash", "ls", { endAt: 2100 })]);
    expect(between.current).toBeNull();
    expect(between.title).toBe("正在分析请求");
    const over = activityModel(buildTurns([user, tool("t1", 2000, "Bash", "ls", { endAt: 2100 }), { id: "e", kind: "end", at: 2200 }], {}, false)[0]);
    expect(over.running).toBe(false);
    expect(over.current).toBeNull();
    expect(over.stats).toBe("已完成 1 个动作：命令 1");
  });
});

describe("process mode (per session, this browser)", () => {
  beforeEach(() => {
    const kv = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v) });
    processMode.reload();
  });
  it("brief unless the person chose otherwise; old sessions too", () => {
    expect(processMode.get("s-old")).toBe("brief");
    processMode.set("s1", "detail");
    expect(processMode.get("s1")).toBe("detail");
    expect(processMode.get("s2")).toBe("brief");
  });
  it("survives a reload", () => {
    processMode.set("s1", "detail");
    processMode.reload();
    expect(processMode.get("s1")).toBe("detail");
  });
  it("a storage that throws still gives brief", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    processMode.reload();
    expect(processMode.get("s1")).toBe("brief");
    processMode.set("s1", "detail"); // not saved, but this page goes on
    expect(processMode.get("s1")).toBe("detail");
  });
});

describe("a turn left expanded stays expanded when it ends", () => {
  it("remembers the person's choice per turn", () => {
    expect(wasKeptOpen("s1", 3)).toBe(false);
    keepOpen("s1", 3, true);
    expect(wasKeptOpen("s1", 3)).toBe(true);
    expect(wasKeptOpen("s1", 4)).toBe(false);
    keepOpen("s1", 3, false);
    expect(wasKeptOpen("s1", 3)).toBe(false);
  });
});
