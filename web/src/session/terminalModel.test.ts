import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, windowsLine } from "./terminalModel";

const t = (o: Partial<Parameters<typeof windowsLine>[0]>) => ({ alive: true, clients: 0, ...o });

describe("windowsLine (what the menu says about the terminal's windows)", () => {
  it("says there is no terminal when none runs", () => {
    expect(windowsLine(t({ alive: false }))).toMatch(/没有开着/);
  });

  it("says an open terminal nobody connected to is waiting", () => {
    expect(windowsLine(t({}))).toMatch(/还没有窗口连上/);
  });

  it("counts the windows connected", () => {
    expect(windowsLine(t({ clients: 2 }))).toMatch(/2 个窗口连着/);
  });

  it("says when a writable window or a takeover has paused delivery", () => {
    expect(windowsLine(t({ clients: 1, writers: 1 }))).toMatch(/可写.*暂停/);
    expect(windowsLine(t({ clients: 1, inputRight: "human" }))).toMatch(/接管.*暂停/);
  });
});

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true when the clipboard took it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("cmd")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("cmd");
  });

  it("is false when the clipboard refuses or the page has none", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyText("cmd")).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyText("cmd")).toBe(false);
  });
});
