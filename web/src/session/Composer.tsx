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
import { tr } from "../i18n";

type Option = { id: string; label: string; hint?: string };

function elementOptions(canvasId: string, q: string): Option[] {
  const c = canvases.get(canvasId);
  if (!c) return [];
  const view = toModelView(c.api.getSceneElementsIncludingDeleted() as Scene);
  const sel = new Set(Object.keys(c.api.getAppState().selectedElementIds));
  const opts: Option[] = [
    ...view.nodes.map((n) => ({ id: n.id, label: n.label || n.id, hint: n.type === "library" ? tr(`素材 · ${n.component}`, `Library · ${n.component}`) : n.type })),
    ...view.arrows.filter((a) => a.label).map((a) => ({ id: a.id, label: a.label!, hint: tr("箭头", "arrow") })),
    ...view.frames.map((f) => ({ id: f.id, label: f.name, hint: tr("分组", "group") })),
  ];
  const needle = q.toLowerCase();
  return opts
    .filter((o) => !needle || o.label.toLowerCase().includes(needle) || o.id.includes(needle))
    .map((o) => (sel.has(o.id) ? { ...o, hint: tr(`选区 · ${o.hint}`, `Selection · ${o.hint}`) } : o))
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
            <li className="sp-pick-head">{canvasTitle ? tr(`引用「${canvasTitle}」里的元素`, `Reference elements in “${canvasTitle}”`) : tr("引用「画布」里的元素", "Reference canvas elements")}</li>
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
          placeholder={working ? (plan?.kind === "steer" ? tr(`${agentName} 在干活，你的话会直接插进这一轮`, `${agentName} is working; your message goes straight into this turn`) : plan?.kind === "choose" ? tr(`${agentName} 在干活，发出前选一下怎么说`, `${agentName} is working; choose how to send before you send`) : tr(`${agentName} 在干活，新消息会排在这一轮之后`, `${agentName} is working; new messages queue after this turn`)) : tr(`给 ${agentName} 发消息…  # 引用画布元素`, `Message ${agentName}…  # to reference canvas elements`)}
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
          <fieldset className="sp-ways" aria-label={tr("这一轮还在跑，你的话怎么说", "This turn is still running: how should your message go?")}>
            <legend>{whyNoSteer(agentName, plan.reason)}</legend>
            {CHOICES.map((c) => (
              <label key={c.mode}>
                <input type="radio" name="sp-way" checked={way === c.mode} onChange={() => setWay(c.mode)} />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}
        {err && <p className="sp-warn" role="alert">{tr("没有发出去：", "Not sent: ")}{err}</p>}
      </div>
      {working && onStop && (
        <button className="sp-stop" onClick={onStop} title={tr("打断这一轮", "Interrupt this turn")}>
          <i aria-hidden />
          {tr("停止", "Stop")}
        </button>
      )}
      <button className="send sp-send" onClick={send} disabled={!text.trim()} aria-label={tr("发送", "Send")}><IconSend size={14} /></button>
    </div>
  );
}
