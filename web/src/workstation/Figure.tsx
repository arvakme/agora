// One worker: a small procedural figure (graphite strokes, the agent's avatar as its head) in a
// pose for what its session is doing. Vector only, drawn at device pixels, so it stays sharp at
// any zoom and on 2x/3x screens. Every limb angle is a function of time — no per-frame state.
import { AgentAvatar } from "../session/AgentAvatar";
import type { AgentKind } from "../session/agents";
import type { Pose } from "./timeline";

const W = 32;
const H = 52;
const rad = (d: number) => (d * Math.PI) / 180;

/** A limb from (x, y), `len` long, at `deg` from straight down (positive = towards +x). */
const limb = (x: number, y: number, len: number, deg: number) => ({ x2: x + Math.sin(rad(deg)) * len, y2: y + Math.cos(rad(deg)) * len });

export type FigureProps = { kind?: AgentKind; pose: Pose; t: number; still: boolean; faded?: boolean };

/** Legs (degrees from straight down), hands (offsets from the body centre at shoulder height) and bob for a pose at time t (ms). `still` = reduced motion. */
export function poseAt(pose: Pose, t: number, still: boolean) {
  const s = (period: number, amp: number, offset = 0) => (still ? 0 : Math.sin(((t / period) * 2 + offset) * Math.PI) * amp);
  const tap = (offset: number) => (still ? 0 : Math.max(0, Math.sin(((t / 170) * 2 + offset) * Math.PI)) * 1.2);
  switch (pose) {
    case "walk":
      return { legL: s(640, 26), legR: -s(640, 26), hl: [-4 - s(640, 3), 11], hr: [4 + s(640, 3), 11], bob: still ? 0 : -Math.abs(Math.sin((t / 640) * 2 * Math.PI)) * 1.4, lean: 0 };
    case "write":
      return { legL: -8, legR: 8, hl: [-6, 9.5 - tap(0)], hr: [6, 9.5 - tap(0.6)], bob: 0, lean: 0 };
    case "exec":
      return { legL: -8, legR: 8, hl: [-6, 9.5], hr: [6, 9.5 - tap(0.3) * 0.6], bob: 0, lean: 0 };
    case "read":
      return { legL: -7, legR: 7, hl: [-6.5, 5 + s(2400, 0.6)], hr: [6.5, 5 + s(2400, 0.6)], bob: 0, lean: s(3000, 2) };
    case "think":
      return { legL: -6, legR: 6, hl: [-5, 11], hr: [3, -4], bob: 0, lean: s(2600, 2.5) };
    case "wait":
      return { legL: -8, legR: 8, hl: [-5, 11], hr: [9 + s(1100, 2.2), -9], bob: 0, lean: 0 };
    default:
      return { legL: -5, legR: 5, hl: [-5, 12], hr: [5, 12], bob: still ? 0 : s(4000, 0.5), lean: 0 };
  }
}

export function Figure({ kind, pose, t, still, faded }: FigureProps) {
  const a = poseAt(pose, t, still);
  const hipY = 36 + a.bob;
  const shY = 22 + a.bob;
  const cx = W / 2;
  // An arm: shoulder → elbow (pushed outward) → hand.
  const arm = (side: -1 | 1, [hx, hy]: number[]) => {
    const sx = cx + side * 1.5;
    const x = cx + hx;
    const y = shY + hy;
    const ex = (sx + x) / 2 + side * 3;
    const ey = (shY + y) / 2 + 1.5;
    return `M${sx} ${shY}L${ex.toFixed(2)} ${ey.toFixed(2)}L${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  const holding = pose === "write" || pose === "exec";
  const dot = (i: number) => (still ? 0.8 : 0.25 + 0.75 * Math.max(0, Math.sin(((t / 1200) * 2 - i * 0.33) * Math.PI)));
  return (
    <div className="ws-fig" data-pose={pose} data-faded={faded || undefined} style={{ width: W, height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false">
        <g transform={`rotate(${a.lean} ${cx} ${hipY})`}>
          <g stroke="var(--ws-ink)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none">
            <line x1={cx - 1} y1={hipY} {...limb(cx - 1, hipY, 13, a.legL)} />
            <line x1={cx + 1} y1={hipY} {...limb(cx + 1, hipY, 13, a.legR)} />
            <line x1={cx} y1={shY - 1} x2={cx} y2={hipY} />
          </g>
          {holding && (
            // a small laptop held in front: purple screen while writing, a graphite prompt while running a command
            <g>
              <rect x={cx - 7} y={shY + 1} width={14} height={9} rx={1.5} fill={pose === "write" ? "var(--accent)" : "var(--ws-ink)"} />
              {pose === "exec" && <path d={`M${cx - 4.5} ${shY + 3.4}l2 1.6-2 1.6M${cx - 1} ${shY + 6.6}h3`} stroke="var(--bg)" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={still || Math.floor(t / 530) % 2 ? 1 : 0.35} />}
              {pose === "write" && <path d={`M${cx - 4.5} ${shY + 3.4}h9M${cx - 4.5} ${shY + 5.6}h${3 + (still ? 4 : (Math.floor(t / 180) % 5) + 1)}`} stroke="var(--accent-fg)" strokeWidth={0.9} strokeLinecap="round" fill="none" />}
            </g>
          )}
          {pose === "read" && (
            <g>
              <rect x={cx - 6} y={shY} width={12} height={10} rx={1} fill="var(--surface)" stroke="var(--ws-ink)" strokeWidth={1} />
              <path d={`M${cx - 3.5} ${shY + 2.5}h7M${cx - 3.5} ${shY + 4.8}h7M${cx - 3.5} ${shY + 7.1}h4`} stroke="var(--accent)" strokeWidth={0.9} strokeLinecap="round" />
            </g>
          )}
          <path d={`${arm(-1, a.hl)}${arm(1, a.hr)}`} stroke="var(--ws-ink)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
        {pose === "think" && [0, 1, 2].map((i) => <circle key={i} cx={cx + 9 + i * 3.6} cy={4 - i * 1.4} r={1.2} fill="var(--fg-muted)" opacity={dot(i)} />)}
        {pose === "wait" && (
          <g>
            <circle cx={cx + 11.5} cy={4.5} r={4} fill="var(--surface)" stroke="var(--caution-dot)" strokeWidth={1} />
            <path d={`M${cx + 10.3} ${3.4}a1.25 1.25 0 1 1 1.7 1.15v.75`} stroke="var(--caution)" strokeWidth={0.9} fill="none" strokeLinecap="round" />
            <circle cx={cx + 12} cy={6.9} r={0.5} fill="var(--caution)" />
          </g>
        )}
      </svg>
      <span className="ws-head" style={{ transform: `translate(${cx - 8}px, ${Math.round((4 + a.bob) * 2) / 2}px)` }}>
        {kind ? <AgentAvatar kind={kind} size={16} /> : <span className="ws-head-dot" />}
      </span>
    </div>
  );
}
export const FIGURE = { W, H };
