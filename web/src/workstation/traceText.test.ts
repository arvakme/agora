// The route's words: what a stop's number and its sub-diagram note mean, said so a first-time viewer gets it.
import { describe, expect, it } from "vitest";
import { ROUTE_LEGEND, routeBarText, stopEntryText } from "./traceText.ts";

describe("stopEntryText", () => {
  it("says which stop it is and where it went in", () => {
    expect(stopEntryText(1, ["文件 · 云电脑 · 记忆 · 语音"])).toBe("第 1 站 · 在子图「文件 · 云电脑 · 记忆 · 语音」里");
  });
  it("a node's label is its first line (the following ones are code paths)", () => {
    expect(stopEntryText(1, ["文件 · 云电脑\ncomponents/file · computer"])).toBe("第 1 站 · 在子图「文件 · 云电脑」里");
    // as the geometry hands it over: the lines collapsed into one
    expect(stopEntryText(1, ["文件 · 云电脑 · 记忆 · 语音 components/file · computer memory · speech"])).toBe("第 1 站 · 在子图「文件 · 云电脑 · 记忆 · 语音」里");
  });
  it("several sub-diagrams are listed with 、", () => {
    expect(stopEntryText(3, ["文件", "语音"])).toBe("第 3 站 · 在子图「文件、语音」里");
  });
});
describe("route bar", () => {
  it("names the turn; the legend says what the numbers are", () => {
    expect(routeBarText(6)).toBe("第 6 轮的路线");
    expect(routeBarText(null)).toBe("这一轮的路线");
    expect(ROUTE_LEGEND).toBe("数字 = 这一轮先后到过的地方");
  });
});
