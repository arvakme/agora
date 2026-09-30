// While a camera holds the canvas away, the layout is not saved (layoutSaves) and the 「在子图里」 hint stays away
// (backHintQuiet); several cameras may hold at once (workstation/replayQuiet.ts). 「可能过时」 does not follow this: see nested/staleDot.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutSaves } from "../layoutSaves";
import { backHintQuiet } from "../nested/up";
import { quiet } from "./replayQuiet.ts";

const pauses = vi.fn();
layoutSaves.register(pauses);
afterEach(() => {
  quiet.hold("live", false);
  quiet.hold("play", false);
  pauses.mockClear();
});

describe("quiet holds", () => {
  it("the first hold pauses the layout saves and quiets the hint; the last release lifts both", () => {
    quiet.hold("live", true);
    expect(pauses.mock.calls).toEqual([[true]]);
    expect(backHintQuiet.get()).toBe(true);
    quiet.hold("live", false);
    expect(pauses.mock.calls).toEqual([[true], [false]]);
    expect(backHintQuiet.get()).toBe(false);
  });
  it("quiet while any camera holds it: one pause, one resume, however many hold", () => {
    quiet.hold("live", true);
    quiet.hold("play", true);
    quiet.hold("live", false);
    expect(pauses.mock.calls).toEqual([[true]]);
    expect(backHintQuiet.get()).toBe(true);
    quiet.hold("play", false);
    expect(pauses.mock.calls).toEqual([[true], [false]]);
    expect(backHintQuiet.get()).toBe(false);
  });
  it("releasing what was never held changes nothing", () => {
    quiet.hold("play", false);
    expect(pauses).not.toHaveBeenCalled();
    expect(backHintQuiet.get()).toBe(false);
  });
});
