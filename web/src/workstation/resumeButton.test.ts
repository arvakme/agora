// 「继续跟随 <agent>」 shows only while there is something to follow (liveCamera.ts `showResume`): the camera is paused, the
// followed turn is at work (`isWorking`, the camera's own standard) and its figure is on this canvas or in the tray.
import { describe, expect, it } from "vitest";
import { showResume } from "./liveCamera.ts";

const working = { running: true, segs: [] };
const idle = { running: false, segs: [{ start: 0, end: 1000 }] };
const inCall = { running: false, segs: [{ start: 4000, end: 9000 }] };
const NOW = 5000;

describe("showResume", () => {
  it("at work, the camera stopped by the person, and its figure in view: yes", () => {
    expect(showResume({ paused: true, run: working, now: NOW, drawn: true })).toBe(true);
    expect(showResume({ paused: true, run: inCall, now: NOW, drawn: true })).toBe(true); // a call in progress is work too
  });
  it("idle, or gone after its turn ended: no — there is nothing to go and follow", () => {
    expect(showResume({ paused: true, run: idle, now: NOW, drawn: true })).toBe(false);
    expect(showResume({ paused: true, run: idle, now: NOW, drawn: false })).toBe(false);
  });
  it("it starts working again while still paused: the button is back", () => {
    expect(showResume({ paused: true, run: idle, now: NOW, drawn: true })).toBe(false);
    expect(showResume({ paused: true, run: { ...idle, running: true }, now: NOW, drawn: true })).toBe(true);
  });
  it("at work but not to be seen on this canvas (it is in another one): no", () => {
    expect(showResume({ paused: true, run: working, now: NOW, drawn: false })).toBe(false);
  });
  it("the camera not stopped, or nobody followed: no", () => {
    expect(showResume({ paused: false, run: working, now: NOW, drawn: true })).toBe(false);
    expect(showResume({ paused: true, run: null, now: NOW, drawn: true })).toBe(false);
  });
});
