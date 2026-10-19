// The session panel's form, chosen in the top bar's ⋯ and in the panel's own ⋯ (web/docs/workstation.md §15): docked (the right column), a card at the right, or a bar along the bottom.
// One preference for the browser (prefs.ts `floatSession`); the panel is the same instance in all three, so changing it loses nothing.
import type { FloatPref } from "./floatShell";
import { useNarrow } from "../workspace/narrow";
import { prefs, usePrefs } from "./prefs";

const FORMS: [FloatPref, string, string][] = [
  ["dock", "停靠", "右边一栏，画布变窄"],
  ["card", "右侧卡片", "浮在画布右边，可以拖、可以拉大小，收起成右边缘的竖标签"],
  ["bar", "底部条", "「浏览 / 评论」上面一条：状态 + 输入框，可以上拉成半屏，收起成工具条旁边的药丸"],
];

/** A phone has no room for a column or a card (workspace/narrow.ts): the session is a tab beside the canvas, or a bar under it. */
const PHONE_FORMS: [FloatPref, string, string][] = [
  ["dock", "标签", "画布和会话是两个标签，点标签切换"],
  ["bar", "底部条", "画布在上，会话收成下面一条（状态 + 输入框），点右边的箭头拉起来"],
];

export function FloatChoice() {
  const { floatSession } = usePrefs();
  const narrow = useNarrow();
  const forms = narrow ? PHONE_FORMS : FORMS;
  const chosen = narrow && floatSession === "card" ? "dock" : floatSession; // a card is a tab on a phone
  return (
    <div className="seg vm-seg float-choice" role="radiogroup" aria-label="会话面板的形态">
      {forms.map(([k, label, tip]) => (
        <button key={k} role="radio" aria-checked={chosen === k} data-on={chosen === k} title={narrow ? `${tip}。只影响这个浏览器` : `${tip}。窗口窄于 1100 或矮于 640 时仍停靠。只影响这个浏览器`} onClick={() => prefs.set({ floatSession: k })}>
          {label}
        </button>
      ))}
    </div>
  );
}
