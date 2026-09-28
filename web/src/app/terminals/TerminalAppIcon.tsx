// Kitty's and Seedmux's own app icons for「在 Kitty / Seedmux 中打开」, taken from the installed app
// bundles (kitty.app/Contents/Resources/kitty.icns, Seedmux.app/Contents/Resources/AppIcon.icns)
// as their 32px and 64px renditions. Trademark note: README「许可与致谢」.
import kitty32 from "./kitty-32.png";
import kitty64 from "./kitty-64.png";
import seedmux32 from "./seedmux-32.png";
import seedmux64 from "./seedmux-64.png";

const SRC = { kitty: [kitty32, kitty64], seedmux: [seedmux32, seedmux64] } as const;

export function TerminalAppIcon({ app, size = 16 }: { app: "kitty" | "seedmux"; size?: number }) {
  const [a, b] = SRC[app];
  return <img className="term-app-icon" src={b} srcSet={`${a} 32w, ${b} 64w`} sizes={`${size}px`} width={size} height={size} alt="" draggable={false} decoding="async" />;
}
