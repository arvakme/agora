// Kitty's own app icon for「在 Kitty 中打开」, taken from the installed app bundle
// (kitty.app/Contents/Resources/kitty.icns) as its 32px and 64px renditions. Trademark note: README「许可与致谢」.
import kitty32 from "./kitty-32.png";
import kitty64 from "./kitty-64.png";

export function TerminalAppIcon({ size = 16 }: { size?: number }) {
  return <img className="term-app-icon" src={kitty64} srcSet={`${kitty32} 32w, ${kitty64} 64w`} sizes={`${size}px`} width={size} height={size} alt="" draggable={false} decoding="async" />;
}
