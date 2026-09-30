// The buttons on a change, as the person sees them: words next to the icon, the state after 撤销, the reason a button is off.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import { MarkButton, UndoButtons } from "./StepActs";

const undo = (p: Partial<Parameters<typeof UndoButtons>[0]> = {}) =>
  renderToStaticMarkup(<UndoButtons undone={false} canRedo={false} canAct onUndo={() => {}} onRedo={() => {}} {...p} />);
const mark = (p: Partial<Parameters<typeof MarkButton>[0]> = {}) =>
  renderToStaticMarkup(<MarkButton touched={["a"]} live={1} undone={false} on={false} onToggle={() => {}} {...p} />);

describe("UndoButtons", () => {
  it("writes 撤销 next to the icon and explains it on hover and to a screen reader", () => {
    const out = undo();
    expect(out).toMatch(/<button[^>]*aria-label="撤销这一步（把画布退回这一步之前）"[^>]*title="撤销这一步（把画布退回这一步之前）"/);
    expect(out).toContain('<span class="act-label">撤销</span>');
    expect(out).toContain("<svg");
  });

  it("after 撤销: 已撤销 and 重做, no 撤销 left", () => {
    const out = undo({ undone: true, canRedo: true });
    expect(out).toContain("已撤销");
    expect(out).toContain('<span class="act-label">重做</span>');
    expect(out).not.toContain('<span class="act-label">撤销</span>');
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
  it("says what it marks, in words", () => {
    const out = mark();
    expect(out).toContain('<span class="act-label">标出改动</span>');
    expect(out).toMatch(/<button[^>]*title="在图上标出这一步改了什么"/);
    expect(out).toContain('aria-pressed="false"');
  });

  it("when on: 已标出 and pressed", () => {
    const out = mark({ on: true });
    expect(out).toContain('<span class="act-label">已标出</span>');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("已标出 · 再点取消");
  });

  it("is off with the reason when the step did not touch the canvas", () => {
    const out = mark({ touched: [], live: 0 });
    expect(out).toMatch(/<button[^>]*disabled/);
    expect(out).toContain("这一步没有改画布");
  });
});
