import { MENTION_LIST_CLASS } from "../comments/mention";
// A press inside one of these is not "outside the card": it leaves the open thread and the unsent pin alone
// (CanvasView.tsx `onPointerDownCapture`). Portals count too — React sends their events up through the canvas.
export const KEEPS_CARD_OPEN = `.tcard, .pin, .drawer, .ptr-ui, .undo-toast, .nest-mark, .nest-crumbs, .ws-ui, .${MENTION_LIST_CLASS}`;
