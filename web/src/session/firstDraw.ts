// The first screen of a new project: an empty canvas named after the project, and one main button in the new
// session's chooser — 「画出这个项目的架构」 — that starts the recommended agent with the prompt below. The example
// canvas is one quiet click away (「看一个示例」). Words live here, in one place.

/** What the agent is asked when the button is pressed. Edit the wording here; nothing else depends on it. */
export const ARCHITECTURE_PROMPT =
  "看一下这个项目（目录结构、README、入口和主要代码），把它的整体架构画到这张图上：主要的模块和它们之间的调用、数据关系，上游在上、下游在下。" +
  "主要的子系统各做成一张子图（在对应节点上开子画布），子图里同样上游在上、下游在下。节点名用项目里真实的名字，不要编。" +
  "画完用两三句话说明画了什么。";

/** What the button does: the recommended agent (session/recommend.ts) and the prompt. */
export const drawPlan = (recommended: string): { kind: string; prompt: string } => ({ kind: recommended, prompt: ARCHITECTURE_PROMPT });

/** On the empty canvas: one sentence, pointing at the same button (not a second way). */
export const EMPTY_HINT = "这张图还是空的：让 agent 画出这个项目的架构（会话里的「画出这个项目的架构」），或者自己动手画。";

/** On the empty canvas while an agent is at work (FX2a): what is going on, in plain words — its figure is outside the picture, and the camera is with it. */
export const busyHint = (agent: string): string => `${agent} 正在看代码、准备画图——小人在图外，镜头跟着它；画出来的东西会一件件出现在这里。`;

/** 「看一个示例」 asks the app to open the sample as another canvas (the current one is not touched). */
const listeners = new Set<() => void>();
export const sampleRequests = {
  request: () => listeners.forEach((f) => f()),
  subscribe: (f: () => void) => (listeners.add(f), () => void listeners.delete(f)),
};

/** Nothing drawn (deleted elements do not count): the state in which the button and the hint are offered. */
export const isEmptyCanvas = (elements: readonly { isDeleted?: boolean }[] | undefined): boolean => !elements || elements.every((e) => e.isDeleted);
