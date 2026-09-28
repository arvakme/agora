// The three agents' own marks (bundled with the app, never loaded from the network), so a
// session, tab, pointer label or trajectory row says at a glance which CLI it is.
// Sources and trademark note: README「许可与致谢」.
import claudeCode from "../app/agents/claude-code.svg";
import codex from "../app/agents/codex.png";
import pi from "../app/agents/pi.png";
import { AGENT_NAMES, useAgents, type AgentKind } from "./agents";

export const AGENT_AVATARS: Record<AgentKind, string> = { pi, claude: claudeCode, codex };

/** 26px by default (design system §9 avatar); `sm` 20px, `xs` 16px for tabs and inline rows. */
export function AgentAvatar({ kind, size, label }: { kind: AgentKind; size?: "sm" | "xs"; label?: boolean }) {
  const px = size === "xs" ? 16 : size === "sm" ? 20 : 26;
  return (
    <img
      className="avatar agent-avatar"
      data-size={size}
      data-agent={kind}
      src={AGENT_AVATARS[kind]}
      width={px}
      height={px}
      alt={label ? AGENT_NAMES[kind] : ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      decoding="async"
    />
  );
}

/** A session tab's mark: its agent once bound, the plain tab dot before that. */
export function SessionMark({ sessionId }: { sessionId: string }) {
  const kind = useAgents().bindings[sessionId]?.agent;
  return kind ? <AgentAvatar kind={kind} size="xs" label /> : <span className="wm-tab-dot" />;
}
