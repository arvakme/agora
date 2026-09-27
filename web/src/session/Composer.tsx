// Session composer: plain text plus two pickers.
//   #  reference a canvas element (current selection first, then by name) → sent as anchors
//   @  mention an agent; workers are UI + data only this round ("未接入", Seedmux later)
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import { toModelView } from "../canvas/modelView";
import type { Scene } from "../canvas/scene";
import { AGENT_LIST } from "./SessionPane";
import type { Turn } from "./store";
import { canvases } from "./ui";

type Option = { id: string; label: string; hint?: string; disabled?: boolean };

function elementOptions(canvasId: string, q: string): Option[] {
  const c = canvases.get(canvasId);
  if (!c) return [];
  const view = toModelView(c.api.getSceneElementsIncludingDeleted() as Scene);
  const sel = new Set(Object.keys(c.api.getAppState().selectedElementIds));
  const opts: Option[] = [
    ...view.nodes.map((n) => ({ id: n.id, label: n.label || n.id, hint: n.type === "library" ? `素材 · ${n.component}` : n.type })),
    ...view.arrows.filter((a) => a.label).map((a) => ({ id: a.id, label: a.label!, hint: "箭头" })),
    ...view.frames.map((f) => ({ id: f.id, label: f.name, hint: "分组" })),
  ];
  const needle = q.toLowerCase();
  return opts
    .filter((o) => !needle || o.label.toLowerCase().includes(needle) || o.id.includes(needle))
    .map((o) => (sel.has(o.id) ? { ...o, hint: `选区 · ${o.hint}` } : o))
    .sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)))
    .slice(0, 8);
}

export function Composer({ canvasId, canvasTitle, busy, onSend }: {
  canvasId: string;
  canvasTitle?: string;
  busy: boolean;
  onSend: (text: string, refs: Turn["refs"], mentions: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<Turn["refs"]>([]);
  const [mentions, setMentions] = useState<string[]>([]);
  const [pick, setPick] = useState<{ kind: "#" | "@"; q: string; start: number; i: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const sel = Object.keys(canvases.get(canvasId)?.api.getAppState().selectedElementIds ?? {}).length;

  const options: Option[] = !pick
    ? []
    : pick.kind === "#"
      ? elementOptions(canvasId, pick.q)
      : AGENT_LIST.filter((a) => a.name.toLowerCase().includes(pick.q.toLowerCase()) || a.id.includes(pick.q.toLowerCase())).map((a) => ({
          id: a.id,
          label: a.name,
          hint: a.live ? "主控" : "未接入 · 将来经 Seedmux 派发",
        }));

  const update = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)([#@])([^\s#@]*)$/.exec(value.slice(0, caret));
    setPick(m ? { kind: m[2] as "#" | "@", q: m[3], start: caret - m[3].length - 1, i: 0 } : null);
  };
  const choose = (o: Option) => {
    if (!pick) return;
    const token = `${pick.kind}${o.label} `;
    const caret = ta.current?.selectionStart ?? text.length;
    const next = text.slice(0, pick.start) + token + text.slice(caret);
    setText(next);
    if (pick.kind === "#") setRefs((r) => (r.some((x) => x.id === o.id) ? r : [...r, { id: o.id, label: o.label }]));
    else setMentions((m) => (m.includes(o.id) ? m : [...m, o.id]));
    setPick(null);
    requestAnimationFrame(() => {
      const pos = pick.start + token.length;
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
  };
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    // Keep only references whose token is still in the text.
    const keptRefs = refs.filter((r) => t.includes(`#${r.label}`));
    const keptMentions = mentions.filter((m) => t.includes(`@${AGENT_LIST.find((a) => a.id === m)?.name}`));
    onSend(t, keptRefs, keptMentions);
    setText("");
    setRefs([]);
    setMentions([]);
  };

  return (
    <div className="d-composer sp-composer" data-busy={busy}>
      <AnimatePresence>
        {pick && options.length > 0 && (
          <motion.ul className="sp-pick" role="listbox" initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }} transition={SPRING}>
            <li className="sp-pick-head">{pick.kind === "#" ? `引用「${canvasTitle ?? "画布"}」里的元素` : "点名 agent"}</li>
            {options.map((o, i) => (
              <li key={o.id} role="option" aria-selected={i === pick.i} data-on={i === pick.i} onPointerDown={(e) => (e.preventDefault(), choose(o))}>
                <span>{pick.kind}{o.label}</span>
                {o.hint && <em data-off={pick.kind === "@" && o.id !== "pi"}>{o.hint}</em>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className="d-composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={2}
          placeholder={busy ? "Pi Master 正在处理上一轮…" : "给 Pi Master 发消息… # 引用画布元素 · @ 点名 worker"}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (pick && options.length) {
              if (e.key === "ArrowDown") return void (e.preventDefault(), setPick({ ...pick, i: (pick.i + 1) % options.length }));
              if (e.key === "ArrowUp") return void (e.preventDefault(), setPick({ ...pick, i: (pick.i - 1 + options.length) % options.length }));
              if (e.key === "Enter" || e.key === "Tab") return void (e.preventDefault(), choose(options[pick.i]));
              if (e.key === "Escape") return void setPick(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send());
          }}
        />
        <span className="d-composer-ctx">
          <span className="d-ctx-chip">画布 · {canvasTitle ?? "已关闭"}</span>
          {sel > 0 && <span className="d-ctx-chip">选区 · {sel} 个元素</span>}
          {refs.map((r) => <span key={r.id} className="d-ctx-chip ref">#{r.label}</span>)}
          {mentions.map((m) => <span key={m} className="d-ctx-chip mention">@{AGENT_LIST.find((a) => a.id === m)?.name}</span>)}
        </span>
      </div>
      <button className="d-send" onClick={send} disabled={!text.trim() || busy} aria-label="发送">↑</button>
    </div>
  );
}
