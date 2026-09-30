import { describe, expect, it } from "vitest";
import { CONTINUE_WORD, stoppedForTime } from "./turnStop";

describe("a turn Agora stopped for going quiet or running too long", () => {
  it("is recognised by the server's words, so the panel can offer 继续", () => {
    expect(stoppedForTime("这一轮 30 分钟没有任何输出，已中止；原生会话还在，发「继续」就能接着")).toBe(true);
    expect(stoppedForTime("这一轮已经跑了 6 小时，到了上限，已中止；原生会话还在，发「继续」就能接着")).toBe(true);
  });
  it("is not any other failure", () => {
    expect(stoppedForTime("exit 1: boom")).toBe(false);
    expect(stoppedForTime("interrupted")).toBe(false);
    expect(stoppedForTime("codex: 这一轮 API 失败，发「继续」试试")).toBe(false);
    expect(stoppedForTime(null)).toBe(false);
    expect(stoppedForTime(undefined)).toBe(false);
  });
  it("continues with the word the message names", () => {
    expect(CONTINUE_WORD).toBe("继续");
  });
});
