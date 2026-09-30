// Under the message that was sent with a selection: a thumbnail of just those elements and 「选区 · N 个元素」;
// hovering lists their names. A message from before pictures has the names but no thumbnail.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the canvas modules pull in Excalidraw's runtime for builders this test does not use
vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import { SelectionView } from "./SelectionAttachment";

const els = [{ id: "o-api", name: "API 服务" }, { id: "o-db", name: "MySQL" }];
const html = (props: Partial<Parameters<typeof SelectionView>[0]> = {}) => renderToStaticMarkup(<SelectionView elements={els} thumb="/api/agent/selections/sel-0a1b2c3d4e/thumb.svg" onPick={() => {}} {...props} />);

describe("SelectionView", () => {
  it("shows the saved picture and how many elements it is", () => {
    const out = html();
    expect(out).toContain('src="/api/agent/selections/sel-0a1b2c3d4e/thumb.svg"');
    expect(out).toContain("选区 · 2 个元素");
  });

  it("lists the element names for hovering, and never an id on its own", () => {
    const out = html();
    expect(out).toMatch(/role="tooltip"[^>]*>.*API 服务.*MySQL/s);
    expect(out).not.toContain("o-api");
  });

  it("without a picture (an old message) is the chip and the names, no image", () => {
    const out = html({ thumb: undefined });
    expect(out).not.toContain("<img");
    expect(out).toContain("选区 · 2 个元素");
  });

  it("is one button that marks the elements on the canvas", () => {
    expect(html()).toMatch(/<button[^>]*aria-label="在图上标出这 2 个元素（再点取消）"/);
  });
});
