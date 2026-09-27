// "用动画演示…" input + the browser half of generation (fetch → validate → one repair retry).
// Engine-agnostic.
import { useState } from "react";
import { PRESETS } from "./examples.ts";
import { validateScript, type AnimScript } from "./script.ts";

/** A request that should become an animation script rather than typed edits. */
export const ANIM_RE = /动画|animat/i;

export type GenResult = { script?: AnimScript; errors: string[]; meta: string; attempts: number };

/** Ask the model (POST /api/canvas/anim) for a script; one retry with the validation errors fed back. */
export async function generateScript(request: string): Promise<GenResult> {
  let errors: string[] = [];
  let cost = 0, ms = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch("/api/canvas/anim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, errors }),
    });
    const res = (await r.json()) as { raw: unknown; costUsd: number | null; durationMs: number; error?: string };
    cost += res.costUsd ?? 0;
    ms += res.durationMs ?? 0;
    const meta = `${(ms / 1000).toFixed(1)}s · $${cost.toFixed(4)}`;
    if (!r.ok || res.error) return { errors: [res.error ?? r.statusText], meta, attempts: attempt };
    const v = validateScript(res.raw);
    if (v.script) return { script: v.script, errors: [], meta, attempts: attempt };
    errors = v.errors;
    if (attempt === 2) return { errors, meta, attempts: attempt };
  }
  return { errors, meta: "", attempts: 2 };
}

export function AnimPrompt({ onScript, onClose, onRequest }: {
  onScript: (s: AnimScript, meta: string) => void;
  onClose: () => void;
  /** When set, generation is delegated (Agora: a session turn) instead of run here. */
  onRequest?: (text: string) => void;
}) {
  const [text, setText] = useState(PRESETS[0].request);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[]>([]);
  const run = async () => {
    if (!text.trim() || busy) return;
    if (onRequest) return onRequest(text.trim());
    setBusy(true);
    setErr([]);
    try {
      const r = await generateScript(text.trim());
      if (r.script) onScript(r.script, `Agent · ${r.meta}${r.attempts > 1 ? " · 修正 1 次" : ""}`);
      else setErr(r.errors.slice(0, 6));
    } catch (e) {
      setErr([String(e)]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="anim-prompt" role="dialog" aria-label="生成算法动画" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="anim-prompt-head">
        <b>算法动画</b>
        <span>Agent 生成动画脚本，校验后在画布上建区域并挂播放器</span>
      </div>
      <textarea
        autoFocus
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && run()}
        placeholder="用动画演示冒泡排序 [5,3,8,1,4]"
      />
      <div className="anim-chips">
        {PRESETS.map((p) => (
          <button key={p.label} className="anim-chip" onClick={() => setText(p.request)} title={p.request}>{p.label}</button>
        ))}
        <span className="anim-chip-sep" />
        {PRESETS.map((p) => (
          <button key={p.label} className="anim-chip ghost" onClick={() => onScript(p.offline(), "离线示例")} title="不调模型，直接载入手写脚本">
            {p.label}·示例
          </button>
        ))}
      </div>
      {err.length > 0 && <pre className="anim-err">脚本未通过校验，未上画布：{"\n"}{err.join("\n")}</pre>}
      <div className="anim-prompt-foot">
        <button className="anim-cancel" onClick={onClose}>取消</button>
        <button className="anim-go" onClick={run} disabled={busy}>{busy ? <span className="anim-shimmer">Agent 编排中…</span> : "生成 ⌘↵"}</button>
      </div>
    </div>
  );
}
