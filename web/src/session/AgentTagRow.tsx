// The agent tags in the top bar (web/docs/workstation.md §3): one per top-level session — avatar, name, what it is
// doing, its sub-agents. Click: that session's tab (opened if it is not). Hover: the node it is at. What is shown
// and in what order is ./agentTags.ts; the workstation's own states (idle / working) are the camera's (isWorking).
import { useEffect, useRef, useState } from "react";
import { useTick } from "../workstation/clock";
import { canvasWhere, OUTSIDE, stateAt } from "../workstation/place";
import { RunAvatar } from "../workstation/RunAvatar";
import { useRuns } from "../workstation/runs/store";
import type { WorkRun } from "../workstation/runs/types";
import { agentTags, splitTags, tagLabel, TAG_STATE_NAME, type AgentTag } from "./agentTags";
import { waitLabel } from "./requestModel";
import { sessions } from "./store";
import { ui } from "./ui";
import "./agentTags.css";

const TAG_W = 150;
const MORE_W = 44;

/** The tag's state in words: a waiting one says for how long (「等你 3 分钟」). */
const stateText = (t: AgentTag, now: number) => (t.state === "waiting" ? (waitLabel(t.waitSince, now) ?? TAG_STATE_NAME.waiting) : TAG_STATE_NAME[t.state]);

/** 「在 <node>」: where the session's agent is on its canvas now, when the canvas's overlay has said. */
function whereIs(run: WorkRun, now: number): string | null {
  const canvasId = run.sessionId ? sessions.get().sessions[run.sessionId]?.canvasId : undefined;
  const w = canvasId ? canvasWhere.get(canvasId) : undefined;
  if (!w) return null;
  const at = stateAt(run, now, w.ctx).at;
  return at && at !== OUTSIDE ? w.label(at) : null;
}

export function AgentTags() {
  const runs = useRuns();
  const now = useTick(1000);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const tops = runs.roots.filter((r) => r.sessionId);
  const tags = agentTags(tops, now);
  if (!tags.length) return <div className="agent-tags" ref={box} />;
  const room = Math.max(2, Math.floor((width + MORE_W) / TAG_W)); // at least one tag beside 「+N」
  const { shown, more } = splitTags(tags, room);
  const byId = new Map(tops.map((r) => [r.id, r]));
  // several sessions of one agent: tell them apart by what they are about (the name is 「agent · topic」)
  const same = (t: AgentTag) => tags.filter((x) => x.agent === t.agent).length > 1;
  const label = (t: AgentTag) => tagLabel(t.name, same(t));
  const tag = (t: AgentTag, listed?: boolean) => {
    const run = byId.get(t.runId)!;
    const where = whereIs(run, now);
    const doing = run.segs.find((s) => s.start <= now && now < s.end)?.label;
    return (
      <button key={t.runId} className="agent-tag" data-state={t.state} data-listed={listed || undefined} onClick={() => (t.sessionId && ui.openSession(t.sessionId), setMenu(false))} title={`${t.name} · ${stateText(t, now)}${doing && t.state !== "idle" ? ` · ${doing}` : ""}${where ? `\n在 ${where}` : ""}${t.kids ? `\n${t.kids} 个子代理` : ""}`}>
        <RunAvatar agent={t.agent} size={18} />
        <span className="at-name">{label(t)}</span>
        <span className="at-state"><i className="at-dot" />{t.state !== "idle" && stateText(t, now)}</span>
        {t.kids > 0 && <span className="at-kids" aria-label={`${t.kids} 个子代理`}>+{t.kids}</span>}
      </button>
    );
  };
  return (
    <div className="agent-tags" ref={box} role="toolbar" aria-label="Agent">
      {shown.map((t) => tag(t))}
      {more.length > 0 && (
        <div className="at-more">
          <button className="agent-tag at-more-btn" aria-expanded={menu} onClick={() => setMenu((v) => !v)} title={more.map((t) => t.name).join("、")}>+{more.length}</button>
          {menu && <div className="menu at-menu">{more.map((t) => tag(t, true))}</div>}
        </div>
      )}
    </div>
  );
}
