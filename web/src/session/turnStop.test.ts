import { describe, expect, it } from "vitest";
import { CONTINUE_WORD, stoppedForTime } from "./turnStop";

// The server's words (server/canvas/turn_clock.py `TurnClock.message`); tests/test_turn_clock.py holds the same two sentences.
const quiet = `这一轮 30 分钟没有任何输出，已中止；原生会话还在，发「${CONTINUE_WORD}」就能接着`;
const fuse = `这一轮已经跑了 6 小时，到了上限，已中止；原生会话还在，发「${CONTINUE_WORD}」就能接着`;

describe("a turn Agora stopped for going quiet or running too long", () => {
  it("is recognised by the server's words, so the panel can offer the word the message names", () => {
    expect(stoppedForTime(quiet)).toBe(true);
    expect(stoppedForTime(fuse)).toBe(true);
  });
  it("is not any other failure, even one that begins the same way", () => {
    expect(stoppedForTime("exit 1: boom")).toBe(false);
    expect(stoppedForTime("interrupted")).toBe(false);
    expect(stoppedForTime("这一轮 API 失败，发「继续」试试")).toBe(false);
    expect(stoppedForTime(null)).toBe(false);
    expect(stoppedForTime(undefined)).toBe(false);
  });
});
