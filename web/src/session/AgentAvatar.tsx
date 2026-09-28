// Every place that shows which agent a session is (agent picker, session header, tabs, 所有画布,
// pointer labels, trajectory rows, comment replies) goes through AgentAvatar: one disc on the
// theme's avatar tile (--avatar-tile + hairline), with the agent's own mark on it — vector for
// Pi and Claude Code, a 64/128px raster pair for Codex — so it stays sharp at 16–40px on 2x/3x
// screens and reads in both themes. Marks and sources: ../app/agents/marks.tsx.
import { ClaudeMark, CodexMark, PiMark } from "../app/agents/marks";
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
      {kind === "pi" ? <PiMark /> : kind === "claude" ? <ClaudeMark /> : kind === "codex" ? <CodexMark px={size} /> : <InitialMark kind={kind} />}
    </span>
  );
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
