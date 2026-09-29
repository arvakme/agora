// The buttons in a selected figure's bubble: 打开会话 (only an agent with a session of its own) and 跟随. The route is not one:
// it belongs to a played turn (▶ 回放这一轮, ./replayMode.ts) and is closed from the bar above the canvas.
export const bubbleActions = (hasSession: boolean): string[] => (hasSession ? ["打开会话", "跟随"] : ["跟随"]);
