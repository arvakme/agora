// A guest's page re-asking where it is: what each answer means (scope.tsx).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { afterProbe, GuestEmpty } from "./scope";

describe("afterProbe", () => {
  it("a project's canvas that is refused is a canvas the owner deleted: go to where the share opens, not the ended page", () => expect(afterProbe({ project: true, probe: "ended", showingEmpty: false })).toBe("home"));
  it("a single canvas's link that is refused has ended", () => expect(afterProbe({ project: false, probe: "ended", showingEmpty: false })).toBe("ended"));
  it("a project with no canvas left shows as empty, the link stays", () => expect(afterProbe({ project: true, probe: "empty", showingEmpty: false })).toBe("empty"));
  it("while empty, a canvas coming back brings the page back; nothing yet changes nothing; a dead link ends", () => {
    expect(afterProbe({ project: true, probe: "ok", showingEmpty: true })).toBe("home");
    expect(afterProbe({ project: true, probe: "empty", showingEmpty: true })).toBe("ignore");
    expect(afterProbe({ project: true, probe: "ended", showingEmpty: true })).toBe("ended");
  });
  it("a failed ask is tried again later, never read as the end", () => expect(afterProbe({ project: true, probe: "failed", showingEmpty: false })).toBe("ignore"));
});

describe("GuestEmpty", () => {
  it("says the project has no canvas yet and that one will appear by itself", () => {
    const out = renderToStaticMarkup(<GuestEmpty />);
    expect(out).toContain("这个项目暂时没有画布");
    expect(out).toContain("自动出现");
  });
});
