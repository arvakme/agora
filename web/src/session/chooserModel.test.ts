// The chooser's fields and start button in the three states of the model list (session/chooserModel.ts).
import { describe, expect, it } from "vitest";
import { chooserView, NO_LIST_NOTE } from "./chooserModel.ts";

describe("chooserView", () => {
  it("loading: both fields say so and nothing can be started yet", () => {
    const v = chooserView("loading");
    expect([v.model, v.effort, v.canStart, v.fields, v.note]).toEqual(["读取中…", "读取中…", false, false, null]);
  });
  it("failed: a line says the list was not read, 「重试」 is offered, and the session still starts on the CLI's defaults", () => {
    const v = chooserView("failed");
    expect(v.note).toBe(NO_LIST_NOTE);
    expect(v.retry).toBe(true);
    expect(v.canStart).toBe(true);
    expect([v.model, v.effort]).toEqual(["CLI 默认", "CLI 默认"]);
    expect(v.fields).toBe(false);
  });
  it("ready: the fields are live; a CLI with no effort levels says it has none, not 「不支持」", () => {
    const v = chooserView("ready", { hasLevels: false });
    expect(v.fields && v.canStart).toBe(true);
    expect(v.effort).toBe("这个 CLI 不分强度");
    expect(v.note).toBeNull();
    expect(chooserView("ready", { hasLevels: true }).effort).toBe("CLI 默认");
  });
});
