// One terminal statement in the session pane: a window that can write is open → say so once, with 现在送出 / 接管;
// no window → nothing terminal-ish at all.
import { describe, expect, it } from "vitest";
import { windowNote } from "./requestModel.ts";

const term = (o: Partial<{ alive: boolean; clients: number; inputRight: "host" | "human"; paused: boolean; writers: number }> = {}) => ({ alive: true, attach: "", app: "tmux" as const, clients: 0, inputRight: "host" as const, paused: false, writers: 0, ...o });

describe("windowNote", () => {
  it("a writable window is open: the N2 words and both buttons, even with nothing queued yet", () => {
    const n = windowNote({ queued: 0, held: null, terminal: term({ clients: 1, writers: 1 }) });
    expect(n).toEqual({ text: "终端窗口开着 · 你的话在排队", by: "window", canSendNow: false, canTakeOver: true, takenOver: false });
  });
  it("with messages queued 现在送出 works", () => {
    expect(windowNote({ queued: 2, held: "x", terminal: term({ clients: 1, writers: 1 }) })?.canSendNow).toBe(true);
  });
  it("a takeover reads as before and offers to give it back", () => {
    expect(windowNote({ queued: 0, held: null, terminal: term({ clients: 0, inputRight: "human", paused: true }) })).toMatchObject({ by: "takeover", takenOver: true });
  });
  it("no window (the CLI only finishing in the background, or no terminal): nothing", () => {
    expect(windowNote({ queued: 1, held: null, terminal: term() })).toBeNull();
    expect(windowNote({ queued: 0, held: null, terminal: term({ alive: false }) })).toBeNull();
  });
});
