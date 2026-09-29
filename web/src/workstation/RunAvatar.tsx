// An agent run's avatar: the six known agents through AgentAvatar, any other CLI (or a worker
// known only by its receipts) as a letter on the same tile. Also the SVG symbols the figures'
// heads use (<WorkerDefs/>, mounted once by the app shell).
import { ClaudeMark, CursorMark, DevinMark, PiMark } from "../app/agents/marks";
import { AgentAvatar, type AvatarSize } from "../session/AgentAvatar";
import { hasOwnMark } from "../session/agentMarks";
import type { AgentKind } from "../session/agents";
import { LETTERS, symbolId, type SYMBOL_AGENTS } from "./headMark";

export function RunAvatar({ agent, size = 16, parent }: { agent: string; size?: AvatarSize | 14 | 18 | 22; parent?: string }) {
  const s = size as AvatarSize;
  const face = hasOwnMark(agent) ? (
    <AgentAvatar kind={agent as AgentKind} size={s} />
  ) : (
    <span className="agent-avatar run-letter" style={{ "--av": `${size}px` } as React.CSSProperties} aria-hidden>
      {LETTERS[agent] ?? (agent[0] ?? "?").toUpperCase()}
    </span>
  );
  if (!parent) return face;
  return (
    <span className="run-av-wrap">
      {face}
      <span className="run-pbadge" aria-hidden>
        {hasOwnMark(parent) ? <AgentAvatar kind={parent as AgentKind} size={16} /> : null}
      </span>
    </span>
  );
}

/** Each vector mark as a <symbol> (its viewBox is the mark's own; paths come from app/agents/marks.tsx, never copied). Ids: ./headMark.ts `symbolId`. */
const SYMBOLS: Record<(typeof SYMBOL_AGENTS)[number], { viewBox: string; Mark: () => React.ReactElement }> = {
  pi: { viewBox: "0 0 560 560", Mark: PiMark },
  claude: { viewBox: "0.17 1.1 25 25", Mark: ClaudeMark },
  cursor: { viewBox: "0 0 512 512", Mark: CursorMark },
  devin: { viewBox: "70 50 287 327", Mark: DevinMark },
};

/** Symbols for the figures' heads (ids ws-m-pi, ws-m-claude, ws-m-cursor, ws-m-devin). */
export function WorkerDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <defs>
        {Object.entries(SYMBOLS).map(([agent, { viewBox, Mark }]) => (
          <symbol key={agent} id={symbolId(agent)} viewBox={viewBox}>
            {/* the mark's paths, lifted out of its <svg> wrapper */}
            {(Mark().props as { children: React.ReactNode }).children}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}
