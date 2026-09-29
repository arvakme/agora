// Session composer: plain text plus a `#` picker that references canvas elements (current
// selection first, then by name); references are sent along as names and ids.
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import { toModelView } from "../canvas/modelView";
import type { Scene } from "../canvas/scene";
import type { Turn } from "./store";
import { canvases } from "./ui";
import { IconSend } from "../app/icons";
import { selectedIds, selectionElements, selectionLabel } from "./selection";
import { CHOICES, defaultChoice, whyNoSteer, type SendMode, type SendPlan } from "./steerModel";

type Option = { id: string; label: string; hint?: string };

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

export function Composer({ canvasId, canvasTitle, agentName, onSend, initial, working, plan, onStop }: {
  canvasId: string;
  canvasTitle?: string;
  agentName: string;
  onSend: (text: string, refs: Turn["refs"], mode?: SendMode) => Promise<void>;
  /** Text to start with (a summary of a lost session, to edit before sending). */
  initial?: string;
  /** The agent is in a turn, and 停止 interrupts it. */
  working?: boolean;
  /** What a message does now (./steerModel.ts): goes into the turn (steer), asks which of two ways (choose), or the ordinary send. */
  plan?: SendPlan;
  onStop?: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const [refs, setRefs] = useState<Turn["refs"]>([]);
  const [pick, setPick] = useState<{ q: string; start: number; i: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [way, setWay] = useState<"interrupt" | "wait">(defaultChoice());
  const ta = useRef<HTMLTextAreaElement>(null);
  const selApi = canvases.get(canvasId)?.api;
  const sel = selApi ? selectionElements(selApi.getSceneElements() as never, selectedIds(selApi)).length : 0; // what is sent: a box and its label count once
  const options = pick ? elementOptions(canvasId, pick.q) : [];

  const update = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)#([^\s#]*)$/.exec(value.slice(0, caret));
    setPick(m ? { q: m[2], start: caret - m[2].length - 1, i: 0 } : null);
  };
  const choose = (o: Option) => {
    if (!pick) return;
    const token = `#${o.label} `;
    const caret = ta.current?.selectionStart ?? text.length;
    setText(text.slice(0, pick.start) + token + text.slice(caret));
    setRefs((r) => (r.some((x) => x.id === o.id) ? r : [...r, { id: o.id, label: o.label }]));
    setPick(null);
    requestAnimationFrame(() => {
      const pos = pick.start + token.length;
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
  };
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const kept = refs.filter((r) => t.includes(`#${r.label}`));
    setErr(null);
    onSend(t, kept, plan?.kind === "choose" ? way : plan?.kind === "steer" ? "steer" : undefined).catch((e) => (setErr((e as Error).message), setText(t)));
    setText("");
    setRefs([]);
    setWay(defaultChoice());
  };

  return (
    <div className="sp-composer">
      <AnimatePresence>
        {pick && options.length > 0 && (
          <motion.ul className="menu sp-pick" role="listbox" initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }} transition={SPRING}>
            <li className="sp-pick-head">引用「{canvasTitle ?? "画布"}」里的元素</li>
            {options.map((o, i) => (
              <li key={o.id} role="option" aria-selected={i === pick.i} data-on={i === pick.i} onPointerDown={(e) => (e.preventDefault(), choose(o))}>
                <span>#{o.label}</span>
                {o.hint && <em>{o.hint}</em>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className="sp-composer-box">
        <textarea
          ref={ta}
          value={text}
          rows={2}
          placeholder={working ? (plan?.kind === "steer" ? `${agentName} 在干活，你的话会直接插进这一轮` : plan?.kind === "choose" ? `${agentName} 在干活，发出前选一下怎么说` : `${agentName} 在干活，新消息会排在这一轮之后`) : `给 ${agentName} 发消息…  # 引用画布元素`}
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
        <span className="sp-ctx">
          {sel > 0 && <span className="chip"><span>{selectionLabel(sel)}</span></span>}
          {refs.map((r) => <span key={r.id} className="chip"><span>#{r.label}</span></span>)}
        </span>
        {plan?.kind === "choose" && (
          <fieldset className="sp-ways" aria-label="这一轮还在跑，你的话怎么说">
            <legend>{whyNoSteer(agentName, plan.reason)}</legend>
            {CHOICES.map((c) => (
              <label key={c.mode}>
                <input type="radio" name="sp-way" checked={way === c.mode} onChange={() => setWay(c.mode)} />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}
        {err && <p className="sp-warn" role="alert">没有发出去：{err}</p>}
      </div>
      {working && onStop && (
        <button className="sp-stop" onClick={onStop} title="打断这一轮">
          <i aria-hidden />
          停止
        </button>
      )}
      <button className="send sp-send" onClick={send} disabled={!text.trim()} aria-label="发送"><IconSend size={14} /></button>
    </div>
  );
}
