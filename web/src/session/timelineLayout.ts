// The trajectory overview's geometry, with no DOM: which colour token and shape a record gets, how a
// conversation of any length is laid into a fixed width, where the pointer lands, what a hover says.
//
// Ideas from DeepSeek Harness's trajectory timeline (github.com/deepseek-ai/deepseek-harness, MIT):
// lanes by kind of record, turn boundaries, a fixed-size overview that only draws what it can show.
// Written here for Agora's records and tokens.
//
//   - colour: purple (`--tl-message`, = the accent) is the assistant's message only, and the current
//     selection is drawn by the painter in the same accent; tool calls are coloured by what they did.
//     Shape says it again for people who cannot tell the colours apart: reading is an outline, editing
//     is solid, a failed call carries a cross.
//   - width: a turn is as wide as it has records (`sequence`) or took time (`duration`). When the records
//     would be under WINDOW_UNIT px each, the oldest turns fold into density bars (their colour mix, no
//     single block) until the newest turns fit; a block that still comes out under MIN_BLOCK px merges
//     with its thin neighbours of the same colour into one band.
import { fmtDuration, type Activity, type RecordKind, type Span, type TimelineModel } from "./trajectoryModel";

// ——— kind → colour token, shape, lane ———
/** Stack order of a density bar (top to bottom); also the legend's order. */
export const CLASSES = ["fail", "user", "message", "read", "write", "run", "agent", "wait", "other"] as const;
export type Cls = (typeof CLASSES)[number];
export type Look = { cls: Cls; token: string; fill: "solid" | "hollow"; cross: boolean; lane: 0 | 1 | 2 };
export const CLASS_NAME: Record<Cls, string> = { user: "用户", message: "助手消息", read: "读文件", write: "改文件", run: "命令", agent: "子代理", wait: "等你", other: "其它工具", fail: "失败" };

const LOOKS: Record<Cls, Omit<Look, "cross">> = {
  user: { cls: "user", token: "--tl-user", fill: "solid", lane: 0 },
  message: { cls: "message", token: "--tl-message", fill: "solid", lane: 1 },
  read: { cls: "read", token: "--tl-read", fill: "hollow", lane: 2 },
  write: { cls: "write", token: "--tl-write", fill: "solid", lane: 2 },
  run: { cls: "run", token: "--tl-run", fill: "solid", lane: 2 },
  agent: { cls: "agent", token: "--tl-agent", fill: "solid", lane: 2 },
  wait: { cls: "wait", token: "--tl-wait", fill: "solid", lane: 0 }, // a question to the person sits with the person's lane
  other: { cls: "other", token: "--tl-other", fill: "solid", lane: 2 },
  fail: { cls: "fail", token: "--tl-fail", fill: "solid", lane: 2 },
};
const ACTIVITY_CLS: Record<Activity, Cls> = {
  read: "read",
  search: "read",
  webSearch: "read",
  webFetch: "read",
  write: "write",
  edit: "write",
  commands: "run",
  subagents: "agent",
  questions: "wait",
  plan: "other",
  tools: "other",
};
export function lookOf(s: { kind: RecordKind; activity?: Activity; isError: boolean }): Look {
  if (s.kind === "user") return { ...LOOKS.user, cross: false };
  if (s.kind === "message") return { ...LOOKS.message, cross: false };
  if (s.isError) return { ...LOOKS.fail, cross: true };
  return { ...LOOKS[ACTIVITY_CLS[s.activity ?? "tools"]], cross: false };
}

/** A class's own look (the legend draws one of each). */
export const lookOfClass = (cls: Cls): Look => ({ ...LOOKS[cls], cross: cls === "fail" });

// ——— geometry (px) ———
export const LANES = 3;
/** The row above the lanes: a hint when nothing is selected, the selection's caption when something is. */
export const CAPTION_ROW = 14;
export const TOP = CAPTION_ROW + 4;
export const LANE_H = 16;
export const LANE_GAP = 4;
export const LANES_BOTTOM = TOP + LANES * LANE_H + (LANES - 1) * LANE_GAP;
/** The overview's fixed height: the lanes plus a row for the turn numbers. Never grows with the conversation. */
export const HEIGHT = LANES_BOTTOM + 14;
export const laneTop = (lane: number) => TOP + lane * (LANE_H + LANE_GAP);
/** A block narrower than this folds into its neighbours. */
export const MIN_BLOCK = 1.5;
/** px per record the open turns are given before older ones are folded away. */
export const WINDOW_UNIT = 2;
/** Folded turns: a bar is at most this wide, and all of them together at most OLDER_SHARE of the width. */
export const BAR_MAX = 3;
export const OLDER_SHARE = 0.4;
const HIT_SLACK = 1;
const NONE: ReadonlySet<number> = new Set();
const KEEP_SHARE = 0.9;
const BAND_GAP = 1;

export type Seg = { turn: number; x0: number; x1: number; v0: number; v1: number; /** drawn as a density bar, not as blocks */ folded: boolean; /** every other turn carries the band ground */ alt: boolean; n: number };
type Base = { key: string; x: number; w: number; turn: number };
export type Cell = Base & { kind: "cell"; look: Look; first: number; last: number; count: 1; span: Span };
export type Band = Base & { kind: "band"; look: Look; first: number; last: number; count: number; turnTo: number; at: number; atEnd: number };
export type BarPart = { cls: Cls; count: number; frac: number };
export type Bar = Base & { kind: "bar"; n: number; parts: BarPart[]; at: number };
export type Target = Cell | Band | Bar;
export type Layout = { width: number; start: number; end: number; segs: Seg[]; cells: Cell[]; bands: Band[]; bars: Bar[] };

/**
 * `wanted`: turns to keep open as blocks (the selection's) if they fit; the newest turn is always open.
 * The rest are folded, oldest first, until what is open fits at WINDOW_UNIT px per record.
 */
export function layoutTimeline(model: TimelineModel, width: number, wanted: ReadonlySet<number> = NONE): Layout {
  const order = model.turnBoundaries;
  const byTurn = new Map<number, Span[]>();
  for (const s of model.spans) {
    const list = byTurn.get(s.turn);
    if (list) list.push(s);
    else byTurn.set(s.turn, [s]);
  }
  const n = order.map((b) => byTurn.get(b.turn)?.length ?? 0);
  // only when the wanted turns' records would each get a block (KEEP_SHARE of the width at MIN_BLOCK px each): a stretch of hundreds of turns stays as density bars, which say more than a smear
  const wantedRecords = order.reduce((a, b, i) => a + (wanted.has(b.turn) ? n[i] : 0), 0);
  const keep = wantedRecords * MIN_BLOCK <= KEEP_SHARE * width ? wanted : NONE;
  const foldedWidth = (m: number) => (m === 0 ? 0 : Math.min(OLDER_SHARE * width, m * BAR_MAX));
  const folded = order.map(() => false);
  let open = n.reduce((a, b) => a + b, 0);
  let m = 0;
  for (let i = 0; i < order.length - 1 && open * WINDOW_UNIT > width - foldedWidth(m); i++) {
    if (keep.has(order[i].turn)) continue;
    folded[i] = true;
    open -= n[i];
    m++;
  }

  // turns → segments: a folded turn gets a share of the strip by its record count; the rest split the remainder by value
  const foldedW = foldedWidth(m);
  const foldedN = n.reduce((a, c, i) => a + (folded[i] ? c : 0), 0) || 1;
  const values = order.map((b, i) => {
    const v0 = b.at;
    const next = order[i + 1]?.at ?? model.end;
    return { v0, v1: next > v0 ? next : v0 + 1 };
  });
  const openSpan = values.reduce((a, v, i) => a + (folded[i] ? 0 : v.v1 - v.v0), 0) || 1;
  const segs: Seg[] = [];
  let x = 0;
  order.forEach((b, i) => {
    const w = folded[i] ? foldedW * (0.5 / m + (0.5 * n[i]) / foldedN) : ((values[i].v1 - values[i].v0) / openSpan) * (width - foldedW);
    segs.push({ turn: b.turn, x0: x, x1: x + w, ...values[i], folded: folded[i], alt: i % 2 === 1, n: n[i] });
    x += w;
  });
  if (segs.length) segs[segs.length - 1].x1 = width;

  const cells: Cell[] = [];
  const bands: Band[] = [];
  const bars: Bar[] = [];
  const thin = new Map<number, { cell: Cell; raw: number }[]>(); // per lane, in x order
  for (const seg of segs) {
    const spans = byTurn.get(seg.turn) ?? [];
    if (seg.folded) {
      bars.push(barOf(seg, spans));
      continue;
    }
    const per = (seg.x1 - seg.x0) / (seg.v1 - seg.v0);
    for (const s of spans) {
      const cx = seg.x0 + (s.start - seg.v0) * per;
      const raw = Math.min(Math.max(s.end - s.start, 0) * per, seg.x1 - cx);
      const look = lookOf(s);
      const cell: Cell = { kind: "cell", key: `c${s.index}`, x: cx, w: Math.max(raw, MIN_BLOCK), turn: s.turn, look, first: s.index, last: s.index, count: 1, span: s };
      cells.push(cell);
      const list = thin.get(look.lane);
      if (list) list.push({ cell, raw });
      else thin.set(look.lane, [{ cell, raw }]);
    }
  }
  return { width, start: segs[0]?.v0 ?? model.start, end: segs.at(-1)?.v1 ?? model.end, segs, ...mergeThin(cells, thin), bars };
}

/** Runs of hair-thin blocks of one colour in one lane (nothing else between them) become one band. */
function mergeThin(cells: Cell[], lanes: Map<number, { cell: Cell; raw: number }[]>): { cells: Cell[]; bands: Band[] } {
  const gone = new Set<Cell>();
  const bands: Band[] = [];
  for (const list of lanes.values()) {
    let run: Cell[] = [];
    const close = () => {
      if (run.length >= 2) {
        const a = run[0];
        const z = run[run.length - 1];
        for (const c of run) gone.add(c);
        bands.push({ kind: "band", key: `b${a.first}`, x: a.x, w: Math.max(z.x + z.w - a.x, MIN_BLOCK), turn: a.turn, turnTo: z.turn, look: a.look, first: a.first, last: z.last, count: run.length, at: a.span.at, atEnd: z.span.at });
      }
      run = [];
    };
    for (const { cell, raw } of list) {
      if (raw >= MIN_BLOCK) {
        close();
        continue;
      }
      const end = run.length ? run[run.length - 1].x + run[run.length - 1].w : 0;
      if (run.length && (run[0].look.cls !== cell.look.cls || cell.x - end > BAND_GAP)) close();
      run.push(cell);
    }
    close();
  }
  return { cells: cells.filter((c) => !gone.has(c)), bands };
}

function barOf(seg: Seg, spans: Span[]): Bar {
  const count = new Map<Cls, number>();
  for (const s of spans) {
    const c = lookOf(s).cls;
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const total = spans.length || 1;
  return {
    kind: "bar",
    key: `t${seg.turn}`,
    x: seg.x0,
    w: seg.x1 - seg.x0,
    turn: seg.turn,
    n: spans.length,
    at: spans[0]?.at ?? 0,
    parts: CLASSES.filter((c) => count.has(c)).map((cls) => ({ cls, count: count.get(cls)!, frac: count.get(cls)! / total })),
  };
}

// ——— turn numbers ———
const STRIDES = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
/** Up to 14 turns: every turn is numbered. More: turns 1, 6, 11, … — every 5th, or every 10th, 20th … when those would touch; once older turns are folded, the newest turn too when there is room, so the window says where it is. */
export function labelledTurns(lay: Layout, minGap = 26): Seg[] {
  if (lay.segs.length <= 14) return lay.segs;
  const apart = (picked: Seg[]) => picked.every((s, i) => i === 0 || s.x0 - picked[i - 1].x0 >= minGap - 1e-6);
  for (const stride of STRIDES) {
    const picked = lay.segs.filter((s) => (s.turn - 1) % stride === 0);
    if (!apart(picked)) continue;
    const last = lay.segs[lay.segs.length - 1];
    return !lay.bars.length || picked.includes(last) || !apart([...picked, last]) ? picked : [...picked, last];
  }
  return lay.segs.slice(0, 1);
}

// ——— pointer ———
const laneAt = (y: number) => Math.min(LANES - 1, Math.max(0, Math.floor((y - TOP + LANE_GAP / 2) / (LANE_H + LANE_GAP))));
/** What is under (x, y) in overview coordinates: a block, a band or a density bar; the rows between lanes snap to the nearest one. */
export function hitTest(lay: Layout, x: number, y: number): Target | null {
  if (y < TOP || y > LANES_BOTTOM) return null;
  for (const b of lay.bars) if (x >= b.x && x < b.x + b.w) return b;
  const lane = laneAt(y);
  let best: Target | null = null;
  let gap = Infinity;
  for (const list of [lay.cells, lay.bands] as (Cell | Band)[][])
    for (const t of list) {
      if (t.look.lane !== lane || x < t.x - HIT_SLACK || x > t.x + t.w + HIT_SLACK) continue;
      const d = Math.abs(x - (t.x + t.w / 2));
      if (d < gap) (best = t), (gap = d);
    }
  return best;
}

const segAtX = (lay: Layout, x: number): Seg | undefined => lay.segs.find((s) => x < s.x1) ?? lay.segs.at(-1);
/** The timeline value at overview x (clamped to the ends): the drag-to-focus range is in model coordinates. */
export function valueAt(lay: Layout, x: number): number {
  if (x <= 0) return lay.start;
  if (x >= lay.width) return lay.end;
  const s = segAtX(lay, x);
  return s ? s.v0 + ((x - s.x0) / (s.x1 - s.x0 || 1)) * (s.v1 - s.v0) : lay.start;
}
export function xOf(lay: Layout, v: number): number {
  const s = lay.segs.find((g) => v < g.v1) ?? lay.segs.at(-1);
  if (!s) return 0;
  const f = Math.min(1, Math.max(0, (v - s.v0) / (s.v1 - s.v0 || 1)));
  return s.x0 + f * (s.x1 - s.x0);
}

// ——— keyboard ———
export const targetsInOrder = (lay: Layout): Target[] =>
  [...lay.cells, ...lay.bands, ...lay.bars].sort((a, b) => a.x - b.x || lane(a) - lane(b));
const lane = (t: Target) => (t.kind === "bar" ? -1 : t.look.lane);
/** The key one step left (-1) or right (1) of `key`; with no cursor yet, the first (or last) target. Stays at the ends. */
export function stepCursor(order: Target[], key: string | null, dir: 1 | -1): string | null {
  if (!order.length) return null;
  const at = key == null ? -1 : order.findIndex((t) => t.key === key);
  if (at < 0) return (dir > 0 ? order[0] : order[order.length - 1]).key;
  return order[Math.min(order.length - 1, Math.max(0, at + dir))].key;
}

// ——— hover ———
const pad = (n: number, len = 2) => String(n).padStart(len, "0");
/** Wall-clock time to the millisecond. */
export function clockMs(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
/** What the 0.5 s hover shows: a headline and lines (exact time, how long, what it was). */
export function hoverText(t: Target): { title: string; lines: string[] } {
  if (t.kind === "bar")
    return { title: `第 ${t.turn} 轮 · ${t.n} 条记录`, lines: [clockMs(t.at), t.parts.map((p) => `${CLASS_NAME[p.cls]} ${p.count}`).join(" · ")] };
  if (t.kind === "band") {
    const turns = t.turn === t.turnTo ? `第 ${t.turn} 轮` : `第 ${t.turn}–${t.turnTo} 轮`;
    return { title: `${t.count} 个「${CLASS_NAME[t.look.cls]}」 · #${t.first}–#${t.last} · ${turns}`, lines: [`${clockMs(t.at)} – ${clockMs(t.atEnd)}`] };
  }
  const s = t.span;
  const what = t.look.cls === "fail" ? "失败的工具调用" : CLASS_NAME[t.look.cls];
  const lines = [clockMs(s.at)];
  if (s.durationMs != null) lines.push(`耗时 ${s.durationMs < 1000 ? `${Math.round(s.durationMs)} ms` : fmtDuration(s.durationMs)}`);
  if (s.label) lines.push(s.label.slice(0, 160));
  return { title: `#${s.index} · ${what} · 第 ${s.turn} 轮`, lines };
}
