// The session input box while the agent works (ST1/ST2): what it says and offers for a CLI that takes words into the turn, and for one that cannot.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import { Composer } from "./Composer";
import type { SendPlan } from "./steerModel";

const html = (plan: SendPlan, working = true) => renderToStaticMarkup(<Composer canvasId="c1" agentName="Codex" onSend={async () => {}} working={working} plan={plan} onStop={() => {}} />);

describe("Composer while the agent works", () => {
  it("steer: the words go into the turn, no question asked", () => {
    const out = html({ kind: "steer", mode: "steer" });
    expect(out).toContain("Codex 在干活，你的话会直接插进这一轮");
    expect(out).not.toContain("停下这一轮，改说这句");
  });
  it("a CLI that cannot: two ways, the first (stop and say it now) chosen, and why it cannot", () => {
    const out = html({ kind: "choose", reason: "Grok 的 -p 只收启动时的一条提示" });
    expect(out).toContain("Codex 不能中途插话：Grok 的 -p 只收启动时的一条提示");
    const radios = [...out.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain("checked");
    expect(radios[1]).not.toContain("checked");
    expect(out.indexOf("停下这一轮，改说这句")).toBeLessThan(out.indexOf("等这一轮做完再说"));
  });
  it("idle: nothing extra", () => {
    const out = html({ kind: "send", mode: "auto" }, false);
    expect(out).not.toContain("sp-ways");
    expect(out).toContain("给 Codex 发消息");
  });
});
