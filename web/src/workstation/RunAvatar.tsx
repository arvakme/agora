// An agent run's avatar: the six known agents through AgentAvatar, any other CLI (or a worker
// known only by its receipts) as a letter on the same tile. Also the SVG symbols the figures'
// heads use (<WorkerDefs/>, mounted once by the app shell).
import { ClaudeMark, PiMark } from "../app/agents/marks";
import { AgentAvatar, type AvatarSize } from "../session/AgentAvatar";
import { hasOwnMark } from "../session/agentMarks";
import type { AgentKind } from "../session/agents";

export function RunAvatar({ agent, size = 16, parent }: { agent: string; size?: AvatarSize | 14 | 18 | 22; parent?: string }) {
  const s = size as AvatarSize;
  const face = hasOwnMark(agent) ? (
    <AgentAvatar kind={agent as AgentKind} size={s} />
  ) : (
    <span className="agent-avatar run-letter" style={{ "--av": `${size}px` } as React.CSSProperties} aria-hidden>
      {agent === "worker" ? "W" : (agent[0] ?? "?").toUpperCase()}
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

/** Symbols for the figures' heads (ids ws-m-pi, ws-m-claude). */
export function WorkerDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <defs>
        <symbol id="ws-m-pi" viewBox="0 0 560 560">
          <PiMarkPath />
        </symbol>
        <symbol id="ws-m-claude" viewBox="0.17 1.1 25 25">
          <ClaudePath />
        </symbol>
      </defs>
    </svg>
  );
}

// The marks' paths, lifted out of their <svg> wrappers so they can live in <symbol>s.
function PiMarkPath() {
  const svg = PiMark();
  return <>{(svg.props as { children: React.ReactNode }).children}</>;
}
function ClaudePath() {
  const svg = ClaudeMark();
  return <>{(svg.props as { children: React.ReactNode }).children}</>;
}
