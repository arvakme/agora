// 插话 (ST1): what happens to words said while an agent works — into the turn, a choice, or the old rules.
import { describe, expect, it } from "vitest";
import { CHOICES, defaultChoice, planSend, steerAbility, steerNote } from "./steerModel.ts";
import { deliveryNote } from "../workstation/talk.ts";

const base = { running: false, terminalAlive: false, steer: true, noSteer: "" };

describe("planSend", () => {
  it("nothing running: an ordinary send", () => {
    expect(planSend(base)).toEqual({ kind: "send", mode: "auto" });
  });
  it("a turn is running and the CLI can take words: steer, no question asked", () => {
    expect(planSend({ ...base, running: true })).toEqual({ kind: "steer", mode: "steer" });
  });
  it("a turn is running and the CLI cannot: the person chooses, and the reason is carried", () => {
    const p = planSend({ ...base, running: true, steer: false, noSteer: "Devin 的 -p 只收命令行上的一条提示" });
    expect(p).toEqual({ kind: "choose", reason: "Devin 的 -p 只收命令行上的一条提示" });
  });
  it("a terminal pane keeps its own rules (input right, busy) whatever the CLI can do", () => {
    expect(planSend({ ...base, running: true, terminalAlive: true, steer: false })).toEqual({ kind: "send", mode: "auto" });
    expect(planSend({ ...base, running: true, terminalAlive: true })).toEqual({ kind: "send", mode: "auto" });
  });
  it("an unknown ability is not steer: the person is asked", () => {
    expect(planSend({ ...base, running: true, steer: undefined, noSteer: "" }).kind).toBe("choose");
  });
});

describe("the two choices", () => {
  it("interrupt first and the default, then wait, worded as the person asked", () => {
    expect(CHOICES.map((c) => [c.mode, c.label])).toEqual([
      ["interrupt", "停下这一轮，改说这句"],
      ["wait", "等这一轮做完再说"],
    ]);
    expect(defaultChoice()).toBe("interrupt");
  });
});

describe("the words under the box", () => {
  it("steer says 已插话给 X, not 已发给", () => {
    expect(steerNote("Devin", "steer")).toBe("已插话给 Devin");
    expect(deliveryNote("Devin", "steered")).toBe("已插话给 Devin");
    expect(deliveryNote("Devin", "steerRead")).toBe("已插话给 Devin · 它已读到");
    expect(deliveryNote("Devin", "interrupted")).toBe("已停下 Devin 的这一轮，改说这句");
  });
  it("the old wording is kept for a queued send", () => {
    expect(deliveryNote("Devin", "queued")).toBe("已发给 Devin · 会在这一轮结束后送达");
  });
});

describe("agents.send with a mode", () => {
  it("passes the mode; a steer has no turn of its own and does not replace what is in flight", async () => {
    const { vi } = await import("vitest");
    const { agents } = await import("./agents.ts");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const reply = (how: string) => ({ sendId: `m-${how}`, route: "headless", how });
    let next = reply("steer");
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => (calls.push({ url, body: JSON.parse(init.body) }), new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const r = await agents.send("s-steer", "停一下", { mode: "steer" });
      expect(calls[0].url).toBe("/api/agent/sessions/s-steer/send");
      expect(calls[0].body.mode).toBe("steer");
      expect(r.how).toBe("steer");
      expect((await r.done).sendId).toBe("m-steer");
      expect(agents.get().inflight["s-steer"]).toBeUndefined();
      next = reply("interrupt");
      await agents.send("s-steer", "改说这句", { mode: "interrupt" });
      expect(calls[1].body.mode).toBe("interrupt");
      expect(agents.get().inflight["s-steer"]?.sendId).toBe("m-interrupt");
      await agents.send("s-steer", "普通");
      expect("mode" in calls[2].body).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      agents.forget("s-steer");
    }
  });
});

describe("the trajectory marks the step a steer came into", () => {
  it("the words hang on the step of the tool call the turn had just made", async () => {
    const { buildTurns } = await import("./trajectoryModel.ts");
    const items = [
      { id: "u1", kind: "user", text: "读 5 个", at: 1000, source: "agora" },
      { id: "t1", kind: "tool", at: 2000, endAt: 2100, msg: "m1", tool: { name: "Read", input: "f1", output: "x" } },
      { id: "steer-m-1", kind: "notice", tone: "steer", at: 2200, afterId: "t1", text: "你在这里插了一句：停一下，只读前两个" },
      { id: "t2", kind: "tool", at: 3000, endAt: 3100, msg: "m2", tool: { name: "Read", input: "f2", output: "x" } },
    ] as import("./agents.ts").Item[];
    const [t] = buildTurns(items, { model: "m", effort: "" }, false);
    const at = t.steps.find((s) => s.records.some((r) => r.id === "t1"))!;
    expect(at.steers?.map((n) => n.id)).toEqual(["steer-m-1"]);
    expect(t.steps.find((s) => s.records.some((r) => r.id === "t2"))!.steers).toBeUndefined();
  });
});

describe("steerAbility: the CLI's, unless the session's last turn fell back to the one-shot way", () => {
  it("the adapter's ability when the session has nothing to add", () => {
    expect(steerAbility({ steer: true }, { steer: true, steerWhy: null })).toEqual({ steer: true, noSteer: "" });
    expect(steerAbility({ steer: true }, { steer: null, steerWhy: null })).toEqual({ steer: true, noSteer: "" }); // its process is not up yet: the server queues what comes too early
    expect(steerAbility({ steer: false, noSteer: "只收一条" }, undefined)).toEqual({ steer: false, noSteer: "只收一条" });
  });
  it("a fallback turns a steer into the choice, with the fallback's reason", () => {
    const a = steerAbility({ steer: true }, { steer: false, steerWhy: "app-server 起来就退出了：unrecognized subcommand" });
    expect(a).toEqual({ steer: false, noSteer: "app-server 起来就退出了：unrecognized subcommand" });
    expect(planSend({ running: true, terminalAlive: false, ...a })).toEqual({ kind: "choose", reason: a.noSteer });
  });
});
