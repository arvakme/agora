const I = (d: string) => (p: { size?: number }) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

/** The one comment glyph: the pin's own teardrop (¾ circle + square bottom-left corner). */
export const COMMENT_PATH = "M4.5 19.5V12a7.5 7.5 0 1 1 7.5 7.5Z";
export const IconComment = I(COMMENT_PATH);
export const IconCheck = I("M5 12.5 10 17 19 7");
export const IconUndo = I("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11");
export const IconSpark = I("M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5");
export const IconReopen = I("M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4");
export const IconAlert = I("M12 8v5M12 16.5v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z");
export const IconClose = I("M6 6l12 12M18 6 6 18");
export const IconSelect = I("M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4M9 9h6v6H9z");
export const IconSend = I("M5 12h13M13 6l6 6-6 6");
export const IconPanel = I("M4 5h16v14H4zM14 5v14");
export const IconReset = I("M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4");
export const IconPlus = I("M12 5v14M5 12h14");
export const IconPointer = I("M5 4l6.5 16 2.2-6.8L20.5 11z");
export const IconList = I("M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01");
export const IconSingle = I("M4 5h16v14H4z");
export const IconCols = I("M4 5h16v14H4zM12 5v14");
export const IconRows = I("M4 5h16v14H4zM4 12h16");
export const IconGrid = I("M4 5h16v14H4zM12 5v14M4 12h16");
/** Anchor mark for "pinned to": a node with a lead line (distinct from the comment teardrop). */
export const IconAnchor = I("M12 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 8.5V20M5 13a7 7 0 0 0 14 0");
export const IconPencil = I("M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4");
/** Built-in asset library: a few ready-made parts. */
export const IconAssets = I("M4 4h7v7H4zM15.5 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM4 20l3.5-6 3.5 6zM14 14h7v7h-7z");
export const IconTrash = I("M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5");
