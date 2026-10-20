// The buttons in a selected figure's bubble: 打开会话 (only an agent with a session of its own). Following is not one: clicking the bubble
// selects it and has the camera follow it. The route is not one either: it belongs to a played turn (▶ 回放这一轮, ./replayMode.ts)
// and is closed from the bar above the canvas.
import { tr } from "../i18n";
export const bubbleActions = (hasSession: boolean): string[] => (hasSession ? [tr("打开会话", "Open session")] : []);
