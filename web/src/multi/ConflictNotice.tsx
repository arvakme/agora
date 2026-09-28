// In a session pane: "Codex 在 3 分钟内也改了 server/app.py" — another session wrote the same
// file (or the same node) close to this one (docs/multi-agent.md §3). A notice, never a block.
import { useMemo, useState } from "react";
import { IconClose } from "../app/icons";
import { AgentAvatar } from "../session/AgentAvatar";
import { useAgents, type AgentKind } from "../session/agents";
import { sessions } from "../session/store";
import { ui } from "../session/ui";
import { ancestry, effectiveLinks } from "../nested/graph";
import { useNested } from "../nested/store";
import { clashText, useSessionLabel } from "../pointer/PointerLayer";
import { conflicts, conflictsOf } from "./pointers";
import { useSessionFolds } from "./writes";
import "./multi.css";

export function ConflictNotice({ sessionId }: { sessionId: string }) {
  const folds = useSessionFolds();
  const st = useNested();
  const ag = useAgents();
  const label = useSessionLabel();
  const [hidden, setHidden] = useState<string>("");
  const canvasId = sessions.get().sessions[sessionId]?.canvasId ?? "";
  const root = ancestry(canvasId, st.index)[0];
  const links = useMemo(() => effectiveLinks(root, st.scenes), [root, st.scenes]);
  const mine = useMemo(() => conflictsOf(conflicts(folds, links, { now: Date.now() }), sessionId), [folds, links, sessionId]);
  const key = mine.map((c) => `${c.kind}${c.path ?? c.element}${c.at}`).join("|");
  if (!mine.length || hidden === key) return null;
  const c = mine[0];
  const other = c.sessions.find((s) => s !== sessionId)!;
  const kind = ag.bindings[other]?.agent as AgentKind | undefined;
  return (
    <div className="notice sp-clash" role="status" data-tone="caution">
      <span className="nest-dot" aria-hidden />
      <span>
        可能冲突：{clashText(c, label)}
        {mine.length > 1 ? `（另有 ${mine.length - 1} 处）` : ""}
      </span>
      <button className="btn sm quiet" onClick={() => ui.openSession(other)}>
        {kind && <AgentAvatar kind={kind} size={16} />}看 {label(other, c.sessions)}
      </button>
      <button className="icon-btn sm muted" aria-label="知道了" title="知道了（有新的冲突会再提示）" onClick={() => setHidden(key)}>
        <IconClose size={14} />
      </button>
    </div>
  );
}
