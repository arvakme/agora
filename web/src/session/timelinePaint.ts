// Draws a Layout on a canvas (one canvas, a few hundred shapes however long the conversation is).
// Colours are the theme's tokens, read from the element's computed style, so light and dark follow the page.
import { CLASSES, HEIGHT, LANES_BOTTOM, LANE_H, TOP, labelledTurns, laneTop, type Cls, type Layout, type Target } from "./timelineLayout";

export type Palette = Record<Cls, string> & { band: string; line: string; ink: string; subtle: string; accent: string; ground: string };
const TOKEN: Record<Cls, string> = { user: "--tl-user", message: "--tl-message", read: "--tl-read", write: "--tl-write", run: "--tl-run", agent: "--tl-agent", wait: "--tl-wait", other: "--tl-other", fail: "--tl-fail" };

export function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const p = { band: v("--tl-band", "rgb(0 0 0 / 0.04)"), line: v("--line-strong", "#79838a"), ink: v("--fg", "#2c3136"), subtle: v("--fg-subtle", "#687076"), accent: v("--accent", "#7048b4"), ground: v("--code-surface", "#f7f8f8") } as Palette;
  for (const c of CLASSES) p[c] = v(TOKEN[c], "#888");
  return p;
}

export type PaintState = {
  /** The record picked in the ledger (its block gets the selection ring). */
  selected: number | null;
  /** The turn the ledger, the replay or the selection is on (its band is outlined). */
  turn: number | null;
  /** Under the pointer, or the keyboard cursor. */
  hot: Target | null;
  cursor: Target | null;
};

const GAP = 0.5;
const ROUND = 2;
const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  if (w >= 5 && "roundRect" in ctx) ctx.roundRect(x, y, w, h, ROUND);
  else ctx.rect(x, y, w, h);
}

export function paintTimeline(ctx: CanvasRenderingContext2D, lay: Layout, pal: Palette, st: PaintState) {
  ctx.clearRect(0, 0, lay.width, HEIGHT);
  // ground: every other turn a little darker, a dashed line where a turn starts
  for (const s of lay.segs) {
    if (s.folded) continue;
    if (s.alt) {
      ctx.fillStyle = pal.band;
      ctx.fillRect(s.x0, 0, s.x1 - s.x0, LANES_BOTTOM + 4);
    }
  }
  ctx.save();
  ctx.strokeStyle = pal.line;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  for (const s of lay.segs) {
    if (s.folded) continue;
    const x = Math.round(s.x0) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, LANES_BOTTOM + 4);
  }
  ctx.stroke();
  ctx.restore();

  // folded turns: the colour mix of each, stacked over the height of the lanes
  const area = LANES_BOTTOM - TOP;
  for (const b of lay.bars) {
    let y = TOP;
    for (const p of b.parts) {
      const h = Math.max(1, p.frac * area);
      ctx.fillStyle = pal[p.cls];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(b.x, y, Math.max(b.w, 1), h);
      y += h;
    }
    ctx.globalAlpha = 1;
  }

  for (const b of lay.bands) {
    ctx.fillStyle = pal[b.look.cls];
    ctx.globalAlpha = b.look.fill === "hollow" ? 0.5 : 0.8;
    ctx.fillRect(b.x, laneTop(b.look.lane), b.w, LANE_H);
    ctx.globalAlpha = 1;
  }
  for (const c of lay.cells) {
    const y = laneTop(c.look.lane);
    const w = c.w > 3 ? c.w - GAP : c.w;
    const color = pal[c.look.cls];
    if (c.look.fill === "hollow" && w >= 4) {
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      rect(ctx, c.x, y, w, LANE_H);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      rect(ctx, c.x + 0.75, y + 0.75, w - 1.5, LANE_H - 1.5);
      ctx.stroke();
    } else {
      ctx.globalAlpha = c.look.fill === "hollow" ? 0.6 : 1;
      ctx.fillStyle = color;
      rect(ctx, c.x, y, w, LANE_H);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (c.look.cross) {
      if (w >= 7) {
        const cx = c.x + w / 2;
        const cy = y + LANE_H / 2;
        ctx.strokeStyle = pal.ground;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 3);
        ctx.lineTo(cx + 3, cy + 3);
        ctx.moveTo(cx + 3, cy - 3);
        ctx.lineTo(cx - 3, cy + 3);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(c.x, y - 3, w, 3); // too narrow for a cross: a cap above the block
      }
    }
  }

  // the turn the person is on; the record they picked
  const cur = st.turn == null ? null : lay.segs.find((s) => s.turn === st.turn);
  if (cur) {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1.5;
    rect(ctx, cur.x0 + 0.75, 1.5, Math.max(cur.x1 - cur.x0 - 1.5, 2), LANES_BOTTOM + 1);
    ctx.stroke();
  }
  const pick = st.selected == null ? null : (lay.cells.find((c) => c.first === st.selected) ?? lay.bands.find((b) => st.selected! >= b.first && st.selected! <= b.last));
  if (pick) ring(ctx, pick.x, laneTop(pick.look.lane), pick.w, pal.ground, pal.accent);
  if (st.hot) outline(ctx, st.hot, pal.ink, [], 1);
  if (st.cursor && st.cursor !== st.hot) outline(ctx, st.cursor, pal.ink, [3, 2], 1.25);

  // turn numbers
  ctx.fillStyle = pal.subtle;
  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";
  for (const s of labelledTurns(lay)) ctx.fillText(String(s.turn), Math.min(s.x0 + 3, lay.width - 14), HEIGHT - 2);
}

/** A ring in the accent with a hairline of the ground inside it, so it reads on a purple message block too. */
function ring(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, ground: string, accent: string) {
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = ground;
  ctx.strokeRect(x - 1, y - 1, w + 2, LANE_H + 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = accent;
  ctx.strokeRect(x - 1.5, y - 1.5, w + 3, LANE_H + 3);
}

function outline(ctx: CanvasRenderingContext2D, t: Target, color: string, dash: number[], width: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  if (t.kind === "bar") ctx.strokeRect(t.x - 0.5, TOP - 1.5, Math.max(t.w, 1) + 1, LANES_BOTTOM - TOP + 3);
  else ctx.strokeRect(t.x - 1, laneTop(t.look.lane) - 1, t.w + 2, LANE_H + 2);
  ctx.restore();
}
