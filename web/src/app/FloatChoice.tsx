// The session panel's form, chosen in the top bar's ⋯ and in the panel's own ⋯ (web/docs/workstation.md §15): docked (the right column), a card at the right, or a bar along the bottom.
// One preference for the browser (prefs.ts `floatSession`); the panel is the same instance in all three, so changing it loses nothing.
import type { FloatPref } from "./floatShell";
import { useNarrow } from "../workspace/narrow";
import { prefs, usePrefs } from "./prefs";
import { tr } from "../i18n";

const FORMS: [FloatPref, string, string][] = [
  ["dock", tr("停靠", "Docked"), tr("右边一栏，画布变窄", "A column on the right; the canvas gets narrower")],
  ["card", tr("右侧卡片", "Card"), tr("浮在画布右边，可以拖、可以拉大小，收起成右边缘的竖标签", "Floats at the canvas's right; drag or resize it, and it folds into a vertical tab on the right edge")],
  ["bar", tr("底部条", "Bottom bar"), tr("「浏览 / 评论」上面一条：状态 + 输入框，可以上拉成半屏，收起成工具条旁边的药丸", "A strip above Browse / Comment: status + input; pull it up to half the screen, or fold it into a pill beside the toolbar")],
];

/** A phone has no room for a column or a card (workspace/narrow.ts): the session is a tab beside the canvas, or a bar under it. */
const PHONE_FORMS: [FloatPref, string, string][] = [
  ["dock", tr("标签", "Tabs"), tr("画布和会话是两个标签，点标签切换", "Canvas and session are two tabs; tap a tab to switch")],
  ["bar", tr("底部条", "Bottom bar"), tr("画布在上，会话收成下面一条（状态 + 输入框），点右边的箭头拉起来", "Canvas on top, the session folded into a strip below (status + input); tap the arrow on the right to pull it up")],
];

export function FloatChoice() {
  const { floatSession } = usePrefs();
  const narrow = useNarrow();
  const forms = narrow ? PHONE_FORMS : FORMS;
  const chosen = narrow && floatSession === "card" ? "dock" : floatSession; // a card is a tab on a phone
  return (
    <div className="seg vm-seg float-choice" role="radiogroup" aria-label={tr("会话面板的形态", "Session panel form")}>
      {forms.map(([k, label, tip]) => (
        <button key={k} role="radio" aria-checked={chosen === k} data-on={chosen === k} title={narrow ? tr(`${tip}。只影响这个浏览器`, `${tip}. This browser only`) : tr(`${tip}。窗口窄于 1100 或矮于 640 时仍停靠。只影响这个浏览器`, `${tip}. Still docked when the window is narrower than 1100 or shorter than 640. This browser only`)} onClick={() => prefs.set({ floatSession: k })}>
          {label}
        </button>
      ))}
    </div>
  );
}
