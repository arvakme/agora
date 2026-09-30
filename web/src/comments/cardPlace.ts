// Where a comment card (or the composer) opens on the canvas (pure; CommentLayer.tsx measures and asks here).
// Beside its pin — the pin sits on the top-right corner of the element the comment is about, so the card opens
// away from that element: to the right of the pin, to its left when the pane has no room on the right, the other
// side when the first one lies over the element, else straight below the element (or above it, in the lower half).
// Pins in the lower half open upwards so the card clears the dock. Its height is the content's, up to `maxH`, and
// is taken as `maxH` when checking what it would cover.
import type { Box } from "../canvas/clearance";

export const CARD_W = 320;
export const DOCK_CLEAR = 76;
export type CardPos = { left: number; top?: number; bottom?: number; maxH: number; flip: boolean; up: boolean };

const EDGE = 8;
/** Beside a pin: the pin's width and a gap. */
const PIN_SIDE = 28;
const PIN_GAP = 12;
/** Least height worth opening a card in (the composer, one message and the reply field), and the gap to the element. */
const MIN_ROOM = 200;
const GAP = 10;

const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export function placeCard(o: { pin: { x: number; y: number }; pane: { w: number; h: number }; avoid: readonly Box[] }): CardPos {
  const { pin: p, pane: { w: W, h: H }, avoid } = o;
  const up = p.y > H * 0.5;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, W - CARD_W - EDGE));
  const aside = (flip: boolean): CardPos => {
    const left = clampX(flip ? p.x - CARD_W - PIN_GAP : p.x + PIN_SIDE);
    if (up) {
      const bottom = Math.max(DOCK_CLEAR, H - p.y - 6);
      return { left, bottom, maxH: H - bottom - 12, flip, up };
    }
    const top = Math.max(EDGE, p.y - 34);
    return { left, top, maxH: H - top - DOCK_CLEAR, flip, up };
  };
  const rect = (c: CardPos): Box => ({ x: c.left, y: c.up ? H - c.bottom! - c.maxH : c.top!, w: CARD_W, h: c.maxH });
  const cover = (c: CardPos) => avoid.reduce((s, b) => s + overlapArea(rect(c), b), 0);

  // the side the pane has room on (right unless it does not fit and the left does), then the other
  const flip = p.x + PIN_SIDE + CARD_W > W - EDGE && p.x - CARD_W - PIN_GAP > EDGE;
  const sides = [aside(flip), aside(!flip)];
  const free = sides.find((c) => cover(c) === 0);
  if (free) return free;

  // both sides lie over the element: above or below it, in line with where the pin's side would have put the card
  const union = avoid.reduce<Box | null>((u, b) => (u ? { x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x), h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y) } : b), null);
  const stacked: CardPos[] = [];
  if (union) {
    const left = sides[0].left;
    const below = union.y + union.h + GAP;
    const roomBelow = H - below - DOCK_CLEAR;
    const bottom = Math.max(DOCK_CLEAR, H - (union.y - GAP));
    const roomAbove = H - bottom - EDGE;
    const downCard: CardPos = { left, top: below, maxH: roomBelow, flip, up: false };
    const upCard: CardPos = { left, bottom, maxH: roomAbove, flip, up: true };
    for (const c of up ? [upCard, downCard] : [downCard, upCard]) if (c.maxH >= MIN_ROOM) stacked.push(c);
  }
  const found = stacked.find((c) => cover(c) === 0);
  if (found) return found;
  // nowhere clear: the one that covers least
  return [...sides, ...stacked].reduce((best, c) => (cover(c) < cover(best) ? c : best));
}
