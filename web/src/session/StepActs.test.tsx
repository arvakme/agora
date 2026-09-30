// The buttons on a change, as the person sees them: a word next to the icon (an icon alone was read as 运行), the state after 撤销,
// the button that is off, and a name for a screen reader. What the words and the reasons are: stepUi.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import { MarkButton, UndoButtons } from "./StepActs";

const undo = (p: Partial<Parameters<typeof UndoButtons>[0]> = {}) =>
  renderToStaticMarkup(<UndoButtons undone={false} canRedo={false} canAct onUndo={() => {}} onRedo={() => {}} {...p} />);
const mark = (p: Partial<Parameters<typeof MarkButton>[0]> = {}) =>
  renderToStaticMarkup(<MarkButton touched={["a"]} live={1} undone={false} on={false} onToggle={() => {}} {...p} />);

describe("UndoButtons", () => {
  it("writes 撤销 next to the icon, and names the button for a screen reader", () => {
    const out = undo();
    expect(out).toContain(">撤销</span>");
    expect(out).toMatch(/<button[^>]*aria-label="[^"]+"/);
    expect(out).toContain("<svg");
  });

  it("after 撤销: 已撤销 and 重做, no 撤销 left", () => {
    const out = undo({ undone: true, canRedo: true });
    expect(out).toContain("已撤销");
    expect(out).toContain(">重做</span>");
    expect(out).not.toContain(">撤销</span>");
  });

  it("after a reload: 已撤销 with no button", () => {
    const out = undo({ undone: true, canRedo: false });
    expect(out).toContain("已撤销");
    expect(out).not.toContain("<button");
  });

  it("is disabled when the canvas is not open", () => {
    expect(undo({ canAct: false })).toMatch(/<button[^>]*disabled/);
  });
});

describe("MarkButton", () => {
  it("writes 标出改动 next to the icon; pressed once on, and then says 已标出", () => {
    const off = mark();
    expect(off).toContain(">标出改动</span>");
    expect(off).toContain('aria-pressed="false"');
    const on = mark({ on: true });
    expect(on).toContain(">已标出</span>");
    expect(on).toContain('aria-pressed="true"');
  });

  it("is disabled when the step did not touch the canvas", () => {
    expect(mark({ touched: [], live: 0 })).toMatch(/<button[^>]*disabled/);
  });
});
