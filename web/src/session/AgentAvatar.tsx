// Every place that shows which agent a session is (agent picker, session header, tabs, 所有画布,
// pointer labels, trajectory rows, comment replies) goes through AgentAvatar: one disc on the
// theme's avatar tile (--avatar-tile + hairline), with the agent's own mark on it — vector for
// Pi, Claude Code, Cursor and Devin, a 64/128px raster pair for Codex and Grok — so it stays sharp at 16–40px on 2x/3x
// screens and reads in both themes. Marks and sources: ../app/agents/marks.tsx.
import { ClaudeMark, CodexMark, CursorMark, DevinMark, GrokMark, PiMark } from "../app/agents/marks";
import { markFor } from "./agentMarks";
import { agentName, useAgents, type AgentKind } from "./agents";

/** 16 tabs / inline rows · 20 compact lists · 26 beside people's avatars in threads · 32 session header · 40 agent picker. */
export type AvatarSize = 16 | 20 | 26 | 32 | 40;

export function AgentAvatar({ kind, size = 32, label }: { kind: AgentKind; size?: AvatarSize; label?: boolean }) {
  return (
    <span
      className="agent-avatar"
      data-agent={kind}
      style={{ "--av": `${size}px` } as React.CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label ? agentName(kind) : undefined}
      aria-hidden={label ? undefined : true}
    >
      <Mark kind={kind} size={size} />
    </span>
  );
}

function Mark({ kind, size }: { kind: AgentKind; size: number }) {
  switch (markFor(kind)) {
    case "pi": return <PiMark />;
    case "claude": return <ClaudeMark />;
    case "codex": return <CodexMark px={size} />;
    case "grok": return <GrokMark px={size} />;
    case "cursor": return <CursorMark />;
    case "devin": return <DevinMark />;
    default: return <InitialMark kind={kind} />;
  }
}

/** A CLI without a drawn mark yet (an observed agent from the adapter registry): its initial. */
function InitialMark({ kind }: { kind: AgentKind }) {
  return <b className="agent-initial">{agentName(kind).slice(0, 1).toUpperCase()}</b>;
}

/** A session tab's mark: its agent once bound (or the agent its entry records, for a session made elsewhere), the plain tab dot before that (a draft). */
export function SessionMark({ sessionId, fallback }: { sessionId: string; fallback?: AgentKind }) {
  const kind = useAgents().bindings[sessionId]?.agent ?? fallback;
  return kind ? <AgentAvatar kind={kind} size={16} label /> : <span className="wm-tab-dot" />;
}
