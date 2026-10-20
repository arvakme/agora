// The share list's note for a share whose guests may watch how the canvas was built (SharePanel.tsx). Pure.
import { tr } from "../i18n";
export const replayText = (r: { buildReplay?: boolean }) => (r.buildReplay ? tr("访客可看搭建过程", "Guests can watch the build") : "");
