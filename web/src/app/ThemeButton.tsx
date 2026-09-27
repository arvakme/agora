import { IconAuto, IconMoon, IconSun } from "./icons";
import { theme, THEME_LABEL, useTheme } from "./theme";

/** Light / dark / follow the system: one icon button that cycles, the current choice in its label. */
export function ThemeButton() {
  const t = useTheme();
  const Icon = t.pref === "system" ? IconAuto : t.pref === "light" ? IconSun : IconMoon;
  const next = t.pref === "system" ? "light" : t.pref === "light" ? "dark" : "system";
  return (
    <button className="icon-btn theme-btn" onClick={theme.cycle} aria-label={`主题：${THEME_LABEL[t.pref]}，点击切换为${THEME_LABEL[next]}`} title={`主题：${THEME_LABEL[t.pref]}（点击切换为${THEME_LABEL[next]}）`}>
      <Icon size={16} />
    </button>
  );
}
